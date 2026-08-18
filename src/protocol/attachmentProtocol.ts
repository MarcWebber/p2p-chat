import type { AttachmentMessageKind, ChatProfile } from "@/src/chat/types";
import { CHAT_POLICY } from "@/src/config/policy";
import { base64ToBytes, bytesToBase64 } from "@/src/crypto/aesGcm";

const ATTACHMENT_PROTOCOL = "twoonly-attachment-v1" as const;
const MAX_FILE_NAME_CHARACTERS = 512;
const MAX_MIME_TYPE_CHARACTERS = 160;
const MAX_PROFILE_TEXT_CHARACTERS = 1_000_000;

export type AttachmentDescriptor = {
  id: string;
  kind: AttachmentMessageKind;
  createdAt: number;
  fileName: string;
  fileSize: number;
  mimeType: string;
  profile: ChatProfile;
};

export type AttachmentStartPayload = {
  protocol: typeof ATTACHMENT_PROTOCOL;
  type: "attachment-start";
  transferId: string;
  total: number;
  descriptor: AttachmentDescriptor;
};

export type AttachmentChunkPayload = {
  protocol: typeof ATTACHMENT_PROTOCOL;
  type: "attachment-chunk";
  transferId: string;
  index: number;
  total: number;
  data: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function isValidProfile(value: unknown): value is ChatProfile {
  if (!isRecord(value)) return false;
  return typeof value.nickname === "string"
    && value.nickname.length > 0
    && value.nickname.length <= MAX_PROFILE_TEXT_CHARACTERS
    && typeof value.avatar === "string"
    && value.avatar.length > 0
    && value.avatar.length <= MAX_PROFILE_TEXT_CHARACTERS;
}

function maxBytesForKind(kind: AttachmentMessageKind) {
  return kind === "image" ? CHAT_POLICY.maxImageBytes : CHAT_POLICY.maxFileBytes;
}

export function attachmentChunkCount(fileSize: number) {
  return Math.max(1, Math.ceil(fileSize / CHAT_POLICY.attachmentChunkBytes));
}

export function createAttachmentStartPayload(
  descriptor: AttachmentDescriptor,
): AttachmentStartPayload {
  return {
    protocol: ATTACHMENT_PROTOCOL,
    type: "attachment-start",
    transferId: descriptor.id,
    total: attachmentChunkCount(descriptor.fileSize),
    descriptor,
  };
}

export async function createAttachmentChunkPayload(
  transferId: string,
  file: Blob,
  index: number,
): Promise<AttachmentChunkPayload> {
  const total = attachmentChunkCount(file.size);
  const start = index * CHAT_POLICY.attachmentChunkBytes;
  const bytes = new Uint8Array(await file.slice(
    start,
    Math.min(start + CHAT_POLICY.attachmentChunkBytes, file.size),
  ).arrayBuffer());
  return {
    protocol: ATTACHMENT_PROTOCOL,
    type: "attachment-chunk",
    transferId,
    index,
    total,
    data: bytesToBase64(bytes),
  };
}

export function isAttachmentStartPayload(value: unknown): value is AttachmentStartPayload {
  if (!isRecord(value) || value.protocol !== ATTACHMENT_PROTOCOL || value.type !== "attachment-start") {
    return false;
  }
  if (typeof value.transferId !== "string" || value.transferId.length < 1 || value.transferId.length > 128) {
    return false;
  }
  if (!Number.isSafeInteger(value.total) || Number(value.total) < 1) return false;
  const descriptor = value.descriptor;
  if (!isRecord(descriptor)) return false;
  const kind = descriptor.kind;
  if (kind !== "image" && kind !== "file") return false;
  if (
    descriptor.id !== value.transferId
    || typeof descriptor.createdAt !== "number"
    || !Number.isFinite(descriptor.createdAt)
    || typeof descriptor.fileName !== "string"
    || descriptor.fileName.length < 1
    || descriptor.fileName.length > MAX_FILE_NAME_CHARACTERS
    || typeof descriptor.fileSize !== "number"
    || !Number.isSafeInteger(descriptor.fileSize)
    || descriptor.fileSize < 0
    || descriptor.fileSize > maxBytesForKind(kind)
    || typeof descriptor.mimeType !== "string"
    || descriptor.mimeType.length > MAX_MIME_TYPE_CHARACTERS
    || !isValidProfile(descriptor.profile)
  ) return false;
  return value.total === attachmentChunkCount(descriptor.fileSize);
}

export function isAttachmentChunkPayload(value: unknown): value is AttachmentChunkPayload {
  if (!isRecord(value) || value.protocol !== ATTACHMENT_PROTOCOL || value.type !== "attachment-chunk") {
    return false;
  }
  const maxChunks = attachmentChunkCount(Math.max(CHAT_POLICY.maxImageBytes, CHAT_POLICY.maxFileBytes));
  const maxDataCharacters = Math.ceil(CHAT_POLICY.attachmentChunkBytes / 3) * 4;
  return typeof value.transferId === "string"
    && value.transferId.length > 0
    && value.transferId.length <= 128
    && Number.isSafeInteger(value.index)
    && Number(value.index) >= 0
    && Number.isSafeInteger(value.total)
    && Number(value.total) >= 1
    && Number(value.total) <= maxChunks
    && Number(value.index) < Number(value.total)
    && typeof value.data === "string"
    && value.data.length <= maxDataCharacters;
}

export function decodeAttachmentChunk(
  payload: AttachmentChunkPayload,
  fileSize: number,
) {
  const bytes = base64ToBytes(payload.data);
  const start = payload.index * CHAT_POLICY.attachmentChunkBytes;
  const expectedBytes = Math.max(0, Math.min(CHAT_POLICY.attachmentChunkBytes, fileSize - start));
  if (bytes.byteLength !== expectedBytes) throw new Error("invalid attachment chunk size");
  return bytes;
}
