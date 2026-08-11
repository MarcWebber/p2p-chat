import type { ChatMessage, EncryptedWire } from "@/src/chat/types";
import { createJsonCipher, randomBase64Url } from "@/src/crypto/aesGcm";

const safetyEmojis = ["🦊", "🌙", "🌿", "🫧", "🐋", "🍊", "🪐", "🪶"];

export function randomToken(size = 24) {
  return randomBase64Url(size);
}

export function createSafetyCode(secret: string) {
  let total = 0;
  for (const char of secret) total = (total * 31 + char.charCodeAt(0)) >>> 0;
  return `${safetyEmojis[total % safetyEmojis.length]} ${safetyEmojis[(total >>> 3) % safetyEmojis.length]} · ${String(total % 100).padStart(2, "0")}`;
}

export function createMessageCrypto(secret: string) {
  const cipher = createJsonCipher(secret);

  return {
    async encrypt(message: ChatMessage): Promise<EncryptedWire> {
      return { id: message.id, ...await cipher.encrypt(message) };
    },

    async decrypt(wire: EncryptedWire): Promise<ChatMessage> {
      return await cipher.decrypt(wire) as ChatMessage;
    },
  };
}
