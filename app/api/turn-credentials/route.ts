const CLOUDFLARE_TURN_API = "https://rtc.live.cloudflare.com/v1/turn/keys";
const TURN_CREDENTIAL_TTL_SECONDS = 86_400;

type CloudflareIceServer = {
  urls: string[];
  username?: string;
  credential?: string;
};

type CloudflareTurnResponse = {
  iceServers?: CloudflareIceServer[];
};

function isCloudflareIceServer(value: unknown): value is CloudflareIceServer {
  if (!value || typeof value !== "object") return false;
  const server = value as Partial<CloudflareIceServer>;
  return Array.isArray(server.urls)
    && server.urls.length > 0
    && server.urls.every((url) => typeof url === "string")
    && (server.username === undefined || typeof server.username === "string")
    && (server.credential === undefined || typeof server.credential === "string");
}

function hasTurnServer(servers: CloudflareIceServer[]) {
  return servers.some((server) =>
    server.urls.some((url) => url.startsWith("turn:"))
    && Boolean(server.username)
    && Boolean(server.credential));
}

export async function POST(request: Request) {
  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const host = forwardedHost || request.headers.get("host");
  const forwardedProtocol = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const protocol = forwardedProtocol || new URL(request.url).protocol.replace(":", "");
  const requestOrigin = host ? `${protocol}://${host}` : new URL(request.url).origin;
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  if ((origin && origin !== requestOrigin) || fetchSite === "cross-site") {
    return Response.json({ error: "cross_origin_request" }, { status: 403 });
  }

  const keyId = process.env.CLOUDFLARE_TURN_KEY_ID;
  const apiToken = process.env.CLOUDFLARE_TURN_API_TOKEN;
  if (!keyId || !apiToken) {
    return Response.json(
      { error: "turn_not_configured" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    const response = await fetch(
      `${CLOUDFLARE_TURN_API}/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ttl: TURN_CREDENTIAL_TTL_SECONDS }),
        cache: "no-store",
        signal: AbortSignal.timeout(8_000),
      },
    );

    if (!response.ok) {
      console.error(`[twoonly:turn] Cloudflare credential generation failed (${response.status})`);
      return Response.json(
        { error: "turn_provider_unavailable" },
        { status: 502, headers: { "Cache-Control": "no-store" } },
      );
    }

    const payload = await response.json() as CloudflareTurnResponse;
    const iceServers = payload.iceServers?.filter(isCloudflareIceServer) ?? [];
    if (!iceServers.length || !hasTurnServer(iceServers)) {
      console.error("[twoonly:turn] Cloudflare returned an invalid ICE configuration");
      return Response.json(
        { error: "invalid_turn_configuration" },
        { status: 502, headers: { "Cache-Control": "no-store" } },
      );
    }

    return Response.json(
      {
        iceServers,
        expiresAt: Date.now() + TURN_CREDENTIAL_TTL_SECONDS * 1_000,
      },
      {
        headers: {
          "Cache-Control": "no-store, max-age=0",
          Vary: "Origin",
        },
      },
    );
  } catch (error: unknown) {
    console.error("[twoonly:turn] credential request failed", error);
    return Response.json(
      { error: "turn_provider_unavailable" },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}
