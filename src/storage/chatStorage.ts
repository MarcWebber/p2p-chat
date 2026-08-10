import type { EncryptedWire } from "@/src/chat/types";

const MAX_STORED_MESSAGES = 200;

export function getMessageStorageKey(roomId: string) {
  return `twoonly:${roomId}:messages`;
}

export function loadEncryptedHistory(roomId: string): EncryptedWire[] {
  if (!roomId) return [];
  try {
    const value = JSON.parse(localStorage.getItem(getMessageStorageKey(roomId)) ?? "[]") as unknown;
    return Array.isArray(value) ? value as EncryptedWire[] : [];
  } catch {
    return [];
  }
}

export function persistEncryptedMessage(roomId: string, wire: EncryptedWire) {
  const storageKey = getMessageStorageKey(roomId);
  const existing = loadEncryptedHistory(roomId);
  if (existing.some((item) => item.id === wire.id)) return;
  localStorage.setItem(storageKey, JSON.stringify([...existing, wire].slice(-MAX_STORED_MESSAGES)));
}

export function clearEncryptedHistory(roomId: string) {
  if (roomId) localStorage.removeItem(getMessageStorageKey(roomId));
}

function getSentMessageStorageKey(roomId: string) {
  return `twoonly:${roomId}:sent-message-ids:v2`;
}

function loadSentMessageIds(roomId: string) {
  try {
    const value = JSON.parse(sessionStorage.getItem(getSentMessageStorageKey(roomId)) ?? "[]") as unknown;
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export function markMessageAsSent(roomId: string, messageId: string) {
  const existing = loadSentMessageIds(roomId);
  if (existing.includes(messageId)) return;
  sessionStorage.setItem(
    getSentMessageStorageKey(roomId),
    JSON.stringify([...existing, messageId].slice(-MAX_STORED_MESSAGES)),
  );
}

export function wasMessageSentByThisTab(roomId: string, messageId: string) {
  return loadSentMessageIds(roomId).includes(messageId);
}
