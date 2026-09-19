import { SIGNAL_POLICY } from "@/src/config/policy";
import { createJsonCipher } from "@/src/crypto/aesGcm";
import { diagnosticErrorDetails } from "@/src/diagnostics/connectionDiagnostics";
import {
  HTTPS_SIGNAL_ERROR_LEVEL,
  isHttpsSignalErrorResponse,
  isHttpsSignalPollResponse,
  isHttpsSignalEvent,
  type HttpsSignalClientError,
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
  onClientError: (error: HttpsSignalClientError) => void;
};

class HttpsSignalRequestError extends Error {
  readonly name = "HttpsSignalRequestError";

  constructor(
    readonly status: number,
    readonly clientError: HttpsSignalClientError,
  ) {
    super(clientError.message);
  }
}

export function createHttpsSignalTransport({
  roomId,
  participantId,
  secret,
  onMessage,
  onState,
  onDiagnostic,
  onClientError,
}: HttpsSignalTransportOptions): SignalProvider {
  const cipher = createJsonCipher(`${secret}:twoonly-signal:v1`);
  let state: SignalProviderState = "connecting";
  let cursor = "0-0";
  let started = false;
  let active = false;
  let publishOnlyActive = false;
  let disposed = false;
  let terminalError = false;
  let polling = false;
  let pollTimer: number | undefined;
  let pollGeneration = 0;
  let pollIndex = 0;
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
    const responseBody = await response.json().catch(() => undefined) as unknown;
    if (!response.ok) {
      if (isHttpsSignalErrorResponse(responseBody)) {
        throw new HttpsSignalRequestError(response.status, responseBody.error);
      }
      throw new Error(`HTTPS fallback returned ${response.status}`);
    }
    return responseBody;
  }

  function fail(code: string, message: string, error: unknown) {
    if (error instanceof HttpsSignalRequestError) {
      const { clientError } = error;
      if (clientError.level === HTTPS_SIGNAL_ERROR_LEVEL.terminal) {
        terminalError = true;
        active = false;
        publishOnlyActive = false;
        stopPolling();
      }
      updateState("unavailable");
      onClientError(clientError);
      onDiagnostic({
        stage: "signal",
        code: `signal.https.${clientError.code}`,
        level: clientError.level === HTTPS_SIGNAL_ERROR_LEVEL.terminal ? "error" : "warn",
        message: clientError.message,
        details: {
          provider: "https",
          status: error.status,
          errorLevel: clientError.level,
          retryable: clientError.retryable,
          expectedProtocol: clientError.expectedProtocol,
          receivedProtocol: clientError.receivedProtocol,
        },
        dedupeKey: `https-${clientError.code}`,
      });
      return;
    }
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
    polling = false;
    if (pollTimer !== undefined) window.clearTimeout(pollTimer);
    pollTimer = undefined;
  }

  function schedulePoll(delay: number) {
    const generation = pollGeneration;
    pollTimer = window.setTimeout(() => void poll(generation), delay);
  }

  function beginPolling() {
    if (terminalError) return;
    stopPolling();
    polling = true;
    pollIndex = 0;
    cursor = "0-0";
    acceptPublishedAfter = Date.now() - SIGNAL_POLICY.httpsReplayWindowMs;
    schedulePoll(SIGNAL_POLICY.httpsFallbackPollDelaysMs[pollIndex]);
  }

  async function acceptEvent(event: Parameters<typeof isHttpsSignalEvent>[0]) {
    if (!isHttpsSignalEvent(event) || event.publishedAt < acceptPublishedAfter) return;
    try {
      const message = await cipher.decrypt(event.payload);
      if (disposed || terminalError) return;
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

  async function poll(generation: number) {
    if (disposed || !active || generation !== pollGeneration) return;
    pollTimer = undefined;
    try {
      const body = await post({
        action: "poll",
        protocol: SIGNAL_POLICY.protocolVersion,
        roomId,
        participantId,
        cursor,
      });
      if (disposed || !active || generation !== pollGeneration) return;
      if (!isHttpsSignalPollResponse(body)) throw new Error("invalid HTTPS fallback response");
      cursor = body.cursor;
      updateState("ready");
      for (const event of body.events) {
        await acceptEvent(event);
      }
    } catch (error: unknown) {
      if (disposed || !active || generation !== pollGeneration) return;
      fail("signal.https.poll.failed", "Vercel HTTPS 降级信令暂时不可用", error);
    } finally {
      if (!disposed && active && generation === pollGeneration) {
        pollIndex += 1;
        const delay = SIGNAL_POLICY.httpsFallbackPollDelaysMs[pollIndex];
        if (delay === undefined) polling = false;
        else schedulePoll(delay);
      }
    }
  }

  return {
    name: "https",
    start() {
      if (started || disposed) return;
      started = true;
      onDiagnostic({
        stage: "signal",
        code: "signal.https.ready",
        message: "同源 Vercel HTTPS 降级信令已准备，默认不轮询",
        details: { provider: "https" },
      });
    },
    send(message) {
      if (!started || (!active && !publishOnlyActive) || disposed || terminalError) return;
      if (active && message.type === "wake" && !polling) beginPolling();
      const generation = pollGeneration;
      void cipher.encrypt(message).then(async (payload) => {
        if (disposed || (!publishOnlyActive && (!active || generation !== pollGeneration))) return;
        const sentAt = Date.now();
        await post({
          action: "publish",
          protocol: SIGNAL_POLICY.protocolVersion,
          roomId,
          senderId: participantId,
          signalId: message.signalId,
          payload,
        });
        if (disposed || terminalError || (!publishOnlyActive && (!active || generation !== pollGeneration))) return;
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
        if (disposed || terminalError || (!publishOnlyActive && (!active || generation !== pollGeneration))) return;
        fail(
          "signal.https.send.failed",
          `HTTPS ${message.type} 信令发送失败`,
          error,
        );
      });
    },
    receiveBridge(value) {
      if (disposed) return;
      void acceptEvent(value);
    },
    setNegotiationActive(next) {
      if (disposed || !started || terminalError || active === next) return;
      active = next;
      stopPolling();
      if (active) {
        beginPolling();
      }
    },
    setPublishOnlyActive(next) {
      if (!terminalError) publishOnlyActive = next;
    },
    dispose() {
      disposed = true;
      stopPolling();
    },
  };
}
