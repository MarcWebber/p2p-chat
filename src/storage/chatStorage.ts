import type { EncryptedWire } from "@/src/chat/types";

const MAX_STORED_MESSAGES = 200;

function getMessageStorageKey(roomId: string) {
  return `twoonly:${roomId}:messages`;
}

function loadArray(storage: Storage, key: string) {
  try {
    const value = JSON.parse(storage.getItem(key) ?? "[]") as unknown;
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

export function loadEncryptedHistory(roomId: string): EncryptedWire[] {
  return roomId ? loadArray(localStorage, getMessageStorageKey(roomId)) as EncryptedWire[] : [];
}

export function persistEncryptedMessage(roomId: string, wire: EncryptedWire) {
  try {
    const existing = loadEncryptedHistory(roomId);
    if (!existing.some((item) => item.id === wire.id)) {
      localStorage.setItem(
        getMessageStorageKey(roomId),
        JSON.stringify([...existing, wire].slice(-MAX_STORED_MESSAGES)),
      );
    }
    return true;
  } catch {
    return false;
  }
}

export function clearEncryptedHistory(roomId: string) {
  if (roomId) localStorage.removeItem(getMessageStorageKey(roomId));
}

function getSentMessageStorageKey(roomId: string) {
  return `twoonly:${roomId}:sent-message-ids:v2`;
}

function loadSentMessageIds(roomId: string) {
  return loadArray(sessionStorage, getSentMessageStorageKey(roomId))
    .filter((item): item is string => typeof item === "string");
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
