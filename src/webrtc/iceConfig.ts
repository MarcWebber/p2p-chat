const splitIceUrls = (value: string | undefined, fallback: string[]) =>
  value?.split(",").map((item) => item.trim()).filter(Boolean) ?? fallback;

const turnUrls = splitIceUrls(process.env.NEXT_PUBLIC_TURN_URLS, []);
const turnUsername = process.env.NEXT_PUBLIC_TURN_USERNAME;
const turnCredential = process.env.NEXT_PUBLIC_TURN_CREDENTIAL;

export const HAS_TURN_CONFIGURATION = Boolean(
  turnUrls.length && turnUsername && turnCredential,
);

export const ICE_CONFIGURATION: RTCConfiguration = {
  iceServers: [
    {
      urls: splitIceUrls(process.env.NEXT_PUBLIC_STUN_URLS, [
        "stun:stun.cloudflare.com:3478",
        "stun:stun.l.google.com:19302",
      ]),
    },
    ...(HAS_TURN_CONFIGURATION && turnUsername && turnCredential
      ? [{ urls: turnUrls, username: turnUsername, credential: turnCredential }]
      : []),
  ],
  iceCandidatePoolSize: 4,
};
