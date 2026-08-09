export type SignalMessage = {
  type: "hello" | "offer" | "answer" | "candidate" | "rejected";
  from: string;
  to?: string;
  restart?: boolean;
  negotiationId?: string;
  payload?: RTCSessionDescriptionInit | RTCIceCandidateInit;
};

export type OutgoingSignal = Omit<SignalMessage, "from">;

export type SignalStatus = "subscribed" | "unavailable";

const signalTypes = new Set<SignalMessage["type"]>([
  "hello",
  "offer",
  "answer",
  "candidate",
  "rejected",
]);

export function isSignalMessage(value: unknown): value is SignalMessage {
  if (!value || typeof value !== "object") return false;
  const signal = value as Partial<SignalMessage>;
  return typeof signal.type === "string"
    && signalTypes.has(signal.type as SignalMessage["type"])
    && typeof signal.from === "string"
    && (!signal.to || typeof signal.to === "string");
}
