import { useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";

import { RoomRuntime, type RoomRuntimeSnapshot } from "@/src/chat/roomRuntime";
import { createMessageReplyReference } from "@/src/chat/messageReply";
import type {
  ChatMessage,
  ChatProfile,
  MessageKind,
  MessageReplyReference,
  ProfileMetadata,
  RoomMetadata,
} from "@/src/chat/types";
import { CHAT_POLICY, SIGNAL_POLICY, UI_POLICY } from "@/src/config/policy";
import { createSafetyCode } from "@/src/crypto/messageCrypto";
import { ConnectionDiagnostics } from "@/src/diagnostics/connectionDiagnostics";
import { useAudioRecorder } from "@/src/media/useAudioRecorder";
import {
  createRoomMemberIdentity,
} from "@/src/room/memberIdentity";
import {
  createRoomInvitation,
  createRoomUrl,
  readRoomInvitation,
  type RoomInvitation,
} from "@/src/room/invitation";
import {
  compareProfileMetadataVersion,
} from "@/src/protocol/profileMetadataProtocol";
import {
  compareRoomMetadataVersion,
  normalizeRoomMetadata,
} from "@/src/protocol/roomMetadataProtocol";
import {
  claimStoredRoomPeer,
  deleteStoredRoom,
  LegacyRoomInvitationError,
  listStoredRooms,
  loadLocalProfile,
  persistStoredRoomOrder,
  saveLocalProfile,
  StoredRoomCredentialMismatchError,
  updateStoredRoomMetadata,
  updateStoredRoomPeerProfile,
  upsertStoredRoom,
  type StoredRoom,
} from "@/src/storage/chatStorage";
import { copyText, readAsDataUrl } from "@/src/utils/browser";
import { formatBytes } from "@/src/utils/format";

const LEGACY_PROFILE_KEY = "twoonly.profile";
const DEFAULT_PROFILE: ChatProfile = { nickname: "我", avatar: "🙂" };
const DEFAULT_PROFILE_METADATA: ProfileMetadata = {
  profile: DEFAULT_PROFILE,
  revision: 0,
  versionId: "",
};
const EMPTY_MESSAGES: ChatMessage[] = [];

function replaceStoredRoom(rooms: StoredRoom[], replacement: StoredRoom) {
  return [...rooms.filter((room) => room.roomId !== replacement.roomId), replacement]
    .sort((left, right) => left.order - right.order);
}

function applyRoomMetadata(room: StoredRoom, metadata: RoomMetadata): StoredRoom {
  return {
    ...room,
    title: metadata.title,
    icon: metadata.icon,
    metadataRevision: metadata.revision,
    metadataVersionId: metadata.versionId,
  };
}

function createUniqueRoomInvitation(rooms: StoredRoom[], ownerPublicKey: string) {
  let invitation = createRoomInvitation(ownerPublicKey);
  const roomIds = new Set(rooms.map((room) => room.roomId));
  while (roomIds.has(invitation.roomId)) invitation = createRoomInvitation(ownerPublicKey);
  return invitation;
}

function messagePreview(message: ChatMessage | undefined, connectionMode: string) {
  if (!message) return connectionMode;
  if (message.kind === "text") return message.content;
  if (message.kind === "audio") return "[语音消息]";
  if (message.kind === "file") return `[文件 · ${message.fileName ?? "未命名"}]`;
  return "[图片]";
}

export function useTwoOnlyChat() {
  const [activeRoomId, setActiveRoomId] = useState<string | undefined>();
  const [storedRooms, setStoredRooms] = useState<StoredRoom[]>([]);
  const [roomSnapshots, setRoomSnapshots] = useState<Record<string, RoomRuntimeSnapshot>>({});
  const [profile, setProfile] = useState(DEFAULT_PROFILE);
  const [draft, setDraft] = useState("");
  const [pendingReply, setPendingReply] = useState<{
    roomId: string;
    reference: MessageReplyReference;
  } | null>(null);
  const [globalNotice, setGlobalNotice] = useState("");
  const [copiedRoomId, setCopiedRoomId] = useState("");
  const [bootstrapDiagnostics] = useState(() => new ConnectionDiagnostics());

  const runtimesRef = useRef(new Map<string, RoomRuntime>());
  const profileMetadataRef = useRef(DEFAULT_PROFILE_METADATA);
  const activeRoomIdRef = useRef("");
  const copyTimerRef = useRef<number | undefined>(undefined);
  const mountedRef = useRef(false);
  activeRoomIdRef.current = activeRoomId ?? "";

  const setRoomNotice = (roomId: string, notice: string) => {
    const runtime = runtimesRef.current.get(roomId);
    if (runtime) runtime.setNotice(notice);
    else if (roomId === activeRoomIdRef.current) setGlobalNotice(notice);
  };

  const setActiveNotice = (notice: string) => setRoomNotice(activeRoomIdRef.current, notice);

  const sendMessage = async (
    kind: MessageKind,
    content: string,
    options?: {
      fileName?: string;
      fileSize?: number;
      mimeType?: string;
      replyTo?: MessageReplyReference;
    },
  ) => {
    const runtime = runtimesRef.current.get(activeRoomIdRef.current);
    if (!runtime) return;
    await runtime.send(kind, content, profileMetadataRef.current.profile, options);
  };

  const { isRecording, startRecording, stopRecording, cancelRecording } = useAudioRecorder({
    sessionKey: activeRoomId ?? "",
    onAudio: (content, metadata) => sendMessage("audio", content, {
      fileName: "语音消息",
      fileSize: metadata.fileSize,
      mimeType: metadata.mimeType,
    }),
    onNotice: setActiveNotice,
  });

  useEffect(() => {
    let active = true;
    void (async () => {
      let savedProfile = await loadLocalProfile();
      if (!savedProfile) {
        const legacyProfile = window.localStorage.getItem(LEGACY_PROFILE_KEY);
        if (legacyProfile) {
          try {
            const candidate = JSON.parse(legacyProfile) as Partial<ChatProfile>;
            if (
              typeof candidate.nickname === "string"
              && candidate.nickname.trim()
              && typeof candidate.avatar === "string"
              && candidate.avatar
            ) {
              savedProfile = {
                profile: { nickname: candidate.nickname.trim(), avatar: candidate.avatar },
                revision: 1,
                versionId: crypto.randomUUID(),
              };
              savedProfile = await saveLocalProfile(savedProfile);
            }
          } catch {
            // Ignore malformed legacy localStorage data.
          }
          window.localStorage.removeItem(LEGACY_PROFILE_KEY);
        }
      }
      if (
        active
        && savedProfile
        && compareProfileMetadataVersion(savedProfile, profileMetadataRef.current) > 0
      ) {
        profileMetadataRef.current = savedProfile;
        setProfile(savedProfile.profile);
        for (const runtime of runtimesRef.current.values()) runtime.updateLocalProfile(savedProfile);
      }
    })().catch(() => {
      // Room bootstrap reports IndexedDB availability separately.
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      for (const runtime of runtimesRef.current.values()) runtime.dispose();
      runtimesRef.current.clear();
      if (copyTimerRef.current !== undefined) window.clearTimeout(copyTimerRef.current);
    };
  }, []);

  useEffect(() => {
    let active = true;

    void (async () => {
      const urlInvitation = readRoomInvitation(window.location);
      const requestedRoomId = new URLSearchParams(window.location.search).get("room") ?? "";
      try {
        if (urlInvitation) await upsertStoredRoom(urlInvitation);
        let rooms = await listStoredRooms();
        let nextInvitation = urlInvitation;
        let restored = false;
        let missingRequestedRoom = false;

        if (!nextInvitation) {
          const savedRoom = requestedRoomId
            ? rooms.find((room) => room.roomId === requestedRoomId)
            : rooms[0];
          if (savedRoom) {
            nextInvitation = {
              roomId: savedRoom.roomId,
              secret: savedRoom.secret,
              ownerPublicKey: savedRoom.membership.ownerPublicKey,
            };
            window.history.replaceState(
              null,
              "",
              createRoomUrl(window.location.origin, nextInvitation),
            );
            restored = true;
          } else {
            missingRequestedRoom = Boolean(requestedRoomId);
          }
        }

        if (!active) return;
        setStoredRooms(rooms);
        setActiveRoomId(nextInvitation?.roomId ?? "");
        if (missingRequestedRoom) {
          setGlobalNotice("这台设备上没有保存这个房间，请使用完整邀请链接进入。");
        } else if (restored) {
          setGlobalNotice("已恢复本机保存的聊天，其他房间也会同时保持连接。");
        }
        bootstrapDiagnostics.report({
          stage: "client",
          code: "client.storage.ready",
          level: "success",
          message: "本机会话存储已就绪",
          details: { backend: "indexeddb", savedRooms: rooms.length },
          dedupeKey: "storage-ready",
        });
      } catch (error: unknown) {
        if (!active) return;
        if (
          error instanceof StoredRoomCredentialMismatchError
          || error instanceof LegacyRoomInvitationError
        ) {
          try {
            const rooms = await listStoredRooms();
            if (!active) return;
            const savedRoom = rooms.find((room) => room.roomId === requestedRoomId);
            setStoredRooms(rooms);
            setActiveRoomId(savedRoom?.roomId ?? "");
            if (savedRoom) {
              window.history.replaceState(null, "", createRoomUrl(window.location.origin, {
                roomId: savedRoom.roomId,
                secret: savedRoom.secret,
                ownerPublicKey: savedRoom.membership.ownerPublicKey,
              }));
            }
            setGlobalNotice(error instanceof LegacyRoomInvitationError
              ? "这是一条没有成员公钥的旧邀请；为避免陌生人占位，请让原成员从已保存的房间复制新链接。"
              : "这个链接与本机已保存的房间凭证不一致，已拒绝替换。");
            return;
          } catch {
            // Fall through to the storage-unavailable state.
          }
        }
        setStoredRooms([]);
        setActiveRoomId("");
        setGlobalNotice(urlInvitation
          ? "IndexedDB 不可用，无法永久保存成员私钥；为避免锁死第二席位，已拒绝进入这个房间。"
          : "无法读取这台设备上的聊天，请检查浏览器是否允许 IndexedDB。");
        bootstrapDiagnostics.report({
          stage: "client",
          code: "client.storage.unavailable",
          level: "warn",
          message: "本机会话存储不可用",
          details: { backend: "indexeddb" },
          dedupeKey: "storage-ready",
        });
      }
    })();

    return () => {
      active = false;
    };
  }, [bootstrapDiagnostics]);

  useEffect(() => {
    const expectedRooms = new Map(storedRooms.map((room) => [room.roomId, room]));
    const initialSnapshots: Record<string, RoomRuntimeSnapshot> = {};
    const removedRoomIds: string[] = [];
    const newRuntimes: RoomRuntime[] = [];

    for (const [roomId, runtime] of runtimesRef.current) {
      const expected = expectedRooms.get(roomId);
      if (expected?.secret === runtime.secret) continue;
      runtime.dispose();
      runtimesRef.current.delete(roomId);
      removedRoomIds.push(roomId);
    }

    for (const room of storedRooms) {
      if (runtimesRef.current.has(room.roomId)) continue;
      const runtime = new RoomRuntime({
        room,
        localProfile: profileMetadataRef.current,
        onChange: (snapshot) => {
          if (!mountedRef.current) return;
          setRoomSnapshots((current) => ({ ...current, [snapshot.roomId]: snapshot }));
        },
        onRoomMetadata: (roomId, metadata) => {
          if (!mountedRef.current) return;
          setStoredRooms((current) => current.map((candidate) => {
            if (candidate.roomId !== roomId) return candidate;
            return compareRoomMetadataVersion(metadata, normalizeRoomMetadata(candidate)) > 0
              ? applyRoomMetadata(candidate, metadata)
              : candidate;
          }));
          void updateStoredRoomMetadata(roomId, metadata)
            .then((updatedRoom) => {
              if (!mountedRef.current) return;
              setStoredRooms((current) => replaceStoredRoom(current, updatedRoom));
            })
            .catch(() => setRoomNotice(roomId, "已收到聊天室资料，但无法保存到本机。"));
        },
        onRoomMembership: async (roomId, peerPublicKey) => {
          try {
            const updatedRoom = await claimStoredRoomPeer(roomId, peerPublicKey);
            if (!updatedRoom) return null;
            if (mountedRef.current) {
              setStoredRooms((current) => replaceStoredRoom(current, updatedRoom));
            }
            return updatedRoom.membership;
          } catch (error: unknown) {
            if (mountedRef.current) {
              setRoomNotice(roomId, "无法把第二位成员永久保存到本机，已拒绝本次连接。");
            }
            throw error;
          }
        },
        onPeerProfile: (roomId, metadata) => {
          void updateStoredRoomPeerProfile(roomId, metadata)
            .then((updatedRoom) => {
              if (!mountedRef.current) return;
              setStoredRooms((current) => replaceStoredRoom(current, updatedRoom));
            })
            .catch(() => setRoomNotice(roomId, "已收到对方的新头像和昵称，但无法保存到本机。"));
        },
      });
      runtimesRef.current.set(room.roomId, runtime);
      initialSnapshots[room.roomId] = runtime.getSnapshot();
      newRuntimes.push(runtime);
    }

    if (removedRoomIds.length || newRuntimes.length) {
      setRoomSnapshots((current) => {
        const next = { ...current };
        for (const roomId of removedRoomIds) delete next[roomId];
        Object.assign(next, initialSnapshots);
        return next;
      });
    }
    for (const runtime of newRuntimes) runtime.start();
  }, [storedRooms]);

  const reconnect = useCallback(() => {
    runtimesRef.current.get(activeRoomIdRef.current)?.reconnect();
  }, []);

  useEffect(() => {
    const reconnectAll = () => {
      for (const runtime of runtimesRef.current.values()) runtime.reconnect();
    };
    const reportOffline = () => {
      for (const runtime of runtimesRef.current.values()) runtime.reportOffline();
    };
    window.addEventListener("online", reconnectAll);
    window.addEventListener("offline", reportOffline);
    return () => {
      window.removeEventListener("online", reconnectAll);
      window.removeEventListener("offline", reportOffline);
    };
  }, []);

  const activeRoom = storedRooms.find((room) => room.roomId === activeRoomId);
  const activeSnapshot = activeRoom ? roomSnapshots[activeRoom.roomId] : undefined;
  const connection = activeSnapshot?.connection ?? "waiting";
  const connectionMode = activeSnapshot?.connectionMode ?? "正在建立房间连接";
  const messages = activeSnapshot?.messages ?? EMPTY_MESSAGES;
  const peerProfile = activeSnapshot?.peerProfile;
  const notice = activeSnapshot?.notice || globalNotice;
  const diagnostics = activeSnapshot?.diagnostics ?? bootstrapDiagnostics;
  const invitation: RoomInvitation | null = activeRoom
    ? {
        roomId: activeRoom.roomId,
        secret: activeRoom.secret,
        ownerPublicKey: activeRoom.membership.ownerPublicKey,
      }
    : null;
  const inviteUrl = invitation && typeof window !== "undefined"
    ? createRoomUrl(window.location.origin, invitation)
    : "";
  const safetyCode = activeRoom ? createSafetyCode(activeRoom.secret) : "";
  const copied = copiedRoomId === activeRoomId;

  useEffect(() => {
    const ownerPublicKey = activeRoom?.membership.ownerPublicKey;
    if (!activeRoom || !ownerPublicKey) return;
    const current = readRoomInvitation(window.location);
    if (
      current?.roomId === activeRoom.roomId
      && current.secret === activeRoom.secret
      && current.ownerPublicKey === ownerPublicKey
    ) return;
    window.history.replaceState(null, "", createRoomUrl(window.location.origin, {
      roomId: activeRoom.roomId,
      secret: activeRoom.secret,
      ownerPublicKey,
    }));
  }, [activeRoom]);

  const activateInvitation = (nextInvitation: RoomInvitation, nextNotice = "") => {
    cancelRecording();
    window.history.replaceState(null, "", createRoomUrl(window.location.origin, nextInvitation));
    activeRoomIdRef.current = nextInvitation.roomId;
    setActiveRoomId(nextInvitation.roomId);
    setDraft("");
    setPendingReply(null);
    setCopiedRoomId("");
    setGlobalNotice("");
    if (nextNotice) {
      const runtime = runtimesRef.current.get(nextInvitation.roomId);
      if (runtime) runtime.setNotice(nextNotice);
      else setGlobalNotice(nextNotice);
    }
  };

  const createRoom = async () => {
    try {
      const identity = await createRoomMemberIdentity();
      const nextInvitation = createUniqueRoomInvitation(storedRooms, identity.publicKey);
      const room = await upsertStoredRoom(nextInvitation, identity);
      if (!mountedRef.current) return;
      setStoredRooms((current) => replaceStoredRoom(current, room));
      activateInvitation(nextInvitation);
      bootstrapDiagnostics.report({
        stage: "client",
        code: "client.room.created",
        message: "已创建并保存双人房间成员凭证",
        details: { protocol: SIGNAL_POLICY.protocolVersion },
      });
    } catch {
      setGlobalNotice("无法创建并保存房间成员凭证，请检查浏览器是否允许 IndexedDB。");
    }
  };

  const createFreshRoom = () => {
    if (!window.confirm("创建一个新的双人聊天？当前房间会继续保持连接。")) return;
    void createRoom();
  };

  const openStoredRoom = (targetRoomId: string) => {
    if (targetRoomId === activeRoomIdRef.current) return;
    const savedRoom = storedRooms.find((room) => room.roomId === targetRoomId);
    if (!savedRoom) {
      setActiveNotice("这台设备上没有保存这个聊天。");
      return;
    }
    activateInvitation(
      {
        roomId: savedRoom.roomId,
        secret: savedRoom.secret,
        ownerPublicKey: savedRoom.membership.ownerPublicKey,
      },
      "已切换聊天，其他房间仍保持连接。",
    );
  };

  const submitText = (event: FormEvent) => {
    event.preventDefault();
    const content = draft.trim();
    if (!content) return;
    const replyTo = pendingReply?.roomId === activeRoomIdRef.current
      ? pendingReply.reference
      : undefined;
    setDraft("");
    setPendingReply(null);
    void sendMessage("text", content, replyTo ? { replyTo } : undefined);
  };

  const replyToMessage = (messageId: string) => {
    const roomId = activeRoomIdRef.current;
    const message = runtimesRef.current.get(roomId)
      ?.getSnapshot().messages.find((candidate) => candidate.id === messageId);
    if (!message) return;
    const fallbackNickname = message.author === "self"
      ? profileMetadataRef.current.profile.nickname
      : "对方";
    setPendingReply({
      roomId,
      reference: createMessageReplyReference(message, fallbackNickname),
    });
  };

  const sendAttachmentFile = async (kind: "image" | "file", file: File) => {
    const maxBytes = kind === "image" ? CHAT_POLICY.maxImageBytes : CHAT_POLICY.maxFileBytes;
    if (file.size > maxBytes) {
      setActiveNotice(`${kind === "image" ? "图片" : "Beta 文件"}最大支持 ${formatBytes(maxBytes)}。`);
      return false;
    }
    const targetRoomId = activeRoomIdRef.current;
    const runtime = runtimesRef.current.get(targetRoomId);
    if (!runtime) return false;
    try {
      if (file.size > CHAT_POLICY.maxInlineAttachmentBytes) {
        setRoomNotice(targetRoomId, `正在分片加密并发送${kind === "image" ? "大图片" : " Beta 文件"}…`);
        return await runtime.sendAttachment(kind, file, profileMetadataRef.current.profile);
      }
      const content = await readAsDataUrl(file);
      if (runtimesRef.current.get(targetRoomId) !== runtime) return false;
      return await runtime.send(kind, content, profileMetadataRef.current.profile, {
        fileName: file.name || (kind === "image" ? "图片" : "未命名文件"),
        fileSize: file.size,
        mimeType: file.type || "application/octet-stream",
      });
    } catch {
      setRoomNotice(targetRoomId, `${kind === "image" ? "图片" : "Beta 文件"}读取失败，请重新选择。`);
      return false;
    }
  };

  const chooseImage = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) await sendAttachmentFile("image", file);
  };

  const chooseFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) await sendAttachmentFile("file", file);
  };

  const pasteFile = async (file: File) => {
    const kind = file.type.startsWith("image/") ? "image" : "file";
    await sendAttachmentFile(kind, file);
  };

  const sendSticker = async (src: string, label: string) => {
    const targetRoomId = activeRoomIdRef.current;
    const runtime = runtimesRef.current.get(targetRoomId);
    if (!runtime) return false;
    try {
      const response = await fetch(src);
      if (!response.ok) throw new Error(`sticker ${response.status}`);
      const blob = await response.blob();
      if (blob.size > CHAT_POLICY.maxStickerBytes) {
        setActiveNotice("这个表情包文件过大，无法发送。");
        return false;
      }
      const content = await readAsDataUrl(blob);
      if (activeRoomIdRef.current !== targetRoomId || runtimesRef.current.get(targetRoomId) !== runtime) return false;
      await runtime.send("image", content, profileMetadataRef.current.profile, {
        fileName: `${label}.png`,
        fileSize: blob.size,
        mimeType: blob.type || "image/png",
      });
      return true;
    } catch {
      setActiveNotice("表情包加载失败，请重试。");
      return false;
    }
  };

  const copyInvite = async () => {
    try {
      if (!inviteUrl || !await copyText(inviteUrl)) throw new Error("copy failed");
      setCopiedRoomId(activeRoomIdRef.current);
      if (copyTimerRef.current !== undefined) window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = window.setTimeout(() => {
        copyTimerRef.current = undefined;
        setCopiedRoomId("");
      }, UI_POLICY.inviteCopyFeedbackMs);
    } catch {
      setActiveNotice("复制失败，请从浏览器地址栏复制完整邀请链接。");
    }
  };

  const clearLocalHistory = () => {
    const runtime = runtimesRef.current.get(activeRoomIdRef.current);
    if (!runtime || !runtime.getSnapshot().messages.length) {
      setActiveNotice("这台设备上还没有聊天记录。");
      return;
    }
    if (!window.confirm("只清除这台设备上当前聊天的记录，且无法恢复。确定继续吗？")) return;
    void runtime.clearHistory()
      .catch(() => setActiveNotice("清除失败，请检查浏览器是否允许本地存储。"));
  };

  const deleteLocalMessage = (messageId: string) => {
    const runtime = runtimesRef.current.get(activeRoomIdRef.current);
    if (!runtime) return;
    const message = runtime.getSnapshot().messages.find((candidate) => candidate.id === messageId);
    if (!message) return;
    if (!window.confirm("只从这台设备删除这条消息？对方的记录不会变化。")) return;
    if (pendingReply?.roomId === activeRoomIdRef.current
      && pendingReply.reference.messageId === messageId) {
      setPendingReply(null);
    }
    void runtime.deleteMessage(messageId);
  };

  const deleteLocalRoom = (roomId: string) => {
    const room = storedRooms.find((candidate) => candidate.roomId === roomId);
    if (!room) return false;
    if (!window.confirm("删除这台设备上的聊天、恢复密钥和本地记录？对方不会同步删除，且本机无法撤销。")) return false;

    void (async () => {
      const runtime = runtimesRef.current.get(roomId);
      runtime?.dispose();
      runtimesRef.current.delete(roomId);
      try {
        await deleteStoredRoom(roomId);
      } catch {
        setStoredRooms((current) => [...current]);
        setGlobalNotice("无法删除这个聊天，连接已恢复，请检查本机存储权限后重试。");
        return;
      }

      const remainingRooms = storedRooms.filter((candidate) => candidate.roomId !== roomId)
        .map((candidate, order) => ({ ...candidate, order }));
      setStoredRooms(remainingRooms);
      setRoomSnapshots((current) => {
        const next = { ...current };
        delete next[roomId];
        return next;
      });

      if (activeRoomIdRef.current !== roomId) {
        setActiveNotice("这个聊天已从本机删除，对方的聊天不会变化。");
        return;
      }

      const nextRoom = remainingRooms[0];
      if (nextRoom) {
        activateInvitation(
          {
            roomId: nextRoom.roomId,
            secret: nextRoom.secret,
            ownerPublicKey: nextRoom.membership.ownerPublicKey,
          },
          "上一个聊天已从本机删除。",
        );
      } else {
        window.history.replaceState(null, "", `${window.location.origin}${window.location.pathname}`);
        activeRoomIdRef.current = "";
        setActiveRoomId("");
        setDraft("");
        setGlobalNotice("聊天已从本机删除，对方的聊天不会变化。");
      }
    })();
    return true;
  };

  const conversations = storedRooms.map((room) => {
    const snapshot = roomSnapshots[room.roomId];
    return {
      roomId: room.roomId,
      lastOpenedAt: room.lastOpenedAt,
      title: room.title ?? `双人聊天 · ${room.roomId.slice(0, 5)}`,
      icon: room.icon ?? "2",
      connection: snapshot?.connection ?? "waiting",
      preview: messagePreview(snapshot?.messages.at(-1), snapshot?.connectionMode ?? "正在建立连接"),
    };
  });

  const updateProfile = (nextProfile: ChatProfile) => {
    const metadata: ProfileMetadata = {
      profile: nextProfile,
      revision: Math.max(profileMetadataRef.current.revision + 1, Date.now()),
      versionId: crypto.randomUUID(),
    };
    profileMetadataRef.current = metadata;
    setProfile(nextProfile);
    for (const runtime of runtimesRef.current.values()) runtime.updateLocalProfile(metadata);
    window.localStorage.removeItem(LEGACY_PROFILE_KEY);
    void saveLocalProfile(metadata)
      .then((storedMetadata) => {
        if (
          !mountedRef.current
          || compareProfileMetadataVersion(storedMetadata, profileMetadataRef.current) <= 0
        ) return;
        profileMetadataRef.current = storedMetadata;
        setProfile(storedMetadata.profile);
        for (const runtime of runtimesRef.current.values()) {
          runtime.updateLocalProfile(storedMetadata);
        }
      })
      .catch(() => setActiveNotice("无法把头像和昵称保存到这台设备。"));
  };

  const moveStoredRoom = (sourceRoomId: string, targetRoomId: string) => {
    const sourceIndex = storedRooms.findIndex((room) => room.roomId === sourceRoomId);
    const targetIndex = storedRooms.findIndex((room) => room.roomId === targetRoomId);
    if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return;
    const nextRooms = [...storedRooms];
    const [sourceRoom] = nextRooms.splice(sourceIndex, 1);
    nextRooms.splice(targetIndex, 0, sourceRoom);
    const orderedRooms = nextRooms.map((room, order) => ({ ...room, order }));
    setStoredRooms(orderedRooms);
    void persistStoredRoomOrder(orderedRooms)
      .catch(() => setActiveNotice("无法保存聊天顺序，请检查本机存储权限。"));
  };

  const updateStoredRoom = (roomId: string, patch: { title: string; icon: string }) => {
    const currentRoom = storedRooms.find((room) => room.roomId === roomId);
    if (!currentRoom) return;
    const currentMetadata = normalizeRoomMetadata(currentRoom);
    const roomPatch = {
      title: patch.title.trim(),
      icon: patch.icon,
    };
    const normalizedPatch = runtimesRef.current.get(roomId)?.updateRoomMetadata(roomPatch) ?? {
      ...roomPatch,
      revision: currentMetadata.revision + 1,
      versionId: crypto.randomUUID(),
    } satisfies RoomMetadata;
    setStoredRooms((current) => current.map((room) => room.roomId === roomId
      ? applyRoomMetadata(room, normalizedPatch)
      : room));
    void updateStoredRoomMetadata(roomId, normalizedPatch)
      .then((room) => setStoredRooms((current) => replaceStoredRoom(current, room)))
      .catch(() => setRoomNotice(roomId, "无法保存这个聊天的名称或图标。"));
  };

  return {
    view: activeRoomId === undefined ? "loading" : activeRoom ? "chat" : "landing",
    connection,
    connectionMode,
    messages,
    profile,
    peerProfile,
    draft,
    notice,
    copied,
    isRecording,
    replyingTo: pendingReply && pendingReply.roomId === activeRoomId
      ? pendingReply.reference
      : undefined,
    safetyCode,
    activeRoomId: activeRoom?.roomId ?? "",
    conversations,
    updateProfile,
    setDraft,
    replyToMessage,
    cancelReply: () => setPendingReply(null),
    clearNotice: () => {
      setGlobalNotice("");
      runtimesRef.current.get(activeRoomIdRef.current)?.setNotice("");
    },
    createRoom,
    createFreshRoom,
    openStoredRoom,
    moveStoredRoom,
    updateStoredRoom,
    submitText,
    chooseImage,
    chooseFile,
    pasteFile,
    sendSticker,
    startRecording,
    stopRecording,
    copyInvite,
    clearLocalHistory,
    deleteLocalMessage,
    deleteLocalRoom,
    reconnect,
    diagnostics,
  };
}

export type TwoOnlyChatController = ReturnType<typeof useTwoOnlyChat>;
