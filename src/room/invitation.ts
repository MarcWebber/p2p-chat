import type { Role } from "@/src/chat/types";
import { randomToken } from "@/src/crypto/messageCrypto";

export type RoomInvitation = {
  roomId: string;
  role: Role;
  secret: string;
};

function isRole(value: string | null): value is Role {
  return value === "host" || value === "guest";
}

export function readRoomInvitation(location: Location): RoomInvitation | null {
  const params = new URLSearchParams(location.search);
  const roomId = params.get("room") ?? "";
  const role = params.get("role");
  const secret = location.hash.slice(1);
  if (!roomId || !secret || !isRole(role)) return null;
  return { roomId, role, secret };
}

export function createHostRoom(): RoomInvitation {
  return {
    roomId: randomToken(9),
    role: "host",
    secret: randomToken(32),
  };
}

export function createRoomUrl(origin: string, invitation: RoomInvitation) {
  return `${origin}/?room=${invitation.roomId}&role=${invitation.role}#${invitation.secret}`;
}

export function createGuestInviteUrl(origin: string, roomId: string, secret: string) {
  return createRoomUrl(origin, { roomId, secret, role: "guest" });
}
