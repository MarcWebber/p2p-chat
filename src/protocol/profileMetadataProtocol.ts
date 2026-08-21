import type { ChatProfile, ProfileMetadata } from "@/src/chat/types";
import { CHAT_POLICY } from "@/src/config/policy";
import { isRecord } from "@/src/utils/guards";

const PROFILE_PROTOCOL = "twoonly-profile-v1" as const;
const MAX_ROOM_ID_CHARACTERS = 128;
const MAX_NICKNAME_CHARACTERS = 16;
const MAX_VERSION_ID_CHARACTERS = 128;

export type ProfileMetadataPayload = {
  protocol: typeof PROFILE_PROTOCOL;
  type: "profile-metadata";
  roomId: string;
  metadata: ProfileMetadata;
};

export function isChatProfile(value: unknown): value is ChatProfile {
  if (!isRecord(value)) return false;
  return typeof value.nickname === "string"
    && value.nickname === value.nickname.trim()
    && value.nickname.length > 0
    && value.nickname.length <= MAX_NICKNAME_CHARACTERS
    && typeof value.avatar === "string"
    && value.avatar.length > 0
    && value.avatar.length <= CHAT_POLICY.maxAvatarSourceBytes;
}

export function isProfileMetadata(value: unknown): value is ProfileMetadata {
  if (!isRecord(value)) return false;
  return isChatProfile(value.profile)
    && Number.isSafeInteger(value.revision)
    && Number(value.revision) >= 0
    && typeof value.versionId === "string"
    && value.versionId.length <= MAX_VERSION_ID_CHARACTERS
    && (Number(value.revision) === 0
      ? value.versionId.length === 0
      : value.versionId.length > 0);
}

export function compareProfileMetadataVersion(left: ProfileMetadata, right: ProfileMetadata) {
  if (left.revision !== right.revision) return left.revision - right.revision;
  if (left.versionId === right.versionId) return 0;
  return left.versionId > right.versionId ? 1 : -1;
}

export function createProfileMetadataPayload(
  roomId: string,
  metadata: ProfileMetadata,
): ProfileMetadataPayload {
  return {
    protocol: PROFILE_PROTOCOL,
    type: "profile-metadata",
    roomId,
    metadata,
  };
}

export function isProfileMetadataPayload(
  value: unknown,
  expectedRoomId: string,
): value is ProfileMetadataPayload {
  return isRecord(value)
    && value.protocol === PROFILE_PROTOCOL
    && value.type === "profile-metadata"
    && value.roomId === expectedRoomId
    && value.roomId.length > 0
    && value.roomId.length <= MAX_ROOM_ID_CHARACTERS
    && isProfileMetadata(value.metadata);
}
