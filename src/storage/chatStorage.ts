import type { ChatProfile, EncryptedWire, MessageAuthor } from "@/src/chat/types";
import type { RoomInvitation } from "@/src/room/invitation";

const DATABASE_NAME = "twoonly-chat";
const DATABASE_VERSION = 3;
const ROOM_STORE = "rooms";
const MESSAGE_STORE = "messages";
const SETTINGS_STORE = "settings";
const PROFILE_KEY = "local-profile";
const MAX_MESSAGES = 200;

export type StoredRoom = {
  roomId: string;
  secret: string;
  lastOpenedAt: number;
  order: number;
  title?: string;
  icon?: string;
};

export type StoredRoomMetadata = Pick<StoredRoom, "title" | "icon">;

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

function parseStoredRoom(value: unknown): StoredRoom {
  if (!value || typeof value !== "object") throw new Error("Invalid stored room");
  const room = value as Partial<StoredRoom>;
  if (
    typeof room.roomId !== "string"
    || typeof room.secret !== "string"
    || !room.secret
    || typeof room.lastOpenedAt !== "number"
  ) throw new Error("Invalid stored room");
  return {
    roomId: room.roomId,
    secret: room.secret,
    lastOpenedAt: room.lastOpenedAt,
    order: typeof room.order === "number" && Number.isFinite(room.order)
      ? room.order
      : Number.MAX_SAFE_INTEGER,
    title: typeof room.title === "string" && room.title.trim() ? room.title.trim() : undefined,
    icon: typeof room.icon === "string" && room.icon ? room.icon : undefined,
  };
}

function parseProfile(value: unknown): ChatProfile | null {
  if (value === undefined) return null;
  if (!value || typeof value !== "object") throw new Error("Invalid stored profile");
  const setting = value as Partial<StoredSetting<Partial<ChatProfile>>>;
  if (
    setting.key !== PROFILE_KEY
    || !setting.value
    || typeof setting.value.nickname !== "string"
    || typeof setting.value.avatar !== "string"
  ) throw new Error("Invalid stored profile");
  const nickname = setting.value.nickname.trim();
  if (!nickname || !setting.value.avatar) throw new Error("Invalid stored profile");
  return { nickname, avatar: setting.value.avatar };
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
  const database = await openDatabase();
  const transaction = database.transaction(ROOM_STORE, "readonly");
  const completed = transactionDone(transaction);
  const values = await requestResult(transaction.objectStore(ROOM_STORE).getAll()) as unknown[];
  await completed;
  const storedRooms = values.map(parseStoredRoom);
  const rooms = storedRooms
    .sort((left, right) => left.order - right.order || right.lastOpenedAt - left.lastOpenedAt)
    .map((room, order) => ({ ...room, order }));

  if (rooms.some((room) => (
    storedRooms.find((storedRoom) => storedRoom.roomId === room.roomId)?.order !== room.order
  ))) {
    await persistStoredRoomOrder(rooms);
  }
  return rooms;
}

export async function upsertStoredRoom(invitation: RoomInvitation) {
  const rooms = await listStoredRooms();
  const existing = rooms.find((room) => room.roomId === invitation.roomId);
  const room: StoredRoom = existing
    ? { ...existing, secret: invitation.secret }
    : {
        roomId: invitation.roomId,
        secret: invitation.secret,
        lastOpenedAt: Date.now(),
        order: rooms.length,
      };
  const database = await openDatabase();
  const transaction = database.transaction(ROOM_STORE, "readwrite");
  const completed = transactionDone(transaction);
  transaction.objectStore(ROOM_STORE).put(room);
  await completed;
  return room;
}

export async function updateStoredRoomMetadata(roomId: string, patch: StoredRoomMetadata) {
  const rooms = await listStoredRooms();
  const current = rooms.find((room) => room.roomId === roomId);
  if (!current) throw new Error("Stored room not found");
  const room: StoredRoom = {
    ...current,
    title: patch.title?.trim() || undefined,
    icon: patch.icon || undefined,
  };
  const database = await openDatabase();
  const transaction = database.transaction(ROOM_STORE, "readwrite");
  const completed = transactionDone(transaction);
  transaction.objectStore(ROOM_STORE).put(room);
  await completed;
  return room;
}

export async function persistStoredRoomOrder(rooms: StoredRoom[]) {
  const database = await openDatabase();
  const transaction = database.transaction(ROOM_STORE, "readwrite");
  const completed = transactionDone(transaction);
  const store = transaction.objectStore(ROOM_STORE);
  rooms.forEach((room, order) => store.put({ ...room, order } satisfies StoredRoom));
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

export async function saveLocalProfile(profile: ChatProfile) {
  const database = await openDatabase();
  const transaction = database.transaction(SETTINGS_STORE, "readwrite");
  const completed = transactionDone(transaction);
  transaction.objectStore(SETTINGS_STORE).put({
    key: PROFILE_KEY,
    value: profile,
  } satisfies StoredSetting<ChatProfile>);
  await completed;
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
