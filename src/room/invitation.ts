import { ROOM_POLICY } from "@/src/config/policy";
import { randomToken } from "@/src/crypto/messageCrypto";

export type RoomInvitation = {
  roomId: string;
  secret: string;
};

export function readRoomInvitation(location: Location): RoomInvitation | null {
  const params = new URLSearchParams(location.search);
  const roomId = params.get("room") ?? "";
  const secret = location.hash.slice(1);
  if (!roomId || !secret) return null;
  return { roomId, secret };
}

export function createRoomInvitation(): RoomInvitation {
  return {
    roomId: randomToken(ROOM_POLICY.roomIdBytes),
    secret: randomToken(ROOM_POLICY.secretBytes),
  };
}

export function createParticipantId() {
  return `${ROOM_POLICY.participantIdPrefix}${randomToken(ROOM_POLICY.participantIdBytes)}`;
}

export function createRoomUrl(origin: string, invitation: RoomInvitation) {
  return `${origin}/?room=${encodeURIComponent(invitation.roomId)}#${invitation.secret}`;
}
