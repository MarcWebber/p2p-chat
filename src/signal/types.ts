export const SIGNAL_PROTOCOL_VERSION = 2 as const;

type SignalBase = {
  protocol: typeof SIGNAL_PROTOCOL_VERSION;
  from: string;
  fromEpoch: number;
};

export type HelloSignal = SignalBase & {
  type: "hello";
  to?: string;
  toEpoch?: number;
  restart?: boolean;
};

type NegotiationSignalBase = SignalBase & {
  to: string;
  toEpoch: number;
  negotiationId: string;
};

export type OfferSignal = NegotiationSignalBase & {
  type: "offer";
  payload: RTCSessionDescriptionInit;
};

export type AnswerSignal = NegotiationSignalBase & {
  type: "answer";
  payload: RTCSessionDescriptionInit;
};

export type CandidateSignal = NegotiationSignalBase & {
  type: "candidate";
  payload: RTCIceCandidateInit;
};

type RejectedSignal = SignalBase & {
  type: "rejected";
  to: string;
  toEpoch: number;
  reason: "room-full" | "protocol";
};

export type SignalMessage =
  | HelloSignal
  | OfferSignal
  | AnswerSignal
  | CandidateSignal
  | RejectedSignal;

export type OutgoingSignal<Message extends SignalMessage = SignalMessage> = Message extends SignalMessage
  ? Omit<Message, "protocol" | "from" | "fromEpoch">
  : never;

function isPositiveEpoch(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function isBoundedId(value: unknown, maxLength = 128): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function hasValidTarget(signal: Record<string, unknown>) {
  return isBoundedId(signal.to)
    && isPositiveEpoch(signal.toEpoch);
}

function isDescriptionPayload(value: unknown, type: "offer" | "answer") {
  if (!value || typeof value !== "object") return false;
  const description = value as Record<string, unknown>;
  return description.type === type
    && typeof description.sdp === "string"
    && description.sdp.length > 0
    && description.sdp.length <= 1_000_000;
}

function isCandidatePayload(value: unknown) {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.candidate === "string"
    && candidate.candidate.length <= 8_192
    && (candidate.sdpMid === undefined || candidate.sdpMid === null || typeof candidate.sdpMid === "string")
    && (
      candidate.sdpMLineIndex === undefined
      || candidate.sdpMLineIndex === null
      || Number.isSafeInteger(candidate.sdpMLineIndex)
    )
    && (
      candidate.usernameFragment === undefined
      || candidate.usernameFragment === null
      || typeof candidate.usernameFragment === "string"
    );
}

export function isSignalMessage(value: unknown): value is SignalMessage {
  if (!value || typeof value !== "object") return false;
  const signal = value as Record<string, unknown>;
  if (
    signal.protocol !== SIGNAL_PROTOCOL_VERSION
    || !isBoundedId(signal.from)
    || !isPositiveEpoch(signal.fromEpoch)
  ) return false;

  if (signal.type === "hello") {
    const validRoute = (signal.to === undefined && signal.toEpoch === undefined)
      || hasValidTarget(signal);
    return validRoute && (signal.restart === undefined || typeof signal.restart === "boolean");
  }

  if (signal.type === "rejected") {
    return hasValidTarget(signal)
      && (signal.reason === "room-full" || signal.reason === "protocol");
  }

  if (signal.type !== "offer" && signal.type !== "answer" && signal.type !== "candidate") {
    return false;
  }

  if (!hasValidTarget(signal) || !isBoundedId(signal.negotiationId)) return false;
  if (signal.type === "offer") return isDescriptionPayload(signal.payload, "offer");
  if (signal.type === "answer") return isDescriptionPayload(signal.payload, "answer");
  return isCandidatePayload(signal.payload);
}

export function isLegacySignalMessage(value: unknown) {
  if (!value || typeof value !== "object") return false;
  const signal = value as Record<string, unknown>;
  return signal.protocol === undefined
    && isBoundedId(signal.from)
    && (signal.type === "hello"
      || signal.type === "offer"
      || signal.type === "answer"
      || signal.type === "candidate"
      || signal.type === "rejected");
}
