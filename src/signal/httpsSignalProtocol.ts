import { SIGNAL_POLICY } from "@/src/config/policy";
import type { AesGcmEnvelope } from "@/src/crypto/aesGcm";
import { isPublicSignalId } from "@/src/signal/types";
import { isRecord } from "@/src/utils/guards";

const CURSOR_PATTERN = /^\d+-\d+$/;

export type HttpsSignalPublishRequest = {
  action: "publish";
  roomId: string;
  senderId: string;
  signalId: string;
  payload: AesGcmEnvelope;
};

export type HttpsSignalPollRequest = {
  action: "poll";
  roomId: string;
  participantId: string;
  cursor: string;
};

export type HttpsSignalEvent = Omit<HttpsSignalPublishRequest, "action" | "roomId"> & {
  cursor: string;
  publishedAt: number;
};

export type HttpsSignalPollResponse = {
  events: HttpsSignalEvent[];
  cursor: string;
};

export function isSignalCursor(value: unknown): value is string {
  return typeof value === "string" && CURSOR_PATTERN.test(value);
}

function isEncryptedPayload(value: unknown): value is AesGcmEnvelope {
  return isRecord(value)
    && typeof value.iv === "string" && value.iv.length > 0 && value.iv.length <= 64
    && typeof value.data === "string" && value.data.length > 0
    && value.data.length <= SIGNAL_POLICY.httpsMaxRequestCharacters;
}

export function isHttpsSignalPublishRequest(value: unknown): value is HttpsSignalPublishRequest {
  return isRecord(value) && value.action === "publish"
    && isPublicSignalId(value.roomId)
    && isPublicSignalId(value.senderId)
    && isPublicSignalId(value.signalId)
    && isEncryptedPayload(value.payload);
}

export function isHttpsSignalPollRequest(value: unknown): value is HttpsSignalPollRequest {
  return isRecord(value) && value.action === "poll"
    && isPublicSignalId(value.roomId)
    && isPublicSignalId(value.participantId)
    && isSignalCursor(value.cursor);
}

export function isHttpsSignalEvent(value: unknown): value is HttpsSignalEvent {
  return isRecord(value) && isPublicSignalId(value.senderId)
    && isPublicSignalId(value.signalId)
    && isSignalCursor(value.cursor)
    && Number.isSafeInteger(value.publishedAt) && Number(value.publishedAt) > 0
    && isEncryptedPayload(value.payload);
}

export function isHttpsSignalPollResponse(value: unknown): value is HttpsSignalPollResponse {
  if (!isRecord(value) || !isSignalCursor(value.cursor) || !Array.isArray(value.events)) return false;
  return value.events.length <= SIGNAL_POLICY.httpsQueueMaxEvents
    && value.events.every(isHttpsSignalEvent);
}
