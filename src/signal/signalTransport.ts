import { createClient } from "@supabase/supabase-js";

import { RESOURCE_NAMES, SIGNAL_POLICY } from "@/src/config/policy";
import { PUBLIC_SIGNAL_CONFIG } from "@/src/config/publicRuntime";
import {
  diagnosticErrorDetails,
  sanitizeDiagnosticText,
  type ConnectionDiagnosticEvent,
  type ConnectionDiagnosticSink,
} from "@/src/diagnostics/connectionDiagnostics";
import {
  isLegacySignalMessage,
  isSignalMessage,
  type SignalMessage,
} from "@/src/signal/types";
import { shortId } from "@/src/utils/format";

type SignalTransportOptions = {
  roomId: string;
  onMessage: (message: SignalMessage) => void;
  onStatus: (status: "subscribed" | "unavailable") => void;
  onDiagnostic: ConnectionDiagnosticSink;
};

const SIGNAL_STAGES = { hello: "hello", offer: "sdp", answer: "sdp", candidate: "ice", rejected: "signal" } as const;

function signalTrace(type: SignalMessage["type"]) {
  const stage = SIGNAL_STAGES[type];
  return { stage, code: type === "hello" ? "hello" : `${stage}.${type}` } as const;
}

function signalDiagnostic(
  message: SignalMessage,
  direction: "sent" | "received",
  local = false,
): ConnectionDiagnosticEvent {
  const { stage, code } = signalTrace(message.type);
  const dedupe = message.type === "hello" || message.type === "candidate";
  return {
    stage,
    code: `${code}.${direction}`,
    level: direction === "sent" && message.type === "hello" ? "success" : "info",
    message: `${local ? "本地" : ""}${direction === "sent" ? "发送" : "收到"} ${message.type} 信令`,
    details: {
      hasTarget: "to" in message && Boolean(message.to),
      restart: message.type === "hello" ? message.restart : undefined,
      localEpoch: message.fromEpoch,
      remoteEpoch: "toEpoch" in message ? message.toEpoch : undefined,
      negotiation: "negotiationId" in message ? shortId(message.negotiationId) : undefined,
    },
    dedupeKey: dedupe ? `${local ? "local-" : ""}${message.type}-${direction}` : undefined,
  };
}

function safeRealtimeMessage(kind: string, message: string) {
  const lower = message.toLowerCase();
  if (lower.includes("websocket connection failed")) return "WebSocket connection failed";
  if (lower.includes("transport failure")) return "Realtime transport failure";
  if (lower.includes("heartbeat timeout")) return "Realtime heartbeat timeout";
  if (lower.startsWith("connected to")) return "WebSocket transport connected";
  if (lower === "close" || lower.includes("transport close")) return "WebSocket transport closed";
  if (lower === "error" || lower.includes("transport error")) return "WebSocket transport error";
  return sanitizeDiagnosticText(`${kind}: ${message}`);
}

