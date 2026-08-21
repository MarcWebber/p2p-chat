import { SIGNAL_POLICY, SIGNAL_REJECTION_REASON } from "@/src/config/policy";
import type { ConnectionDiagnosticSink } from "@/src/diagnostics/connectionDiagnostics";
import { isRecord } from "@/src/utils/guards";

const PUBLIC_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export type SignalMembershipProof = {
  memberId: string;
  publicKey: string;
  signature: string;
};

type SignalBase = {
  protocol: typeof SIGNAL_POLICY.protocolVersion;
  from: string;
  fromEpoch: number;
  member: SignalMembershipProof;
  signalId: string;
  sentAt: number;
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
  reason: typeof SIGNAL_REJECTION_REASON[keyof typeof SIGNAL_REJECTION_REASON];
};

export type SignalMessage =
  | HelloSignal
  | OfferSignal
  | AnswerSignal
  | CandidateSignal
  | RejectedSignal;

export type RoutedSignalMessage = SignalMessage & {
  signalId: string;
  sentAt: number;
};

type DistributiveOmit<Value, Keys extends PropertyKey> = Value extends unknown
  ? Omit<Value, Keys>
  : never;

export type UnsignedSignalMessage = DistributiveOmit<SignalMessage, "member">;

export type OutgoingSignal<Message extends SignalMessage = SignalMessage> = Message extends SignalMessage
  ? Omit<Message, "protocol" | "from" | "fromEpoch" | "member" | "signalId" | "sentAt">
  : never;

function isPositiveEpoch(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function hasValidMembership(value: unknown): value is SignalMembershipProof {
  if (!isRecord(value)) return false;
  return isPublicSignalId(value.memberId)
    && typeof value.publicKey === "string"
    && value.publicKey.length >= 80
    && value.publicKey.length <= 512
    && PUBLIC_ID_PATTERN.test(value.publicKey)
    && typeof value.signature === "string"
    && value.signature.length >= 64
    && value.signature.length <= 256
    && PUBLIC_ID_PATTERN.test(value.signature);
}

export function isPublicSignalId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
    && value.length <= SIGNAL_POLICY.maxIdLength && PUBLIC_ID_PATTERN.test(value);
}

function hasValidTarget(signal: Record<string, unknown>) {
  return isPublicSignalId(signal.to)
    && isPositiveEpoch(signal.toEpoch);
}

function isDescriptionPayload(value: unknown, type: "offer" | "answer") {
  if (!isRecord(value)) return false;
  const description = value;
  return description.type === type
    && typeof description.sdp === "string"
    && description.sdp.length > 0
    && description.sdp.length <= SIGNAL_POLICY.maxSdpLength;
}

function isCandidatePayload(value: unknown) {
  if (!isRecord(value)) return false;
  const candidate = value;
  return typeof candidate.candidate === "string"
    && candidate.candidate.length <= SIGNAL_POLICY.maxCandidateLength
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
  if (!isRecord(value)) return false;
  const signal = value;
  if (
    signal.protocol !== SIGNAL_POLICY.protocolVersion
    || !isPublicSignalId(signal.from)
    || !isPositiveEpoch(signal.fromEpoch)
    || !hasValidMembership(signal.member)
    || !isPublicSignalId(signal.signalId)
    || !isPositiveEpoch(signal.sentAt)
  ) return false;

  if (signal.type === "hello") {
    const validRoute = (signal.to === undefined && signal.toEpoch === undefined)
      || hasValidTarget(signal);
    return validRoute && (signal.restart === undefined || typeof signal.restart === "boolean");
  }

  if (signal.type === "rejected") {
    return hasValidTarget(signal)
      && (
        signal.reason === SIGNAL_REJECTION_REASON.roomFull
        || signal.reason === SIGNAL_REJECTION_REASON.memberLocked
      );
  }

  if (signal.type !== "offer" && signal.type !== "answer" && signal.type !== "candidate") {
    return false;
  }

  if (!hasValidTarget(signal) || !isPublicSignalId(signal.negotiationId)) return false;
  if (signal.type === "offer") return isDescriptionPayload(signal.payload, "offer");
  if (signal.type === "answer") return isDescriptionPayload(signal.payload, "answer");
  return isCandidatePayload(signal.payload);
}

export function isRoutedSignalMessage(value: unknown): value is RoutedSignalMessage {
  return isSignalMessage(value)
    && isPublicSignalId(value.signalId)
    && isPositiveEpoch(value.sentAt);
}

export type SignalProviderName = "supabase" | "https";
export type SignalProviderState = "connecting" | "ready" | "unavailable";

export type SignalProviderOptions = {
  roomId: string;
  onMessage: (value: unknown) => void;
  onState: (state: SignalProviderState) => void;
  onDiagnostic: ConnectionDiagnosticSink;
};

export type SignalProvider = {
  name: SignalProviderName;
  start: () => void;
  send: (message: RoutedSignalMessage) => void;
  setNegotiationActive?: (active: boolean) => void;
  dispose: () => void;
};
