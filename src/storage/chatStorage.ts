import type { EncryptedWire } from "@/src/chat/types";
import { RESOURCE_NAMES, STORAGE_POLICY } from "@/src/config/policy";

function roomStorageKey(roomId: string, suffix: string) {
  return `${RESOURCE_NAMES.roomPrefix}${roomId}:${suffix}`;
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
  return roomId
    ? loadArray(localStorage, roomStorageKey(roomId, STORAGE_POLICY.messageHistorySuffix)) as EncryptedWire[]
    : [];
}

export function persistEncryptedMessage(roomId: string, wire: EncryptedWire) {
  try {
    const existing = loadEncryptedHistory(roomId);
    if (!existing.some((item) => item.id === wire.id)) {
      localStorage.setItem(
        roomStorageKey(roomId, STORAGE_POLICY.messageHistorySuffix),
        JSON.stringify([...existing, wire].slice(-STORAGE_POLICY.maxMessages)),
      );
    }
    return true;
  } catch {
    return false;
  }
}

export function clearEncryptedHistory(roomId: string) {
  if (roomId) localStorage.removeItem(roomStorageKey(roomId, STORAGE_POLICY.messageHistorySuffix));
}

function loadSentMessageIds(roomId: string) {
  return loadArray(sessionStorage, roomStorageKey(roomId, STORAGE_POLICY.sentMessageIdsSuffix))
    .filter((item): item is string => typeof item === "string");
}

export function markMessageAsSent(roomId: string, messageId: string) {
  const existing = loadSentMessageIds(roomId);
  if (existing.includes(messageId)) return;
  sessionStorage.setItem(
    roomStorageKey(roomId, STORAGE_POLICY.sentMessageIdsSuffix),
    JSON.stringify([...existing, messageId].slice(-STORAGE_POLICY.maxSentMessageIds)),
  );
}

export function wasMessageSentByThisTab(roomId: string, messageId: string) {
  return loadSentMessageIds(roomId).includes(messageId);
}
