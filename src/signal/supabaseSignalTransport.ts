import { createClient } from "@supabase/supabase-js";

import { RESOURCE_NAMES, SIGNAL_POLICY } from "@/src/config/policy";
import { PUBLIC_SIGNAL_CONFIG } from "@/src/config/publicRuntime";
import {
  diagnosticErrorDetails,
  sanitizeDiagnosticText,
} from "@/src/diagnostics/connectionDiagnostics";
import type { SignalProvider, SignalProviderOptions } from "@/src/signal/types";

type SupabaseSignalTransportOptions = SignalProviderOptions & {
  onBridgeMessage: (value: unknown) => void;
};

type SharedRealtimeListener = {
  onDiagnostic: SignalProviderOptions["onDiagnostic"];
  onUnavailable: () => void;
};

const sharedRealtimeListeners = new Set<SharedRealtimeListener>();
let sharedClient: ReturnType<typeof createClient> | null = null;
let firstHealthyHeartbeatSeen = false;

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

function getSharedClient(url: string, key: string) {
  if (sharedClient) return sharedClient;
  sharedClient = createClient(url, key, {
    auth: { persistSession: false },
    realtime: {
      worker: true,
      heartbeatCallback(status, latency) {
        if (status === "ok" && !firstHealthyHeartbeatSeen) {
          firstHealthyHeartbeatSeen = true;
          for (const listener of sharedRealtimeListeners) listener.onDiagnostic({
            stage: "signal",
            code: "signal.supabase.heartbeat.ok",
            level: "success",
            message: "Supabase Realtime 首次心跳响应正常",
            details: { provider: "supabase", latencyMs: latency },
          });
        }
        if (status === "error" || status === "timeout") {
          for (const listener of sharedRealtimeListeners) {
            listener.onDiagnostic({
              stage: "signal",
              code: `signal.supabase.heartbeat.${status}`,
              level: "error",
              message: status === "timeout" ? "Supabase Realtime 心跳超时" : "Supabase Realtime 心跳失败",
              details: { provider: "supabase", latencyMs: latency },
            });
            listener.onUnavailable();
          }
        }
      },
      logger(kind, message) {
        if (kind !== "transport" && kind !== "error") return;
        const safeMessage = safeRealtimeMessage(kind, message);
        const failed = /failed|failure|error|timeout|closed/i.test(safeMessage);
        for (const listener of sharedRealtimeListeners) listener.onDiagnostic({
          stage: "signal",
          code: failed ? "signal.supabase.transport.error" : "signal.supabase.transport.event",
          level: failed ? "error" : "info",
          message: safeMessage,
          details: { provider: "supabase" },
          dedupeKey: `supabase-${kind}-${safeMessage}`,
        });
      },
    },
  });
  return sharedClient;
}

export function createSupabaseSignalTransport({
  roomId,
  onMessage,
  onBridgeMessage,
  onState,
  onDiagnostic,
}: SupabaseSignalTransportOptions): SignalProvider | null {
  if (!PUBLIC_SIGNAL_CONFIG) return null;

  const { url, key } = PUBLIC_SIGNAL_CONFIG;
  let disposed = false;
  const startedAt = Date.now();
  const providerHost = (() => {
    try {
      return new URL(url).host;
    } catch {
      return "invalid-host";
    }
  })();
  const listener: SharedRealtimeListener = {
    onDiagnostic,
    onUnavailable: () => {
      if (!disposed) onState("unavailable");
    },
  };
  sharedRealtimeListeners.add(listener);
  const client = getSharedClient(url, key);
  const channel = client.channel(`${RESOURCE_NAMES.roomPrefix}${roomId}`, {
    config: { broadcast: { ack: true } },
  });
  channel.on("broadcast", { event: SIGNAL_POLICY.realtimeEvent }, ({ payload }) => onMessage(payload));
  channel.on("broadcast", { event: SIGNAL_POLICY.realtimeBridgeEvent }, ({ payload }) => onBridgeMessage(payload));

  return {
    name: "supabase",
    start() {
      onDiagnostic({
        stage: "signal",
        code: "signal.supabase.subscribe.start",
        message: "开始订阅 Supabase Realtime 房间",
        details: { provider: "supabase", providerHost },
      });
      channel.subscribe((status, error) => {
        if (disposed) return;
        if (status === "SUBSCRIBED") {
          onDiagnostic({
            stage: "signal",
            code: "signal.supabase.ready",
            level: "success",
            message: "Supabase Realtime 信令已订阅",
            details: { provider: "supabase", durationMs: Date.now() - startedAt },
          });
          onState("ready");
        }
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
          onDiagnostic({
            stage: "signal",
            code: `signal.supabase.${status.toLowerCase()}`,
            level: "error",
            message: `Supabase Realtime 状态异常：${status}`,
            details: {
              provider: "supabase",
              durationMs: Date.now() - startedAt,
              ...(error ? diagnosticErrorDetails(error) : {}),
            },
          });
          onState("unavailable");
        }
      });
    },
    send(message) {
      const sentAt = Date.now();
      void channel
        .send({ type: "broadcast", event: SIGNAL_POLICY.realtimeEvent, payload: message })
        .then((result) => {
          onDiagnostic({
            stage: "signal",
            code: "signal.supabase.send.ack",
            level: result === "ok" ? "success" : "error",
            message: `Supabase ${message.type} 信令确认结果：${result}`,
            details: { provider: "supabase", durationMs: Date.now() - sentAt },
            dedupeKey: `${message.type}-supabase-ack-${result}`,
          });
          if (result !== "ok" && !disposed) onState("unavailable");
        })
        .catch((error: unknown) => {
          if (disposed) return;
          onDiagnostic({
            stage: "signal",
            code: "signal.supabase.send.failed",
            level: "error",
            message: `Supabase ${message.type} 信令发送失败`,
            details: {
              provider: "supabase",
              durationMs: Date.now() - sentAt,
              ...diagnosticErrorDetails(error),
            },
          });
          onState("unavailable");
        });
    },
    dispose() {
      disposed = true;
      sharedRealtimeListeners.delete(listener);
      void client.removeChannel(channel).then(() => {
        if (!sharedRealtimeListeners.size && sharedClient === client) client.realtime.disconnect();
      });
    },
  };
}
