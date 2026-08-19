import type { RoomMetadata } from "@/src/chat/types";

const ROOM_METADATA_PROTOCOL = "twoonly-room-metadata-v1" as const;
const MAX_ROOM_ID_CHARACTERS = 128;
const MAX_ROOM_TITLE_CHARACTERS = 24;
const MAX_ROOM_ICON_CHARACTERS = 1_000_000;
const MAX_VERSION_ID_CHARACTERS = 128;

export type RoomMetadataPayload = {
  protocol: typeof ROOM_METADATA_PROTOCOL;
  type: "room-metadata";
  roomId: string;
  metadata: RoomMetadata;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function legacyVersionId(title: string | undefined, icon: string | undefined) {
  let hash = 2_166_136_261;
  const value = `${title ?? ""}\u0000${icon ?? ""}`;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return `legacy-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function normalizeRoomMetadata(value: {
  title?: unknown;
  icon?: unknown;
  metadataRevision?: unknown;
  metadataVersionId?: unknown;
}): RoomMetadata {
  const title = typeof value.title === "string" && value.title.trim()
    ? value.title.trim().slice(0, MAX_ROOM_TITLE_CHARACTERS)
    : undefined;
  const icon = typeof value.icon === "string" && value.icon
    ? value.icon.slice(0, MAX_ROOM_ICON_CHARACTERS)
    : undefined;
  const hasExplicitVersion = Number.isSafeInteger(value.metadataRevision)
    && Number(value.metadataRevision) >= 0
    && typeof value.metadataVersionId === "string"
    && value.metadataVersionId.length <= MAX_VERSION_ID_CHARACTERS
    && (Number(value.metadataRevision) === 0
      ? value.metadataVersionId.length === 0
      : value.metadataVersionId.length > 0);

  if (hasExplicitVersion) {
    return {
      title,
      icon,
      revision: Number(value.metadataRevision),
      versionId: String(value.metadataVersionId),
    };
  }
  if (!title && !icon) return { revision: 0, versionId: "" };
  return { title, icon, revision: 1, versionId: legacyVersionId(title, icon) };
}

export function compareRoomMetadataVersion(left: RoomMetadata, right: RoomMetadata) {
  if (left.revision !== right.revision) return left.revision - right.revision;
  if (left.versionId === right.versionId) return 0;
  return left.versionId > right.versionId ? 1 : -1;
}

export function createRoomMetadataPayload(
  roomId: string,
  metadata: RoomMetadata,
): RoomMetadataPayload {
  return {
    protocol: ROOM_METADATA_PROTOCOL,
    type: "room-metadata",
    roomId,
    metadata,
  };
}

export function isRoomMetadataPayload(
  value: unknown,
  expectedRoomId: string,
): value is RoomMetadataPayload {
  if (
    !isRecord(value)
    || value.protocol !== ROOM_METADATA_PROTOCOL
    || value.type !== "room-metadata"
    || value.roomId !== expectedRoomId
    || value.roomId.length < 1
    || value.roomId.length > MAX_ROOM_ID_CHARACTERS
    || !isRecord(value.metadata)
  ) return false;

  const metadata = value.metadata;
  return (metadata.title === undefined || (
    typeof metadata.title === "string"
    && metadata.title === metadata.title.trim()
    && metadata.title.trim().length > 0
    && metadata.title.trim().length <= MAX_ROOM_TITLE_CHARACTERS
  ))
    && (metadata.icon === undefined || (
      typeof metadata.icon === "string"
      && metadata.icon.length > 0
      && metadata.icon.length <= MAX_ROOM_ICON_CHARACTERS
    ))
    && Number.isSafeInteger(metadata.revision)
    && Number(metadata.revision) >= 0
    && typeof metadata.versionId === "string"
    && metadata.versionId.length <= MAX_VERSION_ID_CHARACTERS
    && (Number(metadata.revision) === 0
      ? metadata.versionId.length === 0
      : metadata.versionId.length > 0);
}
