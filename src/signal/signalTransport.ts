import { SIGNAL_POLICY } from "@/src/config/policy";
import { PUBLIC_SIGNAL_CONFIG } from "@/src/config/publicRuntime";
import {
  diagnosticErrorDetails,
  type ConnectionDiagnosticEvent,
  type ConnectionDiagnosticSink,
} from "@/src/diagnostics/connectionDiagnostics";
import { createHttpsSignalTransport } from "@/src/signal/httpsSignalTransport";
import { createSupabaseSignalTransport } from "@/src/signal/supabaseSignalTransport";
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
  onDiagnostic: ConnectionDiagnosticSink;
};

const SIGNAL_STAGES = {
  hello: "hello",
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
  const code = message.type === "hello" ? "hello" : `${stage}.${message.type}`;
  const dedupe = message.type === "hello" || message.type === "candidate";
  return {
    stage,
    code: `${code}.${direction}`,
    level: direction === "sent" && message.type === "hello" ? "success" : "info",
    message: `${direction === "sent" ? "发送" : "收到"} ${message.type} 信令`,
    details: {
      provider,
      hasTarget: "to" in message && Boolean(message.to),
      restart: message.type === "hello" ? message.restart : undefined,
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
  onDiagnostic,
}: SignalTransportOptions) {
  const providers: SignalProvider[] = [];
  const states = new Map<SignalProviderName, SignalProviderState>();
  const seenSignals = new Set<string>();
  let disposed = false;
  let lastAvailable: boolean | undefined;
  let lastMode = "";

  const updateAggregateState = () => {
    if (disposed || !states.size) return;
    const ready = [...states].filter(([, state]) => state === "ready").map(([name]) => name);
    const unavailable = [...states.values()].every((state) => state === "unavailable");
    if (!ready.length && !unavailable) return;
    const mode = ready.length === states.size ? "dual" : ready.length ? "degraded" : "unavailable";
    if (mode !== lastMode) {
      lastMode = mode;
      onDiagnostic({
        stage: "signal",
        code: `signal.route.${mode}`,
        level: mode === "dual" ? "success" : mode === "unavailable" ? "error" : "warn",
        message: mode === "dual"
          ? "Supabase 与 HTTPS 双信令均可用"
          : mode === "degraded" ? "信令正在使用可用通道降级运行" : "所有信令通道当前均不可用",
        details: { readyProviders: ready.join(",") || "none" },
      });
    }
    const available = ready.length > 0;
    if (available !== lastAvailable && (available || unavailable)) {
      lastAvailable = available;
      onStatus(available ? "subscribed" : "unavailable");
    }
  };

  const providerOptions = (name: SignalProviderName) => ({
    roomId,
    onMessage: (value: unknown) => receive(name, value),
    onState: (state: SignalProviderState) => {
      states.set(name, state);
      updateAggregateState();
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
    onDiagnostic(signalDiagnostic(value, "received", provider));
    onMessage(value);
  };

  let supabase: SignalProvider | null = null;
  try {
    supabase = createSupabaseSignalTransport(providerOptions("supabase"));
  } catch (error: unknown) {
    onDiagnostic({
      stage: "signal",
      code: "signal.supabase.create.failed",
      level: "warn",
      message: "Supabase 信令初始化失败，将继续尝试 HTTPS 降级信令",
      details: { provider: "supabase", ...diagnosticErrorDetails(error) },
    });
  }
  if (supabase) providers.push(supabase);
  else if (!PUBLIC_SIGNAL_CONFIG) {
    onDiagnostic({
      stage: "signal",
      code: "signal.supabase.config.missing",
      level: "warn",
      message: "未配置 Supabase Realtime，将仅尝试 HTTPS 降级信令",
    });
  }
  providers.push(createHttpsSignalTransport({
    ...providerOptions("https"),
    participantId,
    secret,
  }));
  for (const provider of providers) states.set(provider.name, "connecting");

  return {
    start() {
      onDiagnostic({
        stage: "signal",
        code: "signal.transport.created",
        message: "已创建双通道信令传输",
        details: {
          supabaseConfigured: Boolean(PUBLIC_SIGNAL_CONFIG),
          providerCount: providers.length,
        },
      });
      for (const provider of providers) provider.start();
    },
    send(message: SignalMessage) {
      const routed = {
        ...message,
        signalId: crypto.randomUUID(),
        sentAt: Date.now(),
      } as RoutedSignalMessage;
      onDiagnostic(signalDiagnostic(routed, "sent"));
      for (const provider of providers) provider.send(routed);
    },
    setNegotiationActive(active: boolean) {
      for (const provider of providers) provider.setNegotiationActive?.(active);
    },
    dispose() {
      disposed = true;
      seenSignals.clear();
      for (const provider of providers) provider.dispose();
    },
  };
}
