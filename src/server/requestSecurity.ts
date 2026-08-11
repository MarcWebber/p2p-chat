import "server-only";

export function isSameOriginRequest(request: Request) {
  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const host = forwardedHost || request.headers.get("host");
  const forwardedProtocol = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const protocol = forwardedProtocol || new URL(request.url).protocol.replace(":", "");
  const requestOrigin = host ? `${protocol}://${host}` : new URL(request.url).origin;
  const origin = request.headers.get("origin");
  return (!origin || origin === requestOrigin)
    && request.headers.get("sec-fetch-site") !== "cross-site";
}
