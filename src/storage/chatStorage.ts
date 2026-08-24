import type {
  EncryptedWire,
  MessageAuthor,
  ProfileMetadata,
  RoomMetadata,
} from "@/src/chat/types";
import {
  compareProfileMetadataVersion,
  isChatProfile,
  isProfileMetadata,
} from "@/src/protocol/profileMetadataProtocol";
import {
  compareRoomMetadataVersion,
  normalizeRoomMetadata,
} from "@/src/protocol/roomMetadataProtocol";
import type { RoomInvitation } from "@/src/room/invitation";
import {
  createRoomMemberIdentity,
  claimRoomMembership,
  isEncodedMemberKey,
  isRoomMembership,
  type RoomMemberIdentity,
  type RoomMembership,
} from "@/src/room/memberIdentity";

const DATABASE_NAME = "twoonly-chat";
const DATABASE_VERSION = 3;
const ROOM_STORE = "rooms";
const MESSAGE_STORE = "messages";
const SETTINGS_STORE = "settings";
const PROFILE_KEY = "local-profile";
const INSTALLATION_KEY = "browser-installation";
const NETWORK_LEASE_KEY = "network-owner-lease";
const WAKE_SEQUENCE_PREFIX = "wake-sequence:";
const PEER_WAKE_PREFIX = "peer-wake:";
const MAX_MESSAGES = 200;

export class StoredRoomCredentialMismatchError extends Error {}
export class LegacyRoomInvitationError extends Error {}

export type StoredRoom = {
  roomId: string;
  secret: string;
  lastOpenedAt: number;
  order: number;
  title?: string;
  icon?: string;
  metadataRevision: number;
  metadataVersionId: string;
  membership: RoomMembership;
  peerProfile?: ProfileMetadata;
};

type StoredRoomRecord = Omit<StoredRoom, "membership"> & {
  membership?: RoomMembership;
};

export type StoredRoomMetadata = RoomMetadata;

type StoredEncryptedMessage = {
  wire: EncryptedWire;
  localDirection: MessageAuthor;
};

type MessageBucket = {
  roomId: string;
  items: StoredEncryptedMessage[];
};

type StoredSetting<T> = {
  key: string;
  value: T;
};

export type BrowserInstallation = {
  version: 1;
  installationId: string;
  createdAt: number;
};

export type BrowserNetworkLease = {
  version: 1;
  installationId: string;
  ownerTabId: string;
  fence: number;
  expiresAt: number;
};

export type PeerWakeDisposition = "new" | "duplicate" | "stale";

let databasePromise: Promise<IDBDatabase> | null = null;

function requestResult<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function transactionDone(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed"));
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
  });
}

function openDatabase() {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(ROOM_STORE)) {
        database.createObjectStore(ROOM_STORE, { keyPath: "roomId" });
      }
      if (!database.objectStoreNames.contains(MESSAGE_STORE)) {
        database.createObjectStore(MESSAGE_STORE, { keyPath: "roomId" });
      }
      if (!database.objectStoreNames.contains(SETTINGS_STORE)) {
        database.createObjectStore(SETTINGS_STORE, { keyPath: "key" });
      }
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => {
        database.close();
        databasePromise = null;
      };
      resolve(database);
    };
    request.onerror = () => {
      databasePromise = null;
      reject(request.error ?? new Error("IndexedDB could not be opened"));
    };
    request.onblocked = () => {
      databasePromise = null;
      reject(new Error("IndexedDB upgrade is blocked"));
    };
  });
  return databasePromise;
}

function parseStoredRoom(value: unknown): StoredRoomRecord {
  if (!value || typeof value !== "object") throw new Error("Invalid stored room");
  const room = value as Partial<StoredRoom>;
  if (
    typeof room.roomId !== "string"
    || typeof room.secret !== "string"
    || !room.secret
    || typeof room.lastOpenedAt !== "number"
  ) throw new Error("Invalid stored room");
  const metadata = normalizeRoomMetadata(room);
  if (room.membership !== undefined && !isRoomMembership(room.membership)) {
    throw new Error("Invalid stored room membership");
  }
  if (room.peerProfile !== undefined && !isProfileMetadata(room.peerProfile)) {
    throw new Error("Invalid stored peer profile");
  }
  return {
    roomId: room.roomId,
    secret: room.secret,
    lastOpenedAt: room.lastOpenedAt,
    order: typeof room.order === "number" && Number.isFinite(room.order)
      ? room.order
      : Number.MAX_SAFE_INTEGER,
    title: metadata.title,
    icon: metadata.icon,
    metadataRevision: metadata.revision,
    metadataVersionId: metadata.versionId,
    membership: room.membership,
    peerProfile: room.peerProfile,
  };
}

