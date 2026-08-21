import type {
  ChatMessage,
  MessageKind,
  MessageReplyReference,
} from "@/src/chat/types";

const MAX_MESSAGE_ID_CHARACTERS = 128;
const MAX_NICKNAME_CHARACTERS = 64;
const MAX_PREVIEW_CHARACTERS = 160;

function isMessageKind(value: unknown): value is MessageKind {
  return value === "text" || value === "image" || value === "audio" || value === "file";
}

function shorten(value: string) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= MAX_PREVIEW_CHARACTERS) return normalized;
  return `${normalized.slice(0, MAX_PREVIEW_CHARACTERS - 1)}…`;
}

function messagePreview(message: ChatMessage) {
  if (message.kind === "image") return "[图片]";
  if (message.kind === "audio") return "[语音]";
  if (message.kind === "file") return `[文件 · ${shorten(message.fileName || "未命名文件")}]`;
  return shorten(message.content) || "[空消息]";
}

export function createMessageReplyReference(
  message: ChatMessage,
  fallbackNickname: string,
): MessageReplyReference {
  const messageNickname = shorten(message.profile?.nickname || "");
  const fallback = shorten(fallbackNickname) || "对方";
  const nickname = (messageNickname || fallback).slice(0, MAX_NICKNAME_CHARACTERS);
  return {
    messageId: message.id,
    kind: message.kind,
    nickname,
    preview: messagePreview(message),
  };
}

export function isMessageReplyReference(value: unknown): value is MessageReplyReference {
  if (!value || typeof value !== "object") return false;
  const reply = value as Partial<MessageReplyReference>;
  return typeof reply.messageId === "string"
    && reply.messageId.length > 0
    && reply.messageId.length <= MAX_MESSAGE_ID_CHARACTERS
    && isMessageKind(reply.kind)
    && typeof reply.nickname === "string"
    && reply.nickname.length > 0
    && reply.nickname.length <= MAX_NICKNAME_CHARACTERS
    && typeof reply.preview === "string"
    && reply.preview.length > 0
    && reply.preview.length <= MAX_PREVIEW_CHARACTERS + 16;
}