export function createSignalTransport({
  roomId,
  onMessage,
  onStatus,
  onDiagnostic,
}: SignalTransportOptions) {
  const receive = (value: unknown, local = false) => {
    if (!isSignalMessage(value)) {
      const legacy = isLegacySignalMessage(value);
      onDiagnostic({
        stage: "signal",
        code: legacy ? "signal.protocol.legacy" : "signal.message.invalid",
        level: legacy ? "error" : "warn",
        message: legacy
          ? local ? "检测到旧版本地信令，请刷新所有同房间页面" : "检测到旧版信令，请让双方刷新页面后重试"
          : local ? "忽略了一条格式无效的本地信令消息" : "忽略了一条格式无效的信令消息",
        dedupeKey: legacy ? `${local ? "legacy-local" : "legacy"}-signal` : `${local ? "invalid-local" : "invalid"}-signal`,
      });
      if (legacy) onStatus("unavailable");
      return;
    }
    onDiagnostic(signalDiagnostic(value, "received", local));
    onMessage(value);
  };

  if (PUBLIC_SIGNAL_CONFIG.enabled) {
    const { url, key } = PUBLIC_SIGNAL_CONFIG;
    let disposed = false;
    let firstHealthyHeartbeatSeen = false;
    const signalStartedAt = Date.now();
    const providerHost = (() => {
      try {
        return new URL(url).host;
      } catch {
        return "invalid-host";
      }
    })();
    onDiagnostic({
      stage: "signal",
      code: "signal.transport.created",
      message: "已创建 Supabase Realtime 信令传输",
      details: { provider: "supabase", providerHost },
    });
    const client = createClient(url, key, {
      auth: { persistSession: false },
      realtime: {
        // Keep heartbeats out of the throttled main thread when the chat tab is in the background.
        worker: true,
        heartbeatCallback(status, latency) {
          if (status === "ok" && !firstHealthyHeartbeatSeen) {
            firstHealthyHeartbeatSeen = true;
            onDiagnostic({
              stage: "signal",
              code: "signal.heartbeat.ok",
              level: "success",
              message: "Realtime 首次心跳响应正常",
              details: { latencyMs: latency },
            });
          }
          if (!disposed && (status === "error" || status === "timeout")) {
            onDiagnostic({
              stage: "signal",
              code: `signal.heartbeat.${status}`,
              level: "error",
              message: status === "timeout" ? "Realtime 心跳超时" : "Realtime 心跳失败",
              details: { latencyMs: latency },
            });
            onStatus("unavailable");
          }
        },
        logger(kind, message) {
          if (disposed) return;
          if (kind !== "transport" && kind !== "error") return;
          const safeMessage = safeRealtimeMessage(kind, message);
          const failed = /failed|failure|error|timeout|closed/i.test(safeMessage);
          onDiagnostic({
            stage: "signal",
            code: failed ? "signal.transport.error" : "signal.transport.event",
            level: failed ? "error" : "info",
            message: safeMessage,
            dedupeKey: `realtime-${kind}-${safeMessage}`,
          });
        },
      },
    });
    const channel = client.channel(`${RESOURCE_NAMES.roomPrefix}${roomId}`, {
      config: { broadcast: { ack: true } },
    });
    channel.on("broadcast", { event: SIGNAL_POLICY.realtimeEvent }, ({ payload }) => receive(payload));

    return {
      start() {
        onDiagnostic({
          stage: "signal",
          code: "signal.subscribe.start",
          message: "开始订阅 Supabase Realtime 房间",
        });
        channel.subscribe((status, error) => {
          if (disposed) return;
          if (status === "SUBSCRIBED") {
            onDiagnostic({
              stage: "signal",
              code: "signal.subscribed",
              level: "success",
              message: "Supabase Realtime 信令已订阅",
              details: { durationMs: Date.now() - signalStartedAt },
            });
            onStatus("subscribed");
          }
          if (
            status === "CHANNEL_ERROR"
            || status === "TIMED_OUT"
            || (status === "CLOSED" && !disposed)
          ) {
            onDiagnostic({
              stage: "signal",
              code: `signal.${status.toLowerCase()}`,
              level: "error",
              message: `Supabase Realtime 状态异常：${status}`,
              details: {
                durationMs: Date.now() - signalStartedAt,
                ...(error ? diagnosticErrorDetails(error) : {}),
              },
            });
            onStatus("unavailable");
          }
        });
      },
      send(message: SignalMessage) {
        const { stage, code } = signalTrace(message.type);
        const sentAt = Date.now();
        onDiagnostic(signalDiagnostic(message, "sent"));
        void channel
          .send({ type: "broadcast", event: SIGNAL_POLICY.realtimeEvent, payload: message })
          .then((result) => {
            onDiagnostic({
              stage,
              code: `${code}.ack`,
              level: result === "ok" ? "success" : "error",
              message: `${message.type} 信令确认结果：${result}`,
              details: { durationMs: Date.now() - sentAt },
              dedupeKey: message.type === "hello" || message.type === "candidate"
                ? `${message.type}-ack-${result}`
                : undefined,
            });
            if (!disposed && result !== "ok") {
              onStatus("unavailable");
            }
          })
          .catch((error: unknown) => {
            if (!disposed) {
              onDiagnostic({
                stage,
                code: `${code}.failed`,
                level: "error",
                message: `${message.type} 信令发送失败`,
                details: { durationMs: Date.now() - sentAt, ...diagnosticErrorDetails(error) },
              });
              onStatus("unavailable");
            }
          });
      },
      dispose() {
        disposed = true;
        onDiagnostic({
          stage: "signal",
          code: "signal.transport.dispose",
          message: "释放 Supabase Realtime 信令传输",
        });
        void client.removeChannel(channel);
      },
    };
  }

  const channel = new BroadcastChannel(`${RESOURCE_NAMES.localSignalPrefix}${roomId}`);
  channel.onmessage = (event: MessageEvent<unknown>) => receive(event.data, true);
  onDiagnostic({
    stage: "signal",
    code: "signal.transport.created",
    level: "warn",
    message: "未配置 Supabase，正在使用同浏览器 BroadcastChannel 信令",
    details: { provider: "broadcast-channel" },
  });

  return {
    start() {
      onDiagnostic({
        stage: "signal",
        code: "signal.subscribed",
        level: "success",
        message: "本地 BroadcastChannel 信令已就绪",
      });
      onStatus("subscribed");
    },
    send(message: SignalMessage) {
      onDiagnostic(signalDiagnostic(message, "sent", true));
      channel.postMessage(message);
    },
    dispose() {
      onDiagnostic({
        stage: "signal",
        code: "signal.transport.dispose",
        message: "释放本地 BroadcastChannel 信令",
      });
      channel.close();
    },
  };
}
