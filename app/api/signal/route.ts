import { SIGNAL_POLICY } from "@/src/config/policy";
import { isSameOriginRequest } from "@/src/server/requestSecurity";
import {
  isHttpsSignalPollRequest,
  isHttpsSignalPublishRequest,
} from "@/src/signal/httpsSignalProtocol";
import {
  isHttpsSignalStoreConfigured,
  pollHttpsSignals,
  publishHttpsSignal,
} from "@/src/signal/serverSignalStore";
import { createTraceId } from "@/src/utils/ids";

export const dynamic = "force-dynamic";
export const maxDuration = 10;

function responseHeaders(requestId: string, startedAt: number) {
  return {
    "Cache-Control": "no-store, max-age=0",
    [SIGNAL_POLICY.httpsRequestIdHeader]: requestId,
    "Server-Timing": `https-signal;dur=${Date.now() - startedAt}`,
    Vary: "Origin",
  };
}

export function GET() {
  return Response.json(
    { ok: true, configured: isHttpsSignalStoreConfigured() },
    { headers: { "Cache-Control": "no-store, max-age=0" } },
  );
}

export async function POST(request: Request) {
  const requestId = createTraceId();
  const startedAt = Date.now();
  const respond = (body: Record<string, unknown>, status = 200) => Response.json(body, {
    status,
    headers: responseHeaders(requestId, startedAt),
  });

  if (!isSameOriginRequest(request)) return respond({ error: "cross_origin_request", requestId }, 403);
  if (!isHttpsSignalStoreConfigured()) {
    return respond({ error: "signal_fallback_not_configured", requestId }, 503);
  }
  if (!request.headers.get("content-type")?.startsWith("application/json")) {
    return respond({ error: "invalid_content_type", requestId }, 415);
  }
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (declaredLength > SIGNAL_POLICY.httpsMaxRequestCharacters) {
    return respond({ error: "payload_too_large", requestId }, 413);
  }

  try {
    const text = await request.text();
    if (text.length > SIGNAL_POLICY.httpsMaxRequestCharacters) {
      return respond({ error: "payload_too_large", requestId }, 413);
    }
    const body = JSON.parse(text) as unknown;
    if (isHttpsSignalPublishRequest(body)) {
      const cursor = await publishHttpsSignal(body);
      console.info(`[twoonly:signal][${requestId}] fallback publish accepted (${Date.now() - startedAt}ms)`);
      return respond({ accepted: true, cursor, requestId });
    }
    if (isHttpsSignalPollRequest(body)) {
      const result = await pollHttpsSignals(body.roomId, body.participantId, body.cursor);
      return respond({ ...result, requestId });
    }
    return respond({ error: "invalid_signal_request", requestId }, 400);
  } catch (error: unknown) {
    const errorName = error instanceof Error ? error.name : "UnknownError";
    console.error(
      `[twoonly:signal][${requestId}] fallback request failed (${Date.now() - startedAt}ms, ${errorName})`,
    );
    return respond({ error: "signal_fallback_unavailable", requestId }, 502);
  }
}
