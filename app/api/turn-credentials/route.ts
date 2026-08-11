import { RTC_POLICY } from "@/src/config/policy";
import { SERVER_RUNTIME_CONFIG } from "@/src/config/serverRuntime";
import { isSameOriginRequest } from "@/src/server/requestSecurity";
import { createTraceId } from "@/src/utils/ids";
import { hasTurnServer, normalizeIceServer } from "@/src/webrtc/iceServers";

type CloudflareTurnResponse = {
  iceServers?: unknown;
};

export async function POST(request: Request) {
  const { turn } = SERVER_RUNTIME_CONFIG;
  const requestId = createTraceId();
  const startedAt = Date.now();
  const respond = (body: Record<string, unknown>, status = 200) => Response.json(
    { ...body, requestId },
    {
      status,
      headers: {
        "Cache-Control": "no-store, max-age=0",
        [RTC_POLICY.requestIdHeader]: requestId,
        "Server-Timing": `turn-credentials;dur=${Date.now() - startedAt}`,
        Vary: "Origin",
      },
    },
  );
  console.info(`[twoonly:turn][${requestId}] credential request received`);

  if (!isSameOriginRequest(request)) {
    console.warn(`[twoonly:turn][${requestId}] cross-origin request rejected`);
    return respond({ error: "cross_origin_request" }, 403);
  }

  if (!turn.keyId || !turn.apiToken) {
    console.error(`[twoonly:turn][${requestId}] TURN environment variables are missing`);
    return respond({ error: "turn_not_configured" }, 503);
  }

  try {
    const response = await fetch(
      `${turn.apiBase}/${encodeURIComponent(turn.keyId)}/credentials/generate-ice-servers`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${turn.apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ttl: turn.credentialTtlSeconds }),
        cache: "no-store",
        signal: AbortSignal.timeout(turn.providerTimeoutMs),
      },
    );

    if (!response.ok) {
      console.error(
        `[twoonly:turn][${requestId}] Cloudflare credential generation failed (${response.status}, ${Date.now() - startedAt}ms)`,
      );
      return respond({ error: "turn_provider_unavailable" }, 502);
    }

    const payload = await response.json() as CloudflareTurnResponse;
    const iceServers = Array.isArray(payload.iceServers)
      ? payload.iceServers.map(normalizeIceServer).filter((server): server is RTCIceServer => Boolean(server))
      : [];
    if (!iceServers.length || !hasTurnServer(iceServers)) {
      console.error(`[twoonly:turn][${requestId}] Cloudflare returned an invalid ICE configuration`);
      return respond({ error: "invalid_turn_configuration" }, 502);
    }

    console.info(
      `[twoonly:turn][${requestId}] credential response ready (${iceServers.length} ICE server groups, ${Date.now() - startedAt}ms)`,
    );
    return respond({
      iceServers,
      expiresAt: Date.now() + turn.credentialTtlSeconds * 1_000,
    });
  } catch (error: unknown) {
    const errorName = error instanceof Error ? error.name : "UnknownError";
    console.error(
      `[twoonly:turn][${requestId}] credential request failed (${Date.now() - startedAt}ms, ${errorName})`,
    );
    return respond({ error: "turn_provider_unavailable" }, 502);
  }
}
