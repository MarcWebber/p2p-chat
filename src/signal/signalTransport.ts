import { SIGNAL_POLICY } from "@/src/config/policy";
import { PUBLIC_SIGNAL_CONFIG } from "@/src/config/publicRuntime";
import {
  diagnosticErrorDetails,
  type ConnectionDiagnosticEvent,
  type ConnectionDiagnosticSink,
} from "@/src/diagnostics/connectionDiagnostics";
import { createHttpsSignalTransport } from "@/src/signal/httpsSignalTransport";
import { createSupabaseSignalTransport } from "@/src/signal/supabaseSignalTransport";
import type { HttpsSignalClientError } from "@/src/signal/httpsSignalProtocol";
import {
  isSignalMessage,
  type RoutedSignalMessage,
  type SignalMessage,
  type SignalProvider,
  type SignalProviderName,
  type SignalProviderState,
} from "@/src/signal/types";
import { shortId } from "@/src/utils/format";

type SignalTransportOptions = {
  roomId: string;
  participantId: string;
  secret: string;
  onMessage: (message: SignalMessage) => void;
  onStatus: (status: "subscribed" | "unavailable") => void;
  onClientError: (error: HttpsSignalClientError) => void;
  onDiagnostic: ConnectionDiagnosticSink;
};

const SIGNAL_STAGES = {
  wake: "hello",
  "wake-ack": "hello",
  offer: "sdp",
  answer: "sdp",
  candidate: "ice",
  rejected: "signal",
} as const;

function signalDiagnostic(
  message: SignalMessage,
  direction: "sent" | "received",
  provider?: SignalProviderName,
): ConnectionDiagnosticEvent {
  const stage = SIGNAL_STAGES[message.type];
  const code = message.type === "wake" || message.type === "wake-ack"
    ? message.type
    : `${stage}.${message.type}`;
  const dedupe = message.type === "wake" || message.type === "candidate";
  return {
    stage,
    code: `${code}.${direction}`,
    level: direction === "sent" && message.type === "wake" ? "success" : "info",
    message: `${direction === "sent" ? "发送" : "收到"} ${message.type} 信令`,
    details: {
      provider,
      hasTarget: "to" in message && Boolean(message.to),
      restart: message.type === "wake" ? message.restart : undefined,
      wakeSeq: message.type === "wake" || message.type === "wake-ack" ? message.wakeSeq : undefined,
      localEpoch: message.fromEpoch,
      remoteEpoch: "toEpoch" in message ? message.toEpoch : undefined,
      negotiation: "negotiationId" in message ? shortId(message.negotiationId) : undefined,
      signal: shortId(message.signalId),
    },
    dedupeKey: dedupe ? `${message.type}-${direction}-${provider ?? "all"}` : undefined,
  };
}

