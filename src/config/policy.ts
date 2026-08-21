export const ROOM_POLICY = {
  roomIdBytes: 9,
  secretBytes: 32,
  participantIdBytes: 12,
  participantIdPrefix: "peer-",
} as const;

export const CHAT_POLICY = {
  maxImageBytes: 100_000_000,
  maxFileBytes: 100_000_000,
  maxInlineAttachmentBytes: 1_500_000,
  maxAudioBytes: 1_500_000,
  maxStickerBytes: 1_500_000,
  maxAvatarSourceBytes: 12_000_000,
  attachmentChunkBytes: 192_000,
  encryptedChunkCharacters: 12_000,
  maxEncryptedWireCharacters: 4_000_000,
  maxConcurrentWireAssemblies: 8,
  dataChannelHighWaterMarkBytes: 4_000_000,
  dataChannelLowWaterMarkBytes: 1_000_000,
  dataChannelDrainTimeoutMs: 120_000,
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
  protocolVersion: 3,
  maxIdLength: 128,
  maxSdpLength: 1_000_000,
  maxCandidateLength: 8_192,
  realtimeEvent: "signal",
  httpsEndpoint: "/api/signal",
  httpsRequestIdHeader: "X-TwoOnly-Signal-Request-Id",
  httpsPollIntervalMs: 1_200,
  httpsRequestTimeoutMs: 10_000,
  httpsHelloIntervalMs: 5_000,
  httpsReplayWindowMs: 15_000,
  httpsQueueTtlSeconds: 180,
  httpsQueueMaxEvents: 128,
  httpsMaxRequestCharacters: 1_500_000,
  maxDedupeEntries: 512,
} as const;

export const SIGNAL_REJECTION_REASON = {
  roomFull: "room-full",
  memberLocked: "member-locked",
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
  httpsSignalStreamPrefix: "twoonly:https-signal:",
  dataChannel: "twoonly-messages",
} as const;
