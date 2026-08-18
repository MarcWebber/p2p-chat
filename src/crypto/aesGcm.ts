const encoder = new TextEncoder();
const decoder = new TextDecoder();

export type AesGcmEnvelope = {
  iv: string;
  data: string;
};

export function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function randomBase64Url(size: number) {
  return bytesToBase64(crypto.getRandomValues(new Uint8Array(size)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

export function createJsonCipher(secret: string) {
  const key = crypto.subtle.digest("SHA-256", encoder.encode(secret)).then((digest) =>
    crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]),
  );

  return {
    async encrypt(value: unknown): Promise<AesGcmEnvelope> {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const plaintext = encoder.encode(JSON.stringify(value));
      const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key, plaintext);
      return { iv: bytesToBase64(iv), data: bytesToBase64(new Uint8Array(encrypted)) };
    },

    async decrypt(envelope: AesGcmEnvelope): Promise<unknown> {
      const decrypted = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: base64ToBytes(envelope.iv) },
        await key,
        base64ToBytes(envelope.data),
      );
      return JSON.parse(decoder.decode(decrypted)) as unknown;
    },
  };
}
