import { RTC_POLICY } from "@/src/config/policy";

const commaSeparated = (value: string | undefined, fallback: readonly string[]) =>
  value?.split(",").map((item) => item.trim()).filter(Boolean) ?? [...fallback];

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

export const PUBLIC_SIGNAL_CONFIG = supabaseUrl && supabaseKey
  ? { enabled: true, url: supabaseUrl, key: supabaseKey } as const
  : { enabled: false, url: null, key: null } as const;

const turnUrls = commaSeparated(process.env.NEXT_PUBLIC_TURN_URLS, []);
const turnUsername = process.env.NEXT_PUBLIC_TURN_USERNAME;
const turnCredential = process.env.NEXT_PUBLIC_TURN_CREDENTIAL;
const staticTurnServer: RTCIceServer | null = turnUrls.length && turnUsername && turnCredential
  ? { urls: turnUrls, username: turnUsername, credential: turnCredential }
  : null;
const transportPolicy: RTCIceTransportPolicy =
  process.env.NEXT_PUBLIC_ICE_TRANSPORT_POLICY === "relay" ? "relay" : "all";

export const PUBLIC_ICE_CONFIG = {
  transportPolicy,
  hasStaticTurn: Boolean(staticTurnServer),
  fallbackConfiguration: {
    iceServers: [
      { urls: commaSeparated(process.env.NEXT_PUBLIC_STUN_URLS, RTC_POLICY.defaultStunUrls) },
      ...(staticTurnServer ? [staticTurnServer] : []),
    ],
    iceCandidatePoolSize: RTC_POLICY.iceCandidatePoolSize,
    iceTransportPolicy: transportPolicy,
  } satisfies RTCConfiguration,
} as const;
