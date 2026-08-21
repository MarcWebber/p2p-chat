import { base64ToBytes, bytesToBase64 } from "@/src/crypto/aesGcm";
import type {
  SignalMessage,
  SignalMembershipProof,
  UnsignedSignalMessage,
} from "@/src/signal/types";

const MEMBER_ID_PREFIX = "member-";
const ENCODED_KEY_PATTERN = /^[A-Za-z0-9_-]+$/;
const MAX_CACHED_PUBLIC_KEYS = 16;
const encoder = new TextEncoder();
const publicKeyCache = new Map<string, Promise<CryptoKey>>();
const privateKeyCache = new Map<string, Promise<CryptoKey>>();

export type RoomMemberIdentity = {
  memberId: string;
  publicKey: string;
  privateKey: string;
};

export type RoomMembership = {
  version: 1;
  identity: RoomMemberIdentity;
  ownerPublicKey?: string;
  peerPublicKey?: string;
};

export type VerifiedRoomMember = Pick<RoomMemberIdentity, "memberId" | "publicKey">;

function toBase64Url(bytes: Uint8Array) {
  return bytesToBase64(bytes)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function fromBase64Url(value: string) {
  const padding = "=".repeat((4 - value.length % 4) % 4);
  return base64ToBytes(value.replaceAll("-", "+").replaceAll("_", "/") + padding);
}

export function isEncodedMemberKey(value: unknown): value is string {
  return typeof value === "string"
    && value.length >= 80
    && value.length <= 512
    && ENCODED_KEY_PATTERN.test(value);
}

function isMemberId(value: unknown): value is string {
  return typeof value === "string"
    && value.startsWith(MEMBER_ID_PREFIX)
    && value.length <= 128
    && ENCODED_KEY_PATTERN.test(value);
}

export function isRoomMemberIdentity(value: unknown): value is RoomMemberIdentity {
  if (!value || typeof value !== "object") return false;
  const identity = value as Partial<RoomMemberIdentity>;
  return isMemberId(identity.memberId)
    && isEncodedMemberKey(identity.publicKey)
    && isEncodedMemberKey(identity.privateKey);
}

export function isRoomMembership(value: unknown): value is RoomMembership {
  if (!value || typeof value !== "object") return false;
  const membership = value as Partial<RoomMembership>;
  return membership.version === 1
    && isRoomMemberIdentity(membership.identity)
    && (membership.ownerPublicKey === undefined || isEncodedMemberKey(membership.ownerPublicKey))
    && (membership.peerPublicKey === undefined || isEncodedMemberKey(membership.peerPublicKey));
}

export function expectedPeerPublicKey(membership: RoomMembership) {
  if (membership.peerPublicKey) return membership.peerPublicKey;
  if (
    membership.ownerPublicKey
    && membership.ownerPublicKey !== membership.identity.publicKey
  ) return membership.ownerPublicKey;
  return undefined;
}

export function claimRoomMembership(
  membership: RoomMembership,
  peerPublicKey: string,
): RoomMembership | null {
  if (
    !isEncodedMemberKey(peerPublicKey)
    || peerPublicKey === membership.identity.publicKey
  ) return null;
  const expected = expectedPeerPublicKey(membership);
  if (expected && expected !== peerPublicKey) return null;
  const ownerPublicKey = membership.ownerPublicKey
    ?? [membership.identity.publicKey, peerPublicKey].sort()[0];
  if (ownerPublicKey !== membership.identity.publicKey && peerPublicKey !== ownerPublicKey) {
    return null;
  }
  return {
    ...membership,
    ownerPublicKey,
    peerPublicKey,
  };
}

async function memberIdForPublicKey(publicKey: string) {
  const digest = await crypto.subtle.digest("SHA-256", fromBase64Url(publicKey));
  return `${MEMBER_ID_PREFIX}${toBase64Url(new Uint8Array(digest))}`;
}

export async function createRoomMemberIdentity(): Promise<RoomMemberIdentity> {
  const keyPair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const publicKey = toBase64Url(new Uint8Array(await crypto.subtle.exportKey("spki", keyPair.publicKey)));
  const privateKey = toBase64Url(new Uint8Array(await crypto.subtle.exportKey("pkcs8", keyPair.privateKey)));
  return {
    memberId: await memberIdForPublicKey(publicKey),
    publicKey,
    privateKey,
  };
}

function importPublicKey(value: string) {
  let key = publicKeyCache.get(value);
  if (!key) {
    key = crypto.subtle.importKey(
      "spki",
      fromBase64Url(value),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    publicKeyCache.set(value, key);
    while (publicKeyCache.size > MAX_CACHED_PUBLIC_KEYS) {
      const oldest = publicKeyCache.keys().next().value as string | undefined;
      if (!oldest) break;
      publicKeyCache.delete(oldest);
    }
    void key.catch(() => {
      if (publicKeyCache.get(value) === key) publicKeyCache.delete(value);
    });
  }
  return key;
}

function importPrivateKey(value: string) {
  let key = privateKeyCache.get(value);
  if (!key) {
    key = crypto.subtle.importKey(
      "pkcs8",
      fromBase64Url(value),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    );
    privateKeyCache.set(value, key);
  }
  return key;
}

function normalizedJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => normalizedJson(item));
  if (!value || typeof value !== "object") return value;
  const normalized: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const item = (value as Record<string, unknown>)[key];
    if (item !== undefined) normalized[key] = normalizedJson(item);
  }
  return normalized;
}

function signingBytes(roomId: string, roomSecret: string, signal: UnsignedSignalMessage) {
  return encoder.encode(JSON.stringify(normalizedJson({
    protocol: "twoonly-member-signal-v1",
    roomId,
    roomSecret,
    signal,
  })));
}

export async function signRoomSignal(
  roomId: string,
  roomSecret: string,
  signal: UnsignedSignalMessage,
  identity: RoomMemberIdentity,
): Promise<SignalMessage> {
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    await importPrivateKey(identity.privateKey),
    signingBytes(roomId, roomSecret, signal),
  );
  const member: SignalMembershipProof = {
    memberId: identity.memberId,
    publicKey: identity.publicKey,
    signature: toBase64Url(new Uint8Array(signature)),
  };
  return { ...signal, member } as SignalMessage;
}

export async function verifyRoomSignal(
  roomId: string,
  roomSecret: string,
  signal: SignalMessage,
): Promise<VerifiedRoomMember | null> {
  try {
    const { member, ...unsigned } = signal;
    const memberId = await memberIdForPublicKey(member.publicKey);
    if (memberId !== member.memberId) return null;
    const valid = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      await importPublicKey(member.publicKey),
      fromBase64Url(member.signature),
      signingBytes(roomId, roomSecret, unsigned),
    );
    return valid ? { memberId, publicKey: member.publicKey } : null;
  } catch {
    return null;
  }
}
