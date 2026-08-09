import type { EncryptedWire, Role } from "@/src/chat/types";

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

function getSenderStorageKey(roomId: string, role: Role) {
  return `twoonly:${roomId}:${role}:sender`;
}

export function getOrCreateSenderId(roomId: string, role: Role, createId: () => string) {
  const storageKey = getSenderStorageKey(roomId, role);
  const existing = sessionStorage.getItem(storageKey);
  if (existing) return existing;
  const senderId = createId();
  sessionStorage.setItem(storageKey, senderId);
  return senderId;
}

export function saveSenderId(roomId: string, role: Role, senderId: string) {
  sessionStorage.setItem(getSenderStorageKey(roomId, role), senderId);
}
