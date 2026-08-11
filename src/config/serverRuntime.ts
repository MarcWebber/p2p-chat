import "server-only";

export const SERVER_RUNTIME_CONFIG = {
  siteUrl: process.env.NEXT_PUBLIC_SITE_URL
    ?? (process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
      : "https://twoonly-chat.vercel.app"),
  turn: {
    apiBase: "https://rtc.live.cloudflare.com/v1/turn/keys",
    credentialTtlSeconds: 86_400,
    providerTimeoutMs: 8_000,
    keyId: process.env.CLOUDFLARE_TURN_KEY_ID,
    apiToken: process.env.CLOUDFLARE_TURN_API_TOKEN,
  },
} as const;
