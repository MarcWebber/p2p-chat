import type { LegacyRole } from "@/src/chat/types";
import { randomToken } from "@/src/crypto/messageCrypto";

export type RoomInvitation = {
  roomId: string;
  secret: string;
  legacyRole?: LegacyRole;
};

function isLegacyRole(value: string | null): value is LegacyRole {
  return value === "host" || value === "guest";
}

export function readRoomInvitation(location: Location): RoomInvitation | null {
  const params = new URLSearchParams(location.search);
  const roomId = params.get("room") ?? "";
  const secret = location.hash.slice(1);
  if (!roomId || !secret) return null;
  const role = params.get("role");
  return {
    roomId,
    secret,
    ...(isLegacyRole(role) ? { legacyRole: role } : {}),
  };
}

export function createRoomInvitation(): RoomInvitation {
  return {
    roomId: randomToken(9),
    secret: randomToken(32),
  };
}

export function createRoomUrl(origin: string, invitation: RoomInvitation) {
  return `${origin}/?room=${encodeURIComponent(invitation.roomId)}#${invitation.secret}`;
}
