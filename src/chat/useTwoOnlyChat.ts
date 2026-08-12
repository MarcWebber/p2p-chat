import { useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";

import { RoomRuntime, type RoomRuntimeSnapshot } from "@/src/chat/roomRuntime";
import type { ChatMessage, ChatProfile, MessageKind } from "@/src/chat/types";
import { CHAT_POLICY, SIGNAL_POLICY, UI_POLICY } from "@/src/config/policy";
import { createSafetyCode } from "@/src/crypto/messageCrypto";
import { ConnectionDiagnostics } from "@/src/diagnostics/connectionDiagnostics";
import { useAudioRecorder } from "@/src/media/useAudioRecorder";
import {
  createRoomInvitation,
  createRoomUrl,
  readRoomInvitation,
  type RoomInvitation,
} from "@/src/room/invitation";
import {
  listStoredRooms,
  loadLocalProfile,
  persistStoredRoomOrder,
  saveLocalProfile,
  updateStoredRoomMetadata,
  upsertStoredRoom,
  type StoredRoom,
} from "@/src/storage/chatStorage";
import { copyText, readAsDataUrl } from "@/src/utils/browser";
import { formatBytes } from "@/src/utils/format";

const LEGACY_PROFILE_KEY = "twoonly.profile";
const DEFAULT_PROFILE: ChatProfile = { nickname: "我", avatar: "🙂" };
const EMPTY_MESSAGES: ChatMessage[] = [];

function replaceStoredRoom(rooms: StoredRoom[], replacement: StoredRoom) {
  return [...rooms.filter((room) => room.roomId !== replacement.roomId), replacement]
    .sort((left, right) => left.order - right.order);
}

function createUniqueRoomInvitation(rooms: StoredRoom[]) {
  let invitation = createRoomInvitation();
  const roomIds = new Set(rooms.map((room) => room.roomId));
  while (roomIds.has(invitation.roomId)) invitation = createRoomInvitation();
  return invitation;
}

function messagePreview(message: ChatMessage | undefined, connectionMode: string) {
  if (!message) return connectionMode;
  if (message.kind === "text") return message.content;
  return message.kind === "audio" ? "[语音消息]" : "[图片]";
}

export function useTwoOnlyChat() {
  const [activeRoomId, setActiveRoomId] = useState<string | undefined>();
  const [storedRooms, setStoredRooms] = useState<StoredRoom[]>([]);
  const [roomSnapshots, setRoomSnapshots] = useState<Record<string, RoomRuntimeSnapshot>>({});
  const [profile, setProfile] = useState(DEFAULT_PROFILE);
  const [draft, setDraft] = useState("");
  const [globalNotice, setGlobalNotice] = useState("");
  const [copiedRoomId, setCopiedRoomId] = useState("");
  const [bootstrapDiagnostics] = useState(() => new ConnectionDiagnostics());

  const runtimesRef = useRef(new Map<string, RoomRuntime>());
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

  const sendMessage = async (kind: MessageKind, content: string, fileName?: string) => {
    const runtime = runtimesRef.current.get(activeRoomIdRef.current);
    if (!runtime) return;
    await runtime.send(kind, content, profile, fileName);
  };

  const { isRecording, startRecording, stopRecording, cancelRecording } = useAudioRecorder({
    sessionKey: activeRoomId ?? "",
    onAudio: (content) => sendMessage("audio", content, "语音消息"),
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
              savedProfile = { nickname: candidate.nickname.trim(), avatar: candidate.avatar };
              await saveLocalProfile(savedProfile);
            }
          } catch {
            // Ignore malformed legacy localStorage data.
          }
          window.localStorage.removeItem(LEGACY_PROFILE_KEY);
        }
      }
      if (active && savedProfile) setProfile(savedProfile);
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
            nextInvitation = { roomId: savedRoom.roomId, secret: savedRoom.secret };
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
      } catch {
        if (!active) return;
        const fallbackRooms: StoredRoom[] = urlInvitation
          ? [{ ...urlInvitation, lastOpenedAt: Date.now(), order: 0 }]
          : [];
        setStoredRooms(fallbackRooms);
        setActiveRoomId(urlInvitation?.roomId ?? "");
        setGlobalNotice(urlInvitation
          ? "IndexedDB 不可用；当前仍可聊天，但刷新后不能恢复。"
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
        onChange: (snapshot) => {
          if (!mountedRef.current) return;
          setRoomSnapshots((current) => ({ ...current, [snapshot.roomId]: snapshot }));
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
  const notice = activeSnapshot?.notice || globalNotice;
  const diagnostics = activeSnapshot?.diagnostics ?? bootstrapDiagnostics;
  const invitation: RoomInvitation | null = activeRoom
    ? { roomId: activeRoom.roomId, secret: activeRoom.secret }
    : null;
  const inviteUrl = invitation && typeof window !== "undefined"
    ? createRoomUrl(window.location.origin, invitation)
    : "";
  const safetyCode = activeRoom ? createSafetyCode(activeRoom.secret) : "";
  const copied = copiedRoomId === activeRoomId;

  const activateInvitation = (nextInvitation: RoomInvitation, nextNotice = "") => {
    cancelRecording();
    window.history.replaceState(null, "", createRoomUrl(window.location.origin, nextInvitation));
    activeRoomIdRef.current = nextInvitation.roomId;
    setActiveRoomId(nextInvitation.roomId);
    setDraft("");
    setCopiedRoomId("");
    setGlobalNotice("");
    if (nextNotice) {
      const runtime = runtimesRef.current.get(nextInvitation.roomId);
      if (runtime) runtime.setNotice(nextNotice);
      else setGlobalNotice(nextNotice);
    }
  };

  const createRoom = () => {
    const nextInvitation = createUniqueRoomInvitation(storedRooms);
    const pendingRoom: StoredRoom = {
      ...nextInvitation,
      lastOpenedAt: Date.now(),
      order: storedRooms.length,
    };
    setStoredRooms((current) => replaceStoredRoom(current, pendingRoom));
    activateInvitation(nextInvitation);
    void upsertStoredRoom(nextInvitation)
      .then((room) => setStoredRooms((current) => replaceStoredRoom(current, room)))
      .catch(() => setRoomNotice(nextInvitation.roomId, "无法保存恢复密钥，请保留当前完整邀请链接。"));
    bootstrapDiagnostics.report({
      stage: "client",
      code: "client.room.created",
      message: "已创建新的双人房间，原有房间继续保持连接",
      details: { protocol: SIGNAL_POLICY.protocolVersion },
    });
  };

  const createFreshRoom = () => {
    if (!window.confirm("创建一个新的双人聊天？当前房间会继续保持连接。")) return;
    createRoom();
  };

  const openStoredRoom = (targetRoomId: string) => {
    if (targetRoomId === activeRoomIdRef.current) return;
    const savedRoom = storedRooms.find((room) => room.roomId === targetRoomId);
    if (!savedRoom) {
      setActiveNotice("这台设备上没有保存这个聊天。");
      return;
    }
    activateInvitation(
      { roomId: savedRoom.roomId, secret: savedRoom.secret },
      "已切换聊天，其他房间仍保持连接。",
    );
  };

  const submitText = (event: FormEvent) => {
    event.preventDefault();
    const content = draft.trim();
    if (!content) return;
    setDraft("");
    void sendMessage("text", content);
  };

  const chooseImage = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > CHAT_POLICY.maxAttachmentBytes) {
      setActiveNotice(`为了保证点对点传输稳定，当前版本仅支持 ${formatBytes(CHAT_POLICY.maxAttachmentBytes)} 以内的图片。`);
      return;
    }
    const targetRoomId = activeRoomIdRef.current;
    const runtime = runtimesRef.current.get(targetRoomId);
    if (!runtime) return;
    const content = await readAsDataUrl(file);
    if (activeRoomIdRef.current !== targetRoomId || runtimesRef.current.get(targetRoomId) !== runtime) return;
    await runtime.send("image", content, profile, file.name);
  };

  const sendSticker = async (src: string, label: string) => {
    const targetRoomId = activeRoomIdRef.current;
    const runtime = runtimesRef.current.get(targetRoomId);
    if (!runtime) return false;
    try {
      const response = await fetch(src);
      if (!response.ok) throw new Error(`sticker ${response.status}`);
      const blob = await response.blob();
      if (blob.size > CHAT_POLICY.maxAttachmentBytes) {
        setActiveNotice("这个表情包文件过大，无法发送。");
        return false;
      }
      const content = await readAsDataUrl(blob);
      if (activeRoomIdRef.current !== targetRoomId || runtimesRef.current.get(targetRoomId) !== runtime) return false;
      await runtime.send("image", content, profile, `${label}.png`);
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
    setProfile(nextProfile);
    window.localStorage.removeItem(LEGACY_PROFILE_KEY);
    void saveLocalProfile(nextProfile)
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
    const normalizedPatch = {
      title: patch.title.trim(),
      icon: patch.icon,
    };
    setStoredRooms((current) => current.map((room) => room.roomId === roomId
      ? { ...room, ...normalizedPatch }
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
    draft,
    notice,
    copied,
    isRecording,
    safetyCode,
    activeRoomId: activeRoom?.roomId ?? "",
    conversations,
    updateProfile,
    setDraft,
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
    sendSticker,
    startRecording,
    stopRecording,
    copyInvite,
    clearLocalHistory,
    reconnect,
    diagnostics,
  };
}

export type TwoOnlyChatController = ReturnType<typeof useTwoOnlyChat>;
