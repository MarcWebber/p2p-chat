import type { ChatMessage, DecryptedChatMessage, EncryptedWire } from "@/src/chat/types";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const safetyEmojis = ["🦊", "🌙", "🌿", "🫧", "🐋", "🍊", "🪐", "🪶"];

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

function base64ToBytes(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function randomToken(size = 24) {
  return bytesToBase64(crypto.getRandomValues(new Uint8Array(size)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

export function createSafetyCode(secret: string) {
  let total = 0;
  for (const char of secret) total = (total * 31 + char.charCodeAt(0)) >>> 0;
  return `${safetyEmojis[total % safetyEmojis.length]} ${safetyEmojis[(total >>> 3) % safetyEmojis.length]} · ${String(total % 100).padStart(2, "0")}`;
}

export function createMessageCrypto(secret: string) {
  const key = crypto.subtle.digest("SHA-256", encoder.encode(secret)).then((digest) =>
    crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]),
  );

  return {
    async encrypt(message: ChatMessage): Promise<EncryptedWire> {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const plaintext = encoder.encode(JSON.stringify(message));
      const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key, plaintext);
      return {
        id: message.id,
        iv: bytesToBase64(iv),
        data: bytesToBase64(new Uint8Array(encrypted)),
      };
    },

    async decrypt(wire: EncryptedWire): Promise<DecryptedChatMessage> {
      const decrypted = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: base64ToBytes(wire.iv) },
        await key,
        base64ToBytes(wire.data),
      );
      return JSON.parse(decoder.decode(decrypted)) as DecryptedChatMessage;
    },
  };
}

export type MessageCrypto = ReturnType<typeof createMessageCrypto>;
