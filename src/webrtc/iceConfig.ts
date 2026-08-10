const splitIceUrls = (value: string | undefined, fallback: string[]) =>
  value?.split(",").map((item) => item.trim()).filter(Boolean) ?? fallback;

const turnUrls = splitIceUrls(process.env.NEXT_PUBLIC_TURN_URLS, []);
const turnUsername = process.env.NEXT_PUBLIC_TURN_USERNAME;
const turnCredential = process.env.NEXT_PUBLIC_TURN_CREDENTIAL;
const iceTransportPolicy: RTCIceTransportPolicy =
  process.env.NEXT_PUBLIC_ICE_TRANSPORT_POLICY === "relay" ? "relay" : "all";

const HAS_STATIC_TURN_CONFIGURATION = Boolean(
  turnUrls.length && turnUsername && turnCredential,
);

const STATIC_ICE_CONFIGURATION: RTCConfiguration = {
  iceServers: [
    {
      urls: splitIceUrls(process.env.NEXT_PUBLIC_STUN_URLS, [
        "stun:stun.cloudflare.com:3478",
        "stun:stun.l.google.com:19302",
      ]),
    },
    ...(HAS_STATIC_TURN_CONFIGURATION && turnUsername && turnCredential
      ? [{ urls: turnUrls, username: turnUsername, credential: turnCredential }]
      : []),
  ],
  iceCandidatePoolSize: 4,
  iceTransportPolicy,
};

export type ResolvedIceConfiguration = {
  configuration: RTCConfiguration;
  turnConfigured: boolean;
};

type TurnCredentialResponse = {
  iceServers?: unknown;
};

function normalizeIceServer(value: unknown): RTCIceServer | null {
  if (!value || typeof value !== "object") return null;
  const server = value as Partial<RTCIceServer>;
  const urls = typeof server.urls === "string"
    ? [server.urls]
    : Array.isArray(server.urls) && server.urls.every((url) => typeof url === "string")
      ? server.urls
      : [];
  if (!urls.length || urls.some((url) => !/^(stun|turn|turns):/.test(url))) return null;

  const isTurn = urls.some((url) => url.startsWith("turn:") || url.startsWith("turns:"));
  if (isTurn && (typeof server.username !== "string" || typeof server.credential !== "string")) {
    return null;
  }
  return {
    urls,
    ...(server.username ? { username: server.username } : {}),
    ...(server.credential ? { credential: server.credential } : {}),
  };
}

function includesTurn(servers: RTCIceServer[]) {
  return servers.some((server) => {
    const urls = typeof server.urls === "string" ? [server.urls] : server.urls;
    return urls.some((url) => url.startsWith("turn:") || url.startsWith("turns:"));
  });
}

export async function resolveIceConfiguration(): Promise<ResolvedIceConfiguration> {
  try {
    const response = await fetch("/api/turn-credentials", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      cache: "no-store",
    });
    if (response.ok) {
      const payload = await response.json() as TurnCredentialResponse;
      const servers = Array.isArray(payload.iceServers)
        ? payload.iceServers.map(normalizeIceServer).filter((server): server is RTCIceServer => Boolean(server))
        : [];
      if (servers.length && includesTurn(servers)) {
        return {
          configuration: { iceServers: servers, iceCandidatePoolSize: 4, iceTransportPolicy },
          turnConfigured: true,
        };
      }
    }
  } catch {
    // Static STUN/TURN remains available when the credential endpoint is temporarily unreachable.
  }

  return {
    configuration: STATIC_ICE_CONFIGURATION,
    turnConfigured: HAS_STATIC_TURN_CONFIGURATION,
  };
}
