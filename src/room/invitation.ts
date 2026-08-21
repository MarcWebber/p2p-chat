import { ROOM_POLICY } from "@/src/config/policy";
import { randomToken } from "@/src/crypto/messageCrypto";
import { isEncodedMemberKey } from "@/src/room/memberIdentity";

export type RoomInvitation = {
  roomId: string;
  secret: string;
  ownerPublicKey?: string;
};

export function readRoomInvitation(location: Location): RoomInvitation | null {
  const params = new URLSearchParams(location.search);
  const roomId = params.get("room") ?? "";
  const fragment = location.hash.slice(1);
  const fragmentParams = fragment.startsWith("secret=")
    ? new URLSearchParams(fragment)
    : null;
  const secret = fragmentParams?.get("secret") ?? fragment;
  const ownerPublicKey = fragmentParams?.get("owner") ?? undefined;
  if (!roomId || !secret) return null;
  if (ownerPublicKey !== undefined && !isEncodedMemberKey(ownerPublicKey)) return null;
  return { roomId, secret, ownerPublicKey };
}

export function createRoomInvitation(ownerPublicKey?: string): RoomInvitation {
  return {
    roomId: randomToken(ROOM_POLICY.roomIdBytes),
    secret: randomToken(ROOM_POLICY.secretBytes),
    ownerPublicKey,
  };
}

export function createParticipantId() {
  return `${ROOM_POLICY.participantIdPrefix}${randomToken(ROOM_POLICY.participantIdBytes)}`;
}

export function createRoomUrl(origin: string, invitation: RoomInvitation) {
  const fragment = invitation.ownerPublicKey
    ? new URLSearchParams({
        secret: invitation.secret,
        owner: invitation.ownerPublicKey,
      }).toString()
    : invitation.secret;
  return `${origin}/?room=${encodeURIComponent(invitation.roomId)}#${fragment}`;
}
