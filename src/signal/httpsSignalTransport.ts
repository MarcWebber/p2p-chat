import { SIGNAL_POLICY } from "@/src/config/policy";
import { createJsonCipher } from "@/src/crypto/aesGcm";
import { diagnosticErrorDetails } from "@/src/diagnostics/connectionDiagnostics";
import {
  isHttpsSignalPollResponse,
  type HttpsSignalPollRequest,
  type HttpsSignalPublishRequest,
} from "@/src/signal/httpsSignalProtocol";
import {
  isRoutedSignalMessage,
  type SignalProvider,
  type SignalProviderOptions,
  type SignalProviderState,
} from "@/src/signal/types";

type HttpsSignalTransportOptions = SignalProviderOptions & {
  participantId: string;
  secret: string;
};

export function createHttpsSignalTransport({
  roomId,
  participantId,
  secret,
  onMessage,
  onState,
  onDiagnostic,
}: HttpsSignalTransportOptions): SignalProvider {
  const cipher = createJsonCipher(`${secret}:twoonly-signal:v1`);
  let state: SignalProviderState = "connecting";
  let cursor = "0-0";
  let active = false;
  let disposed = false;
  let pollTimer: number | undefined;
  let pollGeneration = 0;
  let lastHelloAt = 0;
  let acceptPublishedAfter = Date.now() - SIGNAL_POLICY.httpsReplayWindowMs;

  function updateState(next: SignalProviderState) {
    if (state === next) return;
    state = next;
    onState(next);
  }

  async function post(body: HttpsSignalPollRequest | HttpsSignalPublishRequest) {
    const response = await fetch(SIGNAL_POLICY.httpsEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
      credentials: "same-origin",
      signal: AbortSignal.timeout(SIGNAL_POLICY.httpsRequestTimeoutMs),
    });
    if (!response.ok) throw new Error(`HTTPS fallback returned ${response.status}`);
    return await response.json() as unknown;
  }

  function fail(code: string, message: string, error: unknown) {
    updateState("unavailable");
    onDiagnostic({
      stage: "signal",
      code,
      level: "warn",
      message,
      details: { provider: "https", ...diagnosticErrorDetails(error) },
      dedupeKey: code,
    });
  }

  function stopPolling() {
    pollGeneration += 1;
    if (pollTimer !== undefined) window.clearTimeout(pollTimer);
    pollTimer = undefined;
  }

  function schedulePoll(delay = 0) {
    const generation = pollGeneration;
    pollTimer = window.setTimeout(() => void poll(generation), delay);
  }

  async function poll(generation: number) {
    if (disposed || !active || generation !== pollGeneration) return;
    try {
      const body = await post({
        action: "poll",
        roomId,
        participantId,
        cursor,
      });
      if (disposed || !active || generation !== pollGeneration) return;
      if (!isHttpsSignalPollResponse(body)) throw new Error("invalid HTTPS fallback response");
      cursor = body.cursor;
      updateState("ready");
      for (const event of body.events) {
        if (event.publishedAt < acceptPublishedAfter) continue;
        try {
          const message = await cipher.decrypt(event.payload);
          if (!isRoutedSignalMessage(message)
            || message.from !== event.senderId
            || message.signalId !== event.signalId) {
            throw new Error("invalid encrypted signal");
          }
          onMessage(message);
        } catch (error: unknown) {
          onDiagnostic({
            stage: "signal",
            code: "signal.https.message.invalid",
            level: "warn",
            message: "忽略了一条无法验证的 HTTPS 降级信令",
            details: { provider: "https", ...diagnosticErrorDetails(error) },
            dedupeKey: "https-invalid-message",
          });
        }
      }
    } catch (error: unknown) {
      if (disposed || !active || generation !== pollGeneration) return;
      fail("signal.https.poll.failed", "Vercel HTTPS 降级信令暂时不可用", error);
    } finally {
      if (!disposed && active && generation === pollGeneration) {
        schedulePoll(SIGNAL_POLICY.httpsPollIntervalMs);
      }
    }
  }

  return {
    name: "https",
    start() {
      if (active || disposed) return;
      active = true;
      onDiagnostic({
        stage: "signal",
        code: "signal.https.poll.start",
        message: "开始连接同源 Vercel HTTPS 降级信令",
        details: { provider: "https" },
      });
      schedulePoll();
    },
    send(message) {
      const now = Date.now();
      if (message.type === "hello" && now - lastHelloAt < SIGNAL_POLICY.httpsHelloIntervalMs) return;
      if (message.type === "hello") lastHelloAt = now;
      void cipher.encrypt(message).then(async (payload) => {
        const sentAt = Date.now();
        await post({
          action: "publish",
          roomId,
          senderId: participantId,
          signalId: message.signalId,
          payload,
        });
        updateState("ready");
        onDiagnostic({
          stage: "signal",
          code: "signal.https.send.ack",
          level: "success",
          message: `HTTPS ${message.type} 信令已暂存`,
          details: { provider: "https", durationMs: Date.now() - sentAt },
          dedupeKey: `${message.type}-https-ack`,
        });
      }).catch((error: unknown) => {
        if (disposed) return;
        fail(
          "signal.https.send.failed",
          `HTTPS ${message.type} 信令发送失败`,
          error,
        );
      });
    },
    setNegotiationActive(next) {
      if (disposed || active === next) return;
      active = next;
      stopPolling();
      if (active) {
        cursor = "0-0";
        acceptPublishedAfter = Date.now() - SIGNAL_POLICY.httpsReplayWindowMs;
        schedulePoll();
      }
    },
    dispose() {
      disposed = true;
      stopPolling();
    },
  };
}