function requirePreparedRoom(room: StoredRoomRecord): StoredRoom {
  if (!room.membership) throw new Error("Stored room membership is missing");
  return room as StoredRoom;
}

function roomMetadata(room: StoredRoom): RoomMetadata {
  return {
    title: room.title,
    icon: room.icon,
    revision: room.metadataRevision,
    versionId: room.metadataVersionId,
  };
}

function parseProfile(value: unknown): ProfileMetadata | null {
  if (value === undefined) return null;
  if (!value || typeof value !== "object") throw new Error("Invalid stored profile");
  const setting = value as Partial<StoredSetting<unknown>>;
  if (setting.key !== PROFILE_KEY) throw new Error("Invalid stored profile");
  if (isProfileMetadata(setting.value)) return setting.value;
  if (isChatProfile(setting.value)) {
    return {
      profile: setting.value,
      revision: 1,
      versionId: "legacy-profile",
    };
  }
  throw new Error("Invalid stored profile");
}

function parseInstallation(value: unknown): BrowserInstallation | null {
  if (!value || typeof value !== "object") return null;
  const setting = value as Partial<StoredSetting<Partial<BrowserInstallation>>>;
  const installation = setting.value;
  if (
    setting.key !== INSTALLATION_KEY
    || installation?.version !== 1
    || typeof installation.installationId !== "string"
    || !installation.installationId
    || typeof installation.createdAt !== "number"
    || !Number.isFinite(installation.createdAt)
  ) return null;
  return installation as BrowserInstallation;
}

function parseNetworkLease(value: unknown): BrowserNetworkLease | null {
  if (!value || typeof value !== "object") return null;
  const setting = value as Partial<StoredSetting<Partial<BrowserNetworkLease>>>;
  const lease = setting.value;
  if (
    setting.key !== NETWORK_LEASE_KEY
    || lease?.version !== 1
    || typeof lease.installationId !== "string"
    || !lease.installationId
    || typeof lease.ownerTabId !== "string"
    || !lease.ownerTabId
    || !Number.isSafeInteger(lease.fence)
    || Number(lease.fence) < 1
    || typeof lease.expiresAt !== "number"
    || !Number.isFinite(lease.expiresAt)
  ) return null;
  return lease as BrowserNetworkLease;
}

function settingNumber(value: unknown, expectedKey: string) {
  if (!value || typeof value !== "object") return 0;
  const setting = value as Partial<StoredSetting<unknown>>;
  return setting.key === expectedKey && Number.isSafeInteger(setting.value) && Number(setting.value) > 0
    ? Number(setting.value)
    : 0;
}

function parseMessageBucket(value: unknown, roomId: string) {
  if (value === undefined) return [];
  if (!value || typeof value !== "object") throw new Error("Invalid stored message bucket");
  const bucket = value as Partial<MessageBucket>;
  if (bucket.roomId !== roomId || !Array.isArray(bucket.items)) {
    throw new Error("Invalid stored message bucket");
  }
  for (const item of bucket.items) {
    const wire = item?.wire;
    if (
      !item
      || typeof item !== "object"
      || !wire
      || typeof wire !== "object"
      || typeof wire.id !== "string"
      || typeof wire.iv !== "string"
      || typeof wire.data !== "string"
      || (item.localDirection !== "self" && item.localDirection !== "peer")
    ) throw new Error("Invalid stored message");
  }
  return bucket.items;
}

