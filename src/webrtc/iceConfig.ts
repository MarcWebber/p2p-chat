import { RTC_POLICY } from "@/src/config/policy";
import { PUBLIC_ICE_CONFIG } from "@/src/config/publicRuntime";
import {
  diagnosticErrorDetails,
  type ConnectionDiagnosticSink,
} from "@/src/diagnostics/connectionDiagnostics";
import { hasTurnServer, normalizeIceServer, summarizeIceServers } from "@/src/webrtc/iceServers";

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

export async function resolveIceConfiguration(
  onDiagnostic?: ConnectionDiagnosticSink,
): Promise<ResolvedIceConfiguration> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort("credential_request_timeout"),
    RTC_POLICY.credentialRequestTimeoutMs,
  );
  onDiagnostic?.({
    stage: "credentials",
    code: "credentials.request.start",
    message: "开始请求 TURN 短时凭据",
    details: { endpoint: RTC_POLICY.credentialEndpoint, timeoutMs: RTC_POLICY.credentialRequestTimeoutMs },
  });

  try {
    const response = await fetch(RTC_POLICY.credentialEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      cache: "no-store",
      signal: controller.signal,
    });
    const durationMs = Date.now() - startedAt;
    const responseRequestId = response.headers.get(RTC_POLICY.requestIdHeader) ?? undefined;
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
      if (servers.length && hasTurnServer(servers)) {
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
          details: { source: "dynamic", turnConfigured: true, policy: PUBLIC_ICE_CONFIG.transportPolicy },
        });
        return {
          configuration: {
            iceServers: servers,
            iceCandidatePoolSize: RTC_POLICY.iceCandidatePoolSize,
            iceTransportPolicy: PUBLIC_ICE_CONFIG.transportPolicy,
          },
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
        ? `凭据请求超过 ${RTC_POLICY.credentialRequestTimeoutMs / 1_000} 秒，已中止并继续初始化信令`
        : "浏览器无法访问凭据接口，将使用本地 ICE 配置",
      details: { durationMs: Date.now() - startedAt, ...diagnosticErrorDetails(error) },
    });
  } finally {
    clearTimeout(timeout);
  }

  const fallbackSource = PUBLIC_ICE_CONFIG.hasStaticTurn ? "static-turn" : "stun-only";
  onDiagnostic?.({
    stage: "credentials",
    code: "credentials.ready",
    level: PUBLIC_ICE_CONFIG.hasStaticTurn ? "success" : "warn",
    message: PUBLIC_ICE_CONFIG.hasStaticTurn
      ? "已切换到静态 TURN ICE 配置"
      : "已降级到 STUN-only；信令仍会继续启动",
    details: {
      source: fallbackSource,
      turnConfigured: PUBLIC_ICE_CONFIG.hasStaticTurn,
      policy: PUBLIC_ICE_CONFIG.transportPolicy,
      ...summarizeIceServers(PUBLIC_ICE_CONFIG.fallbackConfiguration.iceServers ?? []),
    },
  });
  return {
    configuration: PUBLIC_ICE_CONFIG.fallbackConfiguration,
    turnConfigured: PUBLIC_ICE_CONFIG.hasStaticTurn,
  };
}
