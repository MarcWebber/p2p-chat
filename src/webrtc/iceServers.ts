import { isRecord } from "@/src/utils/guards";

const urlsOf = (server: RTCIceServer) =>
  typeof server.urls === "string" ? [server.urls] : server.urls;
const isTurnUrl = (url: string) => url.startsWith("turn:") || url.startsWith("turns:");

export function normalizeIceServer(value: unknown): RTCIceServer | null {
  if (!isRecord(value)) return null;
  const urls = typeof value.urls === "string"
    ? [value.urls]
    : Array.isArray(value.urls) && value.urls.every((url) => typeof url === "string")
      ? value.urls
      : [];
  if (!urls.length || urls.some((url) => !/^(stun|turn|turns):/.test(url))) return null;

  const isTurn = urls.some(isTurnUrl);
  if (isTurn && (typeof value.username !== "string" || typeof value.credential !== "string")) return null;
  return {
    urls,
    ...(typeof value.username === "string" ? { username: value.username } : {}),
    ...(typeof value.credential === "string" ? { credential: value.credential } : {}),
  };
}

export function hasTurnServer(servers: RTCIceServer[]) {
  return servers.some((server) =>
    urlsOf(server).some(isTurnUrl)
    && Boolean(server.username)
    && Boolean(server.credential));
}

export function summarizeIceServers(servers: RTCIceServer[]) {
  let stunUrlCount = 0;
  let turnUrlCount = 0;
  const transports = new Set<string>();
  for (const server of servers) {
    for (const url of urlsOf(server)) {
      if (url.startsWith("stun:")) stunUrlCount += 1;
      if (isTurnUrl(url)) {
        turnUrlCount += 1;
        const scheme = url.startsWith("turns:") ? "tls" : "turn";
        const transport = new URLSearchParams(url.split("?")[1] ?? "").get("transport") ?? "udp";
        const port = url.match(/:(\d+)(?:\?|$)/)?.[1] ?? (scheme === "tls" ? "5349" : "3478");
        transports.add(`${scheme}/${transport}:${port}`);
      }
    }
  }
  return {
    iceServerCount: servers.length,
    stunUrlCount,
    turnUrlCount,
    transports: [...transports].join(",") || "none",
  };
}