export async function listStoredRooms() {
  const readStoredRooms = async () => {
    const database = await openDatabase();
    const transaction = database.transaction(ROOM_STORE, "readonly");
    const completed = transactionDone(transaction);
    const values = await requestResult(transaction.objectStore(ROOM_STORE).getAll()) as unknown[];
    await completed;
    return values.map(parseStoredRoom);
  };

  const ensureMembership = async (room: StoredRoomRecord) => {
    if (room.membership) return requirePreparedRoom(room);
    const membership: RoomMembership = {
      version: 1,
      identity: await createRoomMemberIdentity(),
    };
    const database = await openDatabase();
    const transaction = database.transaction(ROOM_STORE, "readwrite");
    const completed = transactionDone(transaction);
    const store = transaction.objectStore(ROOM_STORE);
    const value = await requestResult(store.get(room.roomId));
    if (value === undefined) {
      await completed;
      return null;
    }
    const current = parseStoredRoom(value);
    if (current.membership) {
      await completed;
      return requirePreparedRoom(current);
    }
    const prepared = { ...current, membership } satisfies StoredRoom;
    store.put(prepared);
    await completed;
    return prepared;
  };

  const storedRooms = await readStoredRooms();
  const addedMembership = storedRooms.some((room) => !room.membership);
  const preparedRooms = (await Promise.all(storedRooms.map(ensureMembership)))
    .filter((room): room is StoredRoom => room !== null);
  const sortedRooms = preparedRooms
    .sort((left, right) => left.order - right.order || right.lastOpenedAt - left.lastOpenedAt);
  const orderChanged = sortedRooms.some((room, order) => room.order !== order);
  const rooms = sortedRooms
    .map((room, order) => ({ ...room, order }));

  if (addedMembership || orderChanged) {
    await persistStoredRoomOrder(rooms);
    return (await readStoredRooms())
      .map(requirePreparedRoom)
      .sort((left, right) => left.order - right.order || right.lastOpenedAt - left.lastOpenedAt);
  }
  return rooms;
}

function membershipForInvitation(
  identity: RoomMemberIdentity,
  ownerPublicKey: string | undefined,
): RoomMembership {
  return {
    version: 1,
    identity,
    ownerPublicKey,
    peerPublicKey: ownerPublicKey && ownerPublicKey !== identity.publicKey
      ? ownerPublicKey
      : undefined,
  };
}

function reconcileInvitationOwner(
  membership: RoomMembership,
  ownerPublicKey: string | undefined,
) {
  if (!ownerPublicKey) return membership;
  if (membership.ownerPublicKey && membership.ownerPublicKey !== ownerPublicKey) {
    throw new StoredRoomCredentialMismatchError("Room owner key does not match the stored room");
  }
  return {
    ...membership,
    ownerPublicKey,
    peerPublicKey: membership.peerPublicKey
      ?? (membership.identity.publicKey === ownerPublicKey ? undefined : ownerPublicKey),
  } satisfies RoomMembership;
}

export async function upsertStoredRoom(
  invitation: RoomInvitation,
  identity?: RoomMemberIdentity,
) {
  const rooms = await listStoredRooms();
  const roomWasPresent = rooms.some((room) => room.roomId === invitation.roomId);
  const nextIdentity = identity
    ?? (roomWasPresent ? undefined : await createRoomMemberIdentity());
  const database = await openDatabase();
  const transaction = database.transaction(ROOM_STORE, "readwrite");
  const completed = transactionDone(transaction);
  const store = transaction.objectStore(ROOM_STORE);
  const storedValue = await requestResult(store.get(invitation.roomId));
  const existing = storedValue === undefined
    ? undefined
    : requirePreparedRoom(parseStoredRoom(storedValue));
  if (!existing && !invitation.ownerPublicKey) {
    await completed;
    throw new LegacyRoomInvitationError("Legacy invitation has no persistent room owner");
  }
  if (!existing && !nextIdentity) {
    await completed;
    throw new Error("Stored room changed while opening the invitation");
  }
  if (existing && existing.secret !== invitation.secret) {
    await completed;
    throw new StoredRoomCredentialMismatchError("Room secret does not match the stored room");
  }
  if (
    existing?.membership.ownerPublicKey
    && invitation.ownerPublicKey
    && existing.membership.ownerPublicKey !== invitation.ownerPublicKey
  ) {
    await completed;
    throw new StoredRoomCredentialMismatchError("Room owner key does not match the stored room");
  }
  const room: StoredRoom = existing
    ? {
        ...existing,
        membership: reconcileInvitationOwner(existing.membership, invitation.ownerPublicKey),
      }
    : {
        roomId: invitation.roomId,
        secret: invitation.secret,
        lastOpenedAt: Date.now(),
        order: rooms.length,
        metadataRevision: 0,
        metadataVersionId: "",
        membership: membershipForInvitation(
          nextIdentity!,
          invitation.ownerPublicKey,
        ),
      };
  store.put(room);
  await completed;
  return room;
}

