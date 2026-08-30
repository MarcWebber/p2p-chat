import { SIGNAL_POLICY } from "@/src/config/policy";
import type { AesGcmEnvelope } from "@/src/crypto/aesGcm";
import { isPublicSignalId } from "@/src/signal/types";
import { isRecord } from "@/src/utils/guards";

const CURSOR_PATTERN = /^\d+-\d+$/;

export const HTTPS_SIGNAL_ERROR_LEVEL = {
  recoverable: "recoverable",
  terminal: "terminal",
} as const;

export type HttpsSignalErrorLevel = typeof HTTPS_SIGNAL_ERROR_LEVEL[keyof typeof HTTPS_SIGNAL_ERROR_LEVEL];

export type HttpsSignalErrorCode =
  | "client_upgrade_required"
  | "cross_origin_request"
  | "invalid_content_type"
  | "invalid_json"
  | "invalid_signal_request"
  | "payload_too_large"
  | "signal_fallback_not_configured"
  | "signal_fallback_unavailable";

const HTTPS_SIGNAL_ERROR_CODES = [
  "client_upgrade_required",
  "cross_origin_request",
  "invalid_content_type",
  "invalid_json",
  "invalid_signal_request",
  "payload_too_large",
  "signal_fallback_not_configured",
  "signal_fallback_unavailable",
] as const satisfies readonly HttpsSignalErrorCode[];

export type HttpsSignalClientError = {
  code: HttpsSignalErrorCode;
  level: HttpsSignalErrorLevel;
  retryable: boolean;
  message: string;
  expectedProtocol?: number;
  receivedProtocol?: number;
};

export type HttpsSignalErrorResponse = {
  error: HttpsSignalClientError;
  requestId: string;
};

export type HttpsSignalPublishRequest = {
  action: "publish";
  protocol: typeof SIGNAL_POLICY.protocolVersion;
  roomId: string;
  senderId: string;
  signalId: string;
  payload: AesGcmEnvelope;
};

export type HttpsSignalPollRequest = {
  action: "poll";
  protocol: typeof SIGNAL_POLICY.protocolVersion;
  roomId: string;
  participantId: string;
  cursor: string;
};

export type HttpsSignalEvent = Omit<HttpsSignalPublishRequest, "action" | "protocol" | "roomId"> & {
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
    && value.protocol === SIGNAL_POLICY.protocolVersion
    && isPublicSignalId(value.roomId)
    && isPublicSignalId(value.senderId)
    && isPublicSignalId(value.signalId)
    && isEncryptedPayload(value.payload);
}

export function isHttpsSignalPollRequest(value: unknown): value is HttpsSignalPollRequest {
  return isRecord(value) && value.action === "poll"
    && value.protocol === SIGNAL_POLICY.protocolVersion
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

export function isHttpsSignalActionRequest(value: unknown): value is Record<string, unknown> & {
  action: "publish" | "poll";
} {
  return isRecord(value) && (value.action === "publish" || value.action === "poll");
}

export function isHttpsSignalErrorResponse(value: unknown): value is HttpsSignalErrorResponse {
  if (!isRecord(value) || !isRecord(value.error) || typeof value.requestId !== "string") return false;
  const { error } = value;
  return typeof error.code === "string"
    && HTTPS_SIGNAL_ERROR_CODES.includes(error.code as HttpsSignalErrorCode)
    && typeof error.message === "string"
    && typeof error.retryable === "boolean"
    && (
      (error.level === HTTPS_SIGNAL_ERROR_LEVEL.recoverable && error.retryable)
      || (error.level === HTTPS_SIGNAL_ERROR_LEVEL.terminal && !error.retryable)
    );
}
