import {
  diagnosticErrorDetails,
  type ConnectionDiagnosticSink,
} from "@/src/diagnostics/connectionDiagnostics";

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

type ResolvedIceConfiguration = {
  configuration: RTCConfiguration;
  turnConfigured: boolean;
};

type TurnCredentialResponse = {
  iceServers?: unknown;
  expiresAt?: unknown;
  requestId?: unknown;
  error?: unknown;
};

const CREDENTIAL_REQUEST_TIMEOUT_MS = 10_000;

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

function summarizeIceServers(servers: RTCIceServer[]) {
  let stunUrls = 0;
  let turnUrls = 0;
  const transports = new Set<string>();
  for (const server of servers) {
    const urls = typeof server.urls === "string" ? [server.urls] : server.urls;
    for (const url of urls) {
      if (url.startsWith("stun:")) stunUrls += 1;
      if (url.startsWith("turn:") || url.startsWith("turns:")) {
        turnUrls += 1;
        const scheme = url.startsWith("turns:") ? "tls" : "turn";
        const transport = new URLSearchParams(url.split("?")[1] ?? "").get("transport") ?? "udp";
        const port = url.match(/:(\d+)(?:\?|$)/)?.[1] ?? (scheme === "tls" ? "5349" : "3478");
        transports.add(`${scheme}/${transport}:${port}`);
      }
    }
  }
  return {
    iceServerCount: servers.length,
    stunUrlCount: stunUrls,
    turnUrlCount: turnUrls,
    transports: [...transports].join(",") || "none",
  };
}

export async function resolveIceConfiguration(
  onDiagnostic?: ConnectionDiagnosticSink,
): Promise<ResolvedIceConfiguration> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("credential_request_timeout"), CREDENTIAL_REQUEST_TIMEOUT_MS);
  onDiagnostic?.({
    stage: "credentials",
    code: "credentials.request.start",
    message: "开始请求 TURN 短时凭据",
    details: { endpoint: "/api/turn-credentials", timeoutMs: CREDENTIAL_REQUEST_TIMEOUT_MS },
  });

  try {
    const response = await fetch("/api/turn-credentials", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      cache: "no-store",
      signal: controller.signal,
    });
    const durationMs = Date.now() - startedAt;
    const responseRequestId = response.headers.get("x-twoonly-request-id") ?? undefined;
    let payload: TurnCredentialResponse | null = null;
    try {
      payload = await response.json() as TurnCredentialResponse;
    } catch (error: unknown) {
      onDiagnostic?.({
        stage: "credentials",
        code: "credentials.response.invalid_json",
        level: "warn",
        message: "凭据接口返回了无法解析的 JSON，将使用本地 ICE 配置",
        details: { status: response.status, durationMs, requestId: responseRequestId, ...diagnosticErrorDetails(error) },
      });
    }

    if (response.ok) {
      const servers = Array.isArray(payload?.iceServers)
        ? payload.iceServers.map(normalizeIceServer).filter((server): server is RTCIceServer => Boolean(server))
        : [];
      const summary = summarizeIceServers(servers);
      if (servers.length && summary.turnUrlCount) {
        const expiresAt = typeof payload?.expiresAt === "number" ? payload.expiresAt : undefined;
        const requestId = typeof payload?.requestId === "string" ? payload.requestId : responseRequestId;
        onDiagnostic?.({
          stage: "credentials",
          code: "credentials.success",
          level: "success",
          message: "TURN 短时凭据获取成功",
          details: {
            status: response.status,
            durationMs,
            requestId,
            expiresInMinutes: expiresAt ? Math.max(0, Math.round((expiresAt - Date.now()) / 60_000)) : undefined,
            ...summary,
          },
        });
        onDiagnostic?.({
          stage: "credentials",
          code: "credentials.ready",
          level: "success",
          message: "动态 TURN ICE 配置已就绪",
          details: { source: "dynamic", turnConfigured: true, policy: iceTransportPolicy },
        });
        return {
          configuration: { iceServers: servers, iceCandidatePoolSize: 4, iceTransportPolicy },
          turnConfigured: true,
        };
      }
      onDiagnostic?.({
        stage: "credentials",
        code: "credentials.response.invalid_payload",
        level: "warn",
        message: "凭据响应不含有效 TURN 配置，将使用本地 ICE 配置",
        details: { status: response.status, durationMs, requestId: responseRequestId },
      });
    } else {
      onDiagnostic?.({
        stage: "credentials",
        code: "credentials.response.http_error",
        level: "warn",
        message: "凭据接口返回错误，将使用本地 ICE 配置",
        details: {
          status: response.status,
          durationMs,
          requestId: responseRequestId,
          errorCode: typeof payload?.error === "string" ? payload.error : "unknown",
        },
      });
    }
  } catch (error: unknown) {
    const timedOut = controller.signal.aborted;
    onDiagnostic?.({
      stage: "credentials",
      code: timedOut ? "credentials.request.timeout" : "credentials.request.network_error",
      level: "warn",
      message: timedOut
        ? "凭据请求超过 10 秒，已中止并继续初始化信令"
        : "浏览器无法访问凭据接口，将使用本地 ICE 配置",
      details: { durationMs: Date.now() - startedAt, ...diagnosticErrorDetails(error) },
    });
  } finally {
    clearTimeout(timeout);
  }

  const fallbackSource = HAS_STATIC_TURN_CONFIGURATION ? "static-turn" : "stun-only";
  onDiagnostic?.({
    stage: "credentials",
    code: "credentials.ready",
    level: HAS_STATIC_TURN_CONFIGURATION ? "success" : "warn",
    message: HAS_STATIC_TURN_CONFIGURATION
      ? "已切换到静态 TURN ICE 配置"
      : "已降级到 STUN-only；信令仍会继续启动",
    details: {
      source: fallbackSource,
      turnConfigured: HAS_STATIC_TURN_CONFIGURATION,
      policy: iceTransportPolicy,
      ...summarizeIceServers(STATIC_ICE_CONFIGURATION.iceServers ?? []),
    },
  });
  return {
    configuration: STATIC_ICE_CONFIGURATION,
    turnConfigured: HAS_STATIC_TURN_CONFIGURATION,
  };
}
