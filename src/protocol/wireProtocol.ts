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
  if (serialized.length > CHAT_POLICY.maxEncryptedWireCharacters) {
    throw new Error("encrypted wire exceeds the supported size");
  }
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
  private readonly chunks = new Map<string, {
    parts: Array<string | undefined>;
    total: number;
    received: number;
    characters: number;
  }>();

  accept(serializedPacket: string) {
    const packet = JSON.parse(serializedPacket) as Partial<ChunkPacket>;
    const maxPackets = Math.ceil(
      CHAT_POLICY.maxEncryptedWireCharacters / CHAT_POLICY.encryptedChunkCharacters,
    );
    if (
      packet.type !== "chunk"
      || typeof packet.id !== "string"
      || packet.id.length < 1
      || packet.id.length > 128
      || typeof packet.index !== "number"
      || !Number.isSafeInteger(packet.index)
      || packet.index < 0
      || typeof packet.total !== "number"
      || !Number.isSafeInteger(packet.total)
      || packet.total < 1
      || packet.total > maxPackets
      || packet.index >= packet.total
      || typeof packet.data !== "string"
      || packet.data.length > CHAT_POLICY.encryptedChunkCharacters
    ) throw new Error("invalid encrypted wire chunk");

    let current = this.chunks.get(packet.id);
    if (!current) {
      if (this.chunks.size >= CHAT_POLICY.maxConcurrentWireAssemblies) {
        throw new Error("too many concurrent encrypted wires");
      }
      current = {
        parts: Array<string | undefined>(packet.total),
        total: packet.total,
        received: 0,
        characters: 0,
      };
      this.chunks.set(packet.id, current);
    }
    if (current.total !== packet.total) throw new Error("inconsistent encrypted wire chunks");
    if (current.parts[packet.index] === undefined) {
      current.parts[packet.index] = packet.data;
      current.received += 1;
      current.characters += packet.data.length;
    } else if (current.parts[packet.index] !== packet.data) {
      throw new Error("conflicting encrypted wire chunk");
    }
    if (current.characters > CHAT_POLICY.maxEncryptedWireCharacters) {
      this.chunks.delete(packet.id);
      throw new Error("encrypted wire exceeds the supported size");
    }
    this.chunks.set(packet.id, current);
    if (current.received !== current.total) return null;
    this.chunks.delete(packet.id);
    return JSON.parse(current.parts.join("")) as EncryptedWire;
  }

  clear() {
    this.chunks.clear();
  }
}
