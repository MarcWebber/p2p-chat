import { SIGNAL_POLICY } from "@/src/config/policy";
import { isSameOriginRequest } from "@/src/server/requestSecurity";
import {
  HTTPS_SIGNAL_ERROR_LEVEL,
  isHttpsSignalActionRequest,
  isHttpsSignalPollRequest,
  isHttpsSignalPublishRequest,
  type HttpsSignalClientError,
  type HttpsSignalErrorResponse,
} from "@/src/signal/httpsSignalProtocol";
import {
  isHttpsSignalStoreConfigured,
  broadcastHttpsSignal,
  isHttpsSignalBridgeConfigured,
  pollHttpsSignals,
  publishHttpsSignal,
} from "@/src/signal/serverSignalStore";
import { createTraceId } from "@/src/utils/ids";

export const dynamic = "force-dynamic";
export const maxDuration = 10;

function responseHeaders(requestId: string, startedAt: number) {
  return {
    "Cache-Control": "no-store, max-age=0",
    "X-TwoOnly-Signal-Protocol": String(SIGNAL_POLICY.protocolVersion),
    [SIGNAL_POLICY.httpsRequestIdHeader]: requestId,
    "Server-Timing": `https-signal;dur=${Date.now() - startedAt}`,
    Vary: "Origin",
  };
}

export function GET() {
  return Response.json(
    {
      ok: true,
      protocol: SIGNAL_POLICY.protocolVersion,
      configured: isHttpsSignalStoreConfigured(),
      bridgeConfigured: isHttpsSignalBridgeConfigured(),
    },
    { headers: { "Cache-Control": "no-store, max-age=0" } },
  );
}

export async function POST(request: Request) {
  const requestId = createTraceId();
  const startedAt = Date.now();
  const respond = (body: unknown, status = 200) => Response.json(body, {
    status,
    headers: responseHeaders(requestId, startedAt),
  });
  const reject = (
    status: number,
    error: Omit<HttpsSignalClientError, "retryable">,
  ) => respond({
    error: {
      ...error,
      retryable: error.level === HTTPS_SIGNAL_ERROR_LEVEL.recoverable,
    },
    requestId,
  } satisfies HttpsSignalErrorResponse, status);

  if (!isSameOriginRequest(request)) {
    return reject(403, {
      code: "cross_origin_request",
      level: HTTPS_SIGNAL_ERROR_LEVEL.terminal,
      message: "信令请求来源无效。",
    });
  }
  if (!request.headers.get("content-type")?.startsWith("application/json")) {
    return reject(415, {
      code: "invalid_content_type",
      level: HTTPS_SIGNAL_ERROR_LEVEL.terminal,
      message: "信令请求必须使用 JSON。",
    });
  }
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (declaredLength > SIGNAL_POLICY.httpsMaxRequestCharacters) {
    return reject(413, {
      code: "payload_too_large",
      level: HTTPS_SIGNAL_ERROR_LEVEL.terminal,
      message: "信令请求超过大小限制。",
    });
  }

  let body: unknown;
  try {
    const text = await request.text();
    if (text.length > SIGNAL_POLICY.httpsMaxRequestCharacters) {
      return reject(413, {
        code: "payload_too_large",
        level: HTTPS_SIGNAL_ERROR_LEVEL.terminal,
        message: "信令请求超过大小限制。",
      });
    }
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      return reject(400, {
        code: "invalid_json",
        level: HTTPS_SIGNAL_ERROR_LEVEL.terminal,
        message: "信令请求不是有效的 JSON。",
      });
    }

    if (isHttpsSignalActionRequest(body) && body.protocol !== SIGNAL_POLICY.protocolVersion) {
      const receivedProtocol = typeof body.protocol === "number" ? body.protocol : undefined;
      return reject(426, {
        code: "client_upgrade_required",
        level: HTTPS_SIGNAL_ERROR_LEVEL.terminal,
        message: "当前页面版本过旧，请刷新页面后重试。",
        expectedProtocol: SIGNAL_POLICY.protocolVersion,
        ...(receivedProtocol === undefined ? {} : { receivedProtocol }),
      });
    }

    const publishRequest = isHttpsSignalPublishRequest(body) ? body : null;
    const pollRequest = isHttpsSignalPollRequest(body) ? body : null;
    if (!publishRequest && !pollRequest) {
      return reject(400, {
        code: "invalid_signal_request",
        level: HTTPS_SIGNAL_ERROR_LEVEL.terminal,
        message: "信令请求字段无效。",
      });
    }

    if (!isHttpsSignalStoreConfigured()) {
      return reject(503, {
        code: "signal_fallback_not_configured",
        level: HTTPS_SIGNAL_ERROR_LEVEL.terminal,
        message: "HTTPS 降级信令尚未配置。",
      });
    }

    if (publishRequest) {
      const { cursor, event } = await publishHttpsSignal(publishRequest);
      let bridgeForwarded = false;
      try {
        bridgeForwarded = await broadcastHttpsSignal(publishRequest.roomId, event);
      } catch (error: unknown) {
        const errorName = error instanceof Error ? error.name : "UnknownError";
        console.warn(`[twoonly:signal][${requestId}] Supabase bridge unavailable (${errorName})`);
      }
      console.info(`[twoonly:signal][${requestId}] fallback publish accepted (${Date.now() - startedAt}ms)`);
      return respond({ accepted: true, cursor, bridgeForwarded, requestId });
    }
    if (pollRequest) {
      const result = await pollHttpsSignals(
        pollRequest.roomId,
        pollRequest.participantId,
        pollRequest.cursor,
      );
      return respond({ ...result, requestId });
    }
  } catch (error: unknown) {
    const errorName = error instanceof Error ? error.name : "UnknownError";
    console.error(
      `[twoonly:signal][${requestId}] fallback request failed (${Date.now() - startedAt}ms, ${errorName})`,
    );
    return reject(502, {
      code: "signal_fallback_unavailable",
      level: HTTPS_SIGNAL_ERROR_LEVEL.recoverable,
      message: "HTTPS 降级信令暂时不可用。",
    });
  }
}