export async function claimStoredRoomPeer(roomId: string, peerPublicKey: string) {
  if (!isEncodedMemberKey(peerPublicKey)) return null;
  const database = await openDatabase();
  const transaction = database.transaction(ROOM_STORE, "readwrite");
  const completed = transactionDone(transaction);
  const store = transaction.objectStore(ROOM_STORE);
  const current = requirePreparedRoom(parseStoredRoom(await requestResult(store.get(roomId))));
  const membership = current.membership;
  const claimedMembership = claimRoomMembership(membership, peerPublicKey);
  if (!claimedMembership) {
    await completed;
    return null;
  }
  const room: StoredRoom = {
    ...current,
    membership: claimedMembership,
  };
  store.put(room);
  await completed;
  return room;
}

export async function updateStoredRoomMetadata(roomId: string, patch: StoredRoomMetadata) {
  const database = await openDatabase();
  const transaction = database.transaction(ROOM_STORE, "readwrite");
  const completed = transactionDone(transaction);
  const store = transaction.objectStore(ROOM_STORE);
  const value = await requestResult(store.get(roomId));
  if (value === undefined) throw new Error("Stored room not found");
  const current = requirePreparedRoom(parseStoredRoom(value));
  if (compareRoomMetadataVersion(patch, roomMetadata(current)) <= 0) {
    await completed;
    return current;
  }
  const room: StoredRoom = {
    ...current,
    title: patch.title?.trim() || undefined,
    icon: patch.icon || undefined,
    metadataRevision: patch.revision,
    metadataVersionId: patch.versionId,
  };
  store.put(room);
  await completed;
  return room;
}

export async function persistStoredRoomOrder(rooms: StoredRoom[]) {
  const database = await openDatabase();
  const transaction = database.transaction(ROOM_STORE, "readwrite");
  const completed = transactionDone(transaction);
  const store = transaction.objectStore(ROOM_STORE);
  const currentRooms = await Promise.all(rooms.map((room) => requestResult(store.get(room.roomId))));
  currentRooms.forEach((value, order) => {
    if (value === undefined) return;
    const parsed = parseStoredRoom(value);
    const current = parsed.membership
      ? requirePreparedRoom(parsed)
      : { ...parsed, membership: rooms[order].membership } satisfies StoredRoom;
    store.put({ ...current, order } satisfies StoredRoom);
  });
  await completed;
}

export async function loadLocalProfile() {
  const database = await openDatabase();
  const transaction = database.transaction(SETTINGS_STORE, "readonly");
  const completed = transactionDone(transaction);
  const value = await requestResult(transaction.objectStore(SETTINGS_STORE).get(PROFILE_KEY));
  await completed;
  return parseProfile(value);
}

export async function saveLocalProfile(profile: ProfileMetadata) {
  const database = await openDatabase();
  const transaction = database.transaction(SETTINGS_STORE, "readwrite");
  const completed = transactionDone(transaction);
  const store = transaction.objectStore(SETTINGS_STORE);
  const current = parseProfile(await requestResult(store.get(PROFILE_KEY)));
  if (current && compareProfileMetadataVersion(profile, current) <= 0) {
    await completed;
    return current;
  }
  store.put({
    key: PROFILE_KEY,
    value: profile,
  } satisfies StoredSetting<ProfileMetadata>);
  await completed;
  return profile;
}

