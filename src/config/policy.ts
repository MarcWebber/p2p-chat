export const ROOM_POLICY = {
  roomIdBytes: 9,
  secretBytes: 32,
  participantIdBytes: 12,
  participantIdPrefix: "peer-",
} as const;

export const CHAT_POLICY = {
  maxAttachmentBytes: 1_500_000,
  encryptedChunkCharacters: 12_000,
} as const;

export const STORAGE_POLICY = {
  maxMessages: 200,
  maxSentMessageIds: 200,
  messageHistorySuffix: "messages",
  sentMessageIdsSuffix: "sent-message-ids:v2",
} as const;

export const DIAGNOSTICS_POLICY = {
  maxEntries: 200,
  visibleEntries: 60,
  notifyDelayMs: 120,
  dedupeWindowMs: 30_000,
  logCopyFeedbackMs: 1_500,
  maxTextLength: 280,
  traceIdLength: 8,
  shortIdLength: 6,
} as const;

export const UI_POLICY = {
  inviteCopyFeedbackMs: 1_600,
} as const;

export const SIGNAL_POLICY = {
  protocolVersion: 2,
  maxIdLength: 128,
  maxSdpLength: 1_000_000,
  maxCandidateLength: 8_192,
  realtimeEvent: "signal",
} as const;

export const SIGNAL_REJECTION_REASON = {
  roomFull: "room-full",
  protocol: "protocol",
} as const;

export const RTC_POLICY = {
  credentialEndpoint: "/api/turn-credentials",
  requestIdHeader: "X-TwoOnly-Request-Id",
  credentialRequestTimeoutMs: 10_000,
  iceCandidatePoolSize: 4,
  defaultStunUrls: [
    "stun:stun.cloudflare.com:3478",
    "stun:stun.l.google.com:19302",
  ],
  reconnectDelayMs: 800,
  disconnectedGraceMs: 2_500,
  announceIntervalMs: 1_500,
  signalWarningDelayMs: 3_500,
  peerLockTimeoutMs: 10_000,
  offerResendDelayMs: 1_000,
  rejectBackoffMs: 5_000,
  maxPendingNegotiations: 2,
  maxPendingCandidates: 32,
} as const;

export const RESOURCE_NAMES = {
  roomPrefix: "twoonly:",
  dataChannel: "twoonly-messages",
} as const;
