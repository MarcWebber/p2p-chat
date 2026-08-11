import type { EncryptedWire } from "@/src/chat/types";
import { CHAT_POLICY } from "@/src/config/policy";

type ChunkPacket = {
  type: "chunk";
  id: string;
  index: number;
  total: number;
  data: string;
};

export function encodeEncryptedWire(wire: EncryptedWire) {
  const serialized = JSON.stringify(wire);
  const total = Math.ceil(serialized.length / CHAT_POLICY.encryptedChunkCharacters);
  return Array.from({ length: total }, (_, index) => JSON.stringify({
    type: "chunk",
    id: wire.id,
    index,
    total,
    data: serialized.slice(
      index * CHAT_POLICY.encryptedChunkCharacters,
      (index + 1) * CHAT_POLICY.encryptedChunkCharacters,
    ),
  } satisfies ChunkPacket));
}

export class EncryptedWireAssembler {
  private readonly chunks = new Map<string, { parts: string[]; total: number }>();

  accept(serializedPacket: string) {
    const packet = JSON.parse(serializedPacket) as ChunkPacket;
    if (packet.type !== "chunk") return null;
    const current = this.chunks.get(packet.id) ?? {
      parts: Array<string>(packet.total),
      total: packet.total,
    };
    current.parts[packet.index] = packet.data;
    this.chunks.set(packet.id, current);
    if (current.parts.filter(Boolean).length !== current.total) return null;
    this.chunks.delete(packet.id);
    return JSON.parse(current.parts.join("")) as EncryptedWire;
  }

  clear() {
    this.chunks.clear();
  }
}