export async function ensureBrowserInstallation() {
  const database = await openDatabase();
  const transaction = database.transaction(SETTINGS_STORE, "readwrite");
  const completed = transactionDone(transaction);
  const store = transaction.objectStore(SETTINGS_STORE);
  const current = parseInstallation(await requestResult(store.get(INSTALLATION_KEY)));
  if (current) {
    await completed;
    return current;
  }
  const installation: BrowserInstallation = {
    version: 1,
    installationId: crypto.randomUUID(),
    createdAt: Date.now(),
  };
  store.put({ key: INSTALLATION_KEY, value: installation } satisfies StoredSetting<BrowserInstallation>);
  await completed;
  return installation;
}

export async function acquireBrowserNetworkLease(
  installationId: string,
  ownerTabId: string,
  now: number,
  ttlMs: number,
) {
  const database = await openDatabase();
  const transaction = database.transaction(SETTINGS_STORE, "readwrite");
  const completed = transactionDone(transaction);
  const store = transaction.objectStore(SETTINGS_STORE);
  const current = parseNetworkLease(await requestResult(store.get(NETWORK_LEASE_KEY)));
  const alreadyOwned = current?.installationId === installationId
    && current.ownerTabId === ownerTabId;
  if (current && current.expiresAt > now && !alreadyOwned) {
    await completed;
    return null;
  }
  const lease: BrowserNetworkLease = {
    version: 1,
    installationId,
    ownerTabId,
    fence: alreadyOwned ? current.fence : (current?.fence ?? 0) + 1,
    expiresAt: now + ttlMs,
  };
  store.put({ key: NETWORK_LEASE_KEY, value: lease } satisfies StoredSetting<BrowserNetworkLease>);
  await completed;
  return lease;
}

export async function renewBrowserNetworkLease(
  installationId: string,
  ownerTabId: string,
  fence: number,
  now: number,
  ttlMs: number,
) {
  const database = await openDatabase();
  const transaction = database.transaction(SETTINGS_STORE, "readwrite");
  const completed = transactionDone(transaction);
  const store = transaction.objectStore(SETTINGS_STORE);
  const current = parseNetworkLease(await requestResult(store.get(NETWORK_LEASE_KEY)));
  if (
    !current
    || current.installationId !== installationId
    || current.ownerTabId !== ownerTabId
    || current.fence !== fence
  ) {
    await completed;
    return null;
  }
  const lease: BrowserNetworkLease = { ...current, expiresAt: now + ttlMs };
  store.put({ key: NETWORK_LEASE_KEY, value: lease } satisfies StoredSetting<BrowserNetworkLease>);
  await completed;
  return lease;
}

export async function releaseBrowserNetworkLease(
  installationId: string,
  ownerTabId: string,
  fence: number,
) {
  const database = await openDatabase();
  const transaction = database.transaction(SETTINGS_STORE, "readwrite");
  const completed = transactionDone(transaction);
  const store = transaction.objectStore(SETTINGS_STORE);
  const current = parseNetworkLease(await requestResult(store.get(NETWORK_LEASE_KEY)));
  if (
    current?.installationId === installationId
    && current.ownerTabId === ownerTabId
    && current.fence === fence
  ) store.delete(NETWORK_LEASE_KEY);
  await completed;
}

export async function nextRoomWakeSequence(roomId: string) {
  const key = `${WAKE_SEQUENCE_PREFIX}${roomId}`;
  const database = await openDatabase();
  const transaction = database.transaction(SETTINGS_STORE, "readwrite");
  const completed = transactionDone(transaction);
  const store = transaction.objectStore(SETTINGS_STORE);
  const current = settingNumber(await requestResult(store.get(key)), key);
  const next = current >= Number.MAX_SAFE_INTEGER ? 1 : current + 1;
  store.put({ key, value: next } satisfies StoredSetting<number>);
  await completed;
  return next;
}