export function createSignalTransport({
  roomId,
  participantId,
  secret,
  onMessage,
  onStatus,
  onClientError,
  onDiagnostic,
}: SignalTransportOptions) {
  const states = new Map<SignalProviderName, SignalProviderState>();
  const seenSignals = new Set<string>();
  const bridgePeers = new Map<string, number>();
  let disposed = false;
  let lastStatus: "subscribed" | "unavailable" | undefined;
  let negotiationActive = true;
  let httpsStarted = false;

  const emitStatus = (status: "subscribed" | "unavailable") => {
    if (disposed || lastStatus === status) return;
    lastStatus = status;
    onStatus(status);
  };

  const providerOptions = (name: SignalProviderName) => ({
    roomId,
    onMessage: (value: unknown) => receive(name, value),
    onState: (state: SignalProviderState) => {
      states.set(name, state);
      if (name === "supabase" && state === "ready") {
        https.setNegotiationActive?.(false);
        onDiagnostic({
          stage: "signal",
          code: "signal.route.primary",
          level: "success",
          message: "使用 Supabase 主信令，Redis 降级通道保持休眠",
          details: { readyProviders: "supabase" },
          dedupeKey: "signal-route-primary",
        });
        emitStatus("subscribed");
        return;
      }
      if (name === "supabase" && state === "unavailable") {
        emitStatus(states.get("https") === "ready" ? "subscribed" : "unavailable");
        ensureHttpsStarted();
        return;
      }
      if (name === "https" && states.get("supabase") !== "ready") {
        if (state === "ready") emitStatus("subscribed");
        else if (state === "unavailable") emitStatus("unavailable");
      }
    },
    onDiagnostic,
  });

  const receive = (provider: SignalProviderName, value: unknown) => {
    if (!isSignalMessage(value)) {
      onDiagnostic({
        stage: "signal",
        code: "signal.message.invalid",
        level: "warn",
        message: "忽略了一条格式无效的信令消息",
        details: { provider },
        dedupeKey: `invalid-signal-${provider}`,
      });
      return;
    }

    if (value.signalId && seenSignals.has(value.signalId)) return;
    if (value.signalId) {
      if (seenSignals.size >= SIGNAL_POLICY.maxDedupeEntries) {
        seenSignals.delete(seenSignals.values().next().value!);
      }
      seenSignals.add(value.signalId);
    }
    if (value.from !== participantId) {
      if (provider === "https") {
        bridgePeers.set(value.from, Date.now() + SIGNAL_POLICY.httpsBridgeWindowMs);
        ensureHttpsStarted(false);
        https.setPublishOnlyActive?.(true);
      } else {
        bridgePeers.delete(value.from);
      }
    }
    onDiagnostic(signalDiagnostic(value, "received", provider));
    onMessage(value);
  };

  const https = createHttpsSignalTransport({
    ...providerOptions("https"),
    participantId,
    secret,
    onClientError,
  });
  let supabase: SignalProvider | null = null;
  try {
    supabase = createSupabaseSignalTransport({
      ...providerOptions("supabase"),
      onBridgeMessage: (value) => https.receiveBridge?.(value),
    });
  } catch (error: unknown) {
    onDiagnostic({
      stage: "signal",
      code: "signal.supabase.create.failed",
      level: "warn",
      message: "Supabase 信令初始化失败，将继续尝试 HTTPS 降级信令",
      details: { provider: "supabase", ...diagnosticErrorDetails(error) },
    });
  }
  if (!supabase && !PUBLIC_SIGNAL_CONFIG) {
    onDiagnostic({
      stage: "signal",
      code: "signal.supabase.config.missing",
      level: "warn",
      message: "未配置 Supabase Realtime，将仅尝试 HTTPS 降级信令",
    });
  }
  if (supabase) states.set("supabase", "connecting");
  states.set("https", "connecting");

  function ensureHttpsStarted(enablePolling = true) {
    if (disposed) return;
    if (!httpsStarted) {
      httpsStarted = true;
      https.start();
    }
    if (enablePolling) {
      onDiagnostic({
        stage: "signal",
        code: "signal.route.fallback",
        level: "warn",
        message: "Supabase 不可用，临时启用有界 Redis 降级信令",
        details: { readyProviders: "https" },
        dedupeKey: "signal-route-fallback",
      });
      https.setNegotiationActive?.(negotiationActive);
    }
  }

  return {
    start() {
      onDiagnostic({
        stage: "signal",
        code: "signal.transport.created",
        message: "已创建主备信令传输",
        details: {
          supabaseConfigured: Boolean(PUBLIC_SIGNAL_CONFIG),
          providerCount: supabase ? 2 : 1,
        },
      });
      if (supabase) supabase.start();
      else ensureHttpsStarted();
    },
    send(message: SignalMessage) {
      const routed = message as RoutedSignalMessage;
      onDiagnostic(signalDiagnostic(routed, "sent"));
      if ("to" in routed && routed.to) {
        const bridgeUntil = bridgePeers.get(routed.to) ?? 0;
        if (bridgeUntil > Date.now()) {
          ensureHttpsStarted(false);
          https.setPublishOnlyActive?.(true);
          https.send(routed);
          return;
        }
        bridgePeers.delete(routed.to);
      }
      if (supabase && states.get("supabase") !== "unavailable") {
        supabase.send(routed);
        return;
      }
      ensureHttpsStarted();
      https.send(routed);
    },
    setNegotiationActive(active: boolean) {
      negotiationActive = active;
      if (states.get("supabase") === "ready") https.setNegotiationActive?.(false);
      else if (httpsStarted) https.setNegotiationActive?.(active);
    },
    dispose() {
      disposed = true;
      seenSignals.clear();
      bridgePeers.clear();
      supabase?.dispose();
      https.dispose();
    },
  };
}