export async function acceptRoomPeerWake(
  roomId: string,
  peerMemberId: string,
  wakeSeq: number,
): Promise<PeerWakeDisposition> {
  const key = `${PEER_WAKE_PREFIX}${roomId}`;
  const database = await openDatabase();
  const transaction = database.transaction(SETTINGS_STORE, "readwrite");
  const completed = transactionDone(transaction);
  const store = transaction.objectStore(SETTINGS_STORE);
  const value = await requestResult(store.get(key));
  const setting = value && typeof value === "object"
    ? value as Partial<StoredSetting<{ memberId?: unknown; wakeSeq?: unknown }>>
    : null;
  const peerWake = setting?.key === key ? setting.value : undefined;
  const current = peerWake
    && peerWake.memberId === peerMemberId
    && Number.isSafeInteger(peerWake.wakeSeq)
    ? Number(peerWake.wakeSeq)
    : 0;
  if (wakeSeq < current) {
    await completed;
    return "stale";
  }
  if (wakeSeq === current && current > 0) {
    await completed;
    return "duplicate";
  }
  store.put({
    key,
    value: { memberId: peerMemberId, wakeSeq },
  } satisfies StoredSetting<{ memberId: string; wakeSeq: number }>);
  await completed;
  return "new";
}

export async function updateStoredRoomPeerProfile(
  roomId: string,
  metadata: ProfileMetadata,
) {
  const database = await openDatabase();
  const transaction = database.transaction(ROOM_STORE, "readwrite");
  const completed = transactionDone(transaction);
  const store = transaction.objectStore(ROOM_STORE);
  const current = requirePreparedRoom(parseStoredRoom(await requestResult(store.get(roomId))));
  if (
    current.peerProfile
    && compareProfileMetadataVersion(metadata, current.peerProfile) <= 0
    && !(
      metadata.revision === 0
      && current.peerProfile.revision === 0
      && (
        metadata.profile.nickname !== current.peerProfile.profile.nickname
        || metadata.profile.avatar !== current.peerProfile.profile.avatar
      )
    )
  ) {
    await completed;
    return current;
  }
  const room: StoredRoom = { ...current, peerProfile: metadata };
  store.put(room);
  await completed;
  return room;
}

export async function loadEncryptedHistory(roomId: string) {
  const database = await openDatabase();
  const transaction = database.transaction(MESSAGE_STORE, "readonly");
  const completed = transactionDone(transaction);
  const value = await requestResult(transaction.objectStore(MESSAGE_STORE).get(roomId));
  await completed;
  return parseMessageBucket(value, roomId);
}

export async function persistEncryptedMessage(
  roomId: string,
  wire: EncryptedWire,
  localDirection: MessageAuthor,
) {
  const database = await openDatabase();
  const transaction = database.transaction(MESSAGE_STORE, "readwrite");
  const completed = transactionDone(transaction);
  const store = transaction.objectStore(MESSAGE_STORE);
  const items = parseMessageBucket(await requestResult(store.get(roomId)), roomId);
  if (!items.some((item) => item.wire.id === wire.id)) {
    store.put({
      roomId,
      items: [...items, { wire, localDirection }].slice(-MAX_MESSAGES),
    } satisfies MessageBucket);
  }
  await completed;
}

export async function clearEncryptedHistory(roomId: string) {
  const database = await openDatabase();
  const transaction = database.transaction(MESSAGE_STORE, "readwrite");
  const completed = transactionDone(transaction);
  transaction.objectStore(MESSAGE_STORE).delete(roomId);
  await completed;
}

export async function deleteEncryptedMessage(roomId: string, messageId: string) {
  const database = await openDatabase();
  const transaction = database.transaction(MESSAGE_STORE, "readwrite");
  const completed = transactionDone(transaction);
  const store = transaction.objectStore(MESSAGE_STORE);
  const items = parseMessageBucket(await requestResult(store.get(roomId)), roomId)
    .filter((item) => item.wire.id !== messageId);
  if (items.length) store.put({ roomId, items } satisfies MessageBucket);
  else store.delete(roomId);
  await completed;
}

export async function deleteStoredRoom(roomId: string) {
  const database = await openDatabase();
  const transaction = database.transaction([ROOM_STORE, MESSAGE_STORE], "readwrite");
  const completed = transactionDone(transaction);
  transaction.objectStore(ROOM_STORE).delete(roomId);
  transaction.objectStore(MESSAGE_STORE).delete(roomId);
  await completed;
}
