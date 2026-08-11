import { useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";

import type {
  ChatMessage,
  ConnectionState,
  EncryptedWire,
  MessageKind,
} from "@/src/chat/types";
import { CHAT_POLICY, SIGNAL_POLICY, UI_POLICY } from "@/src/config/policy";
import { createMessageCrypto, createSafetyCode } from "@/src/crypto/messageCrypto";
import { ConnectionDiagnostics } from "@/src/diagnostics/connectionDiagnostics";
import { useAudioRecorder } from "@/src/media/useAudioRecorder";
import {
  createParticipantId,
  createRoomInvitation,
  createRoomUrl,
  readRoomInvitation,
  type RoomInvitation,
} from "@/src/room/invitation";
import { createSignalTransport } from "@/src/signal/signalTransport";
import {
  clearEncryptedHistory,
  listStoredRooms,
  loadEncryptedHistory,
  persistEncryptedMessage,
  upsertStoredRoom,
  type StoredRoom,
} from "@/src/storage/chatStorage";
import { copyText, readAsDataUrl } from "@/src/utils/browser";
import { formatBytes } from "@/src/utils/format";
import { WebRtcSession } from "@/src/webrtc/WebRtcSession";
import { resolveIceConfiguration } from "@/src/webrtc/iceConfig";

function replaceStoredRoom(rooms: StoredRoom[], replacement: StoredRoom) {
  return [...rooms.filter((room) => room.roomId !== replacement.roomId), replacement]
    .sort((left, right) => right.lastOpenedAt - left.lastOpenedAt);
}

export function useTwoOnlyChat() {
  const [invitation, setInvitation] = useState<ReturnType<typeof readRoomInvitation>>();
  const roomId = invitation?.roomId ?? "";
  const secret = invitation?.secret ?? "";
  const [participantId, setParticipantId] = useState(createParticipantId);
  const [connection, setConnection] = useState<ConnectionState>("waiting");
  const [connectionMode, setConnectionMode] = useState("等待另一位成员");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [storedRooms, setStoredRooms] = useState<StoredRoom[]>([]);
  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState("");
  const [copied, setCopied] = useState(false);
  const [diagnostics] = useState(() => new ConnectionDiagnostics());

  const sessionRef = useRef<WebRtcSession | null>(null);
  const messageCryptoRef = useRef<{
    roomId: string;
    crypto: ReturnType<typeof createMessageCrypto>;
  } | null>(null);
  const copyTimerRef = useRef<number | undefined>(undefined);

  const sendMessage = async (kind: MessageKind, content: string, fileName?: string) => {
    const activeCrypto = messageCryptoRef.current;
    const session = sessionRef.current;
    if (!roomId || activeCrypto?.roomId !== roomId) return;
    const message: ChatMessage = {
      id: crypto.randomUUID(),
      kind,
      content,
      author: "self",
      createdAt: Date.now(),
      fileName,
    };
    const wire = await activeCrypto.crypto.encrypt(message);
    if (messageCryptoRef.current !== activeCrypto) return;
    setMessages((current) => [...current, message]);
    const delivered = sessionRef.current === session && Boolean(session?.send(wire));
    if (!delivered) {
      setNotice("消息已加密保存在本机；对方连接后发送的新消息会实时送达。");
    }
    try {
      await persistEncryptedMessage(roomId, wire, "self");
    } catch {
      if (messageCryptoRef.current === activeCrypto) {
        setNotice("本机存储空间不可用，这条消息只保留在当前页面中。");
      }
    }
  };

  const { isRecording, startRecording, stopRecording, cancelRecording } = useAudioRecorder({
    sessionKey: roomId,
    onAudio: (content) => sendMessage("audio", content, "语音消息"),
    onNotice: setNotice,
  });

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
            const openedRoom = await upsertStoredRoom(savedRoom);
            rooms = replaceStoredRoom(rooms, openedRoom);
            nextInvitation = { roomId: openedRoom.roomId, secret: openedRoom.secret };
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
        setInvitation(nextInvitation);
        if (missingRequestedRoom) {
          setNotice("这台设备上没有保存这个房间，请使用完整邀请链接进入。");
        } else if (restored) {
          setNotice("已从这台设备恢复上次聊天。");
        }
        diagnostics.report({
          stage: "client",
          code: "client.storage.ready",
          level: "success",
          message: "本机会话存储已就绪",
          details: { backend: "indexeddb", savedRooms: rooms.length },
          dedupeKey: "storage-ready",
        });

        if (nextInvitation) {
          diagnostics.report({
            stage: "client",
            code: restored ? "client.invitation.restored" : "client.invitation.ready",
            level: "success",
            message: restored ? "已从本机恢复最近会话" : "邀请信息解析完成",
            details: { protocol: SIGNAL_POLICY.protocolVersion, online: navigator.onLine },
            dedupeKey: "invitation-ready",
          });
        } else {
          diagnostics.report({
            stage: "client",
            code: "client.landing.ready",
            message: "没有可自动恢复的房间，显示首页",
            details: { online: navigator.onLine },
            dedupeKey: "landing-ready",
          });
        }
      } catch {
        if (!active) return;
        setStoredRooms([]);
        setInvitation(urlInvitation);
        setNotice(urlInvitation
          ? "IndexedDB 不可用；当前仍可聊天，但刷新后不能恢复。"
          : "无法读取这台设备上的聊天，请检查浏览器是否允许 IndexedDB。");
        diagnostics.report({
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
  }, [diagnostics]);

  useEffect(() => {
    if (!roomId || !secret) return;

    let active = true;
    let transport: ReturnType<typeof createSignalTransport> | null = null;
    diagnostics.report({
      stage: "client",
      code: "client.bootstrap.start",
      message: "开始初始化加密聊天连接",
      details: { protocol: SIGNAL_POLICY.protocolVersion, online: navigator.onLine },
    });
    const activeCrypto = {
      roomId,
      crypto: createMessageCrypto(secret),
    };
    messageCryptoRef.current = activeCrypto;
    diagnostics.report({
      stage: "client",
      code: "client.crypto.ready",
      level: "success",
      message: "本地消息加密器已就绪",
    });

    const acceptWire = async (wire: EncryptedWire) => {
      let message: ChatMessage;
      try {
        message = { ...await activeCrypto.crypto.decrypt(wire), author: "peer" };
      } catch {
        if (active) setNotice("收到一条无法解密的消息，请核对邀请链接。");
        return;
      }
      if (!active) return;
      setMessages((current) => current.some((item) => item.id === message.id)
        ? current
        : [...current, message].sort((a, b) => a.createdAt - b.createdAt));
      try {
        await persistEncryptedMessage(roomId, wire, "peer");
      } catch {
        if (active) setNotice("本机存储空间不可用，这条消息只保留在当前页面中。");
      }
    };

    let session: WebRtcSession | null = null;
    void resolveIceConfiguration(diagnostics.report).then(({ configuration, turnConfigured }) => {
      if (!active) return;
      const createdSession = new WebRtcSession({
        participantId,
        iceConfiguration: configuration,
        turnConfigured,
        sendSignal: (message) => transport?.send(message),
        onWire: (wire) => void acceptWire(wire),
        onConnectionChange: (state, mode) => {
          setConnection(state);
          setConnectionMode(mode);
          transport?.setNegotiationActive(state !== "connected");
        },
        onNotice: setNotice,
        onDiagnostic: diagnostics.report,
      });
      session = createdSession;
      sessionRef.current = createdSession;

      const createdTransport = createSignalTransport({
        roomId,
        participantId,
        secret,
        onMessage: createdSession.handleSignal,
        onDiagnostic: diagnostics.report,
        onStatus: (status) => {
          if (status === "subscribed") createdSession.onSignalReady();
          else createdSession.onSignalUnavailable();
        },
      });
      transport = createdTransport;
      createdTransport.start();
    });

    void loadEncryptedHistory(roomId).then((records) => Promise.all(
      records.map(async ({ wire, localDirection }) => ({
        ...await activeCrypto.crypto.decrypt(wire),
        author: localDirection,
      } satisfies ChatMessage)),
    )).then((history) => {
      if (!active) return;
      setMessages((current) => {
        const merged = new Map(history.map((message) => [message.id, message]));
        for (const message of current) merged.set(message.id, message);
        return [...merged.values()].sort((a, b) => a.createdAt - b.createdAt);
      });
    }).catch(() => {
      if (active) setNotice("无法读取这台设备上的聊天记录。");
    });

    return () => {
      active = false;
      diagnostics.report({
        stage: "client",
        code: "client.bootstrap.dispose",
        message: "释放当前房间的连接资源",
      });
      transport?.dispose();
      session?.dispose();
      if (sessionRef.current === session) sessionRef.current = null;
      if (messageCryptoRef.current === activeCrypto) messageCryptoRef.current = null;
    };
  }, [diagnostics, participantId, roomId, secret]);

  const reconnect = useCallback(() => {
    diagnostics.report({
      stage: "client",
      code: "client.reconnect.requested",
      message: "客户端请求立即重新握手",
      details: { online: navigator.onLine },
    });
    sessionRef.current?.reconnect(false);
  }, [diagnostics]);

  useEffect(() => {
    window.addEventListener("online", reconnect);
    const onOffline = () => diagnostics.report({
      stage: "client",
      code: "client.network.offline",
      level: "warn",
      message: "浏览器报告网络离线",
    });
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", reconnect);
      window.removeEventListener("offline", onOffline);
    };
  }, [diagnostics, reconnect]);

  useEffect(() => () => {
    if (copyTimerRef.current !== undefined) window.clearTimeout(copyTimerRef.current);
  }, []);

  const inviteUrl = invitation && typeof window !== "undefined"
    ? createRoomUrl(window.location.origin, invitation)
    : "";
  const safetyCode = secret ? createSafetyCode(secret) : "";

  const activateInvitation = (nextInvitation: RoomInvitation, nextNotice = "") => {
    cancelRecording();
    sessionRef.current?.dispose();
    sessionRef.current = null;
    messageCryptoRef.current = null;
    window.history.replaceState(null, "", createRoomUrl(window.location.origin, nextInvitation));
    setParticipantId(createParticipantId());
    setInvitation(nextInvitation);
    setConnection("waiting");
    setConnectionMode("等待另一位成员");
    setMessages([]);
    setDraft("");
    setCopied(false);
    setNotice(nextNotice);
  };

  const createRoom = () => {
    const nextInvitation = createRoomInvitation();
    activateInvitation(nextInvitation);
    void upsertStoredRoom(nextInvitation)
      .then((room) => setStoredRooms((current) => replaceStoredRoom(current, room)))
      .catch(() => setNotice("无法保存恢复密钥，请保留当前完整邀请链接。"));
    diagnostics.report({
      stage: "client",
      code: "client.room.created",
      message: "已创建新的无角色双人会话",
      details: { protocol: SIGNAL_POLICY.protocolVersion },
    });
  };

  const createFreshRoom = () => {
    if (!window.confirm("创建新聊天将离开当前会话；已保存的记录仍保留在本机。继续吗？")) return;
    createRoom();
  };

  const openStoredRoom = (targetRoomId: string) => {
    if (targetRoomId === roomId) return;
    const savedRoom = storedRooms.find((room) => room.roomId === targetRoomId);
    if (!savedRoom) {
      setNotice("这台设备上没有保存这个聊天。");
      return;
    }
    activateInvitation(
      { roomId: savedRoom.roomId, secret: savedRoom.secret },
      "已从这台设备恢复聊天。",
    );
    void upsertStoredRoom(savedRoom)
      .then((room) => {
        setStoredRooms((current) => replaceStoredRoom(current, room));
      })
      .catch(() => setNotice("无法更新这个本机会话。"));
    diagnostics.report({
      stage: "client",
      code: "client.room.restored",
      level: "success",
      message: "用户从本机会话列表恢复聊天",
    });
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
      setNotice(`为了保证点对点传输稳定，当前版本仅支持 ${formatBytes(CHAT_POLICY.maxAttachmentBytes)} 以内的图片。`);
      return;
    }
    const activeCrypto = messageCryptoRef.current;
    if (!activeCrypto) return;
    const content = await readAsDataUrl(file);
    if (messageCryptoRef.current !== activeCrypto) return;
    await sendMessage("image", content, file.name);
  };

  const copyInvite = async () => {
    try {
      if (!await copyText(inviteUrl)) throw new Error("copy failed");
      setCopied(true);
      if (copyTimerRef.current !== undefined) window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = window.setTimeout(() => setCopied(false), UI_POLICY.inviteCopyFeedbackMs);
    } catch {
      setNotice("复制失败，请从浏览器地址栏复制完整邀请链接。");
    }
  };

  const clearLocalHistory = () => {
    if (!messages.length) {
      setNotice("这台设备上还没有聊天记录。");
      return;
    }
    if (!window.confirm("只清除这台设备上的聊天记录，且无法恢复。确定继续吗？")) return;
    void clearEncryptedHistory(roomId)
      .then(() => {
        setMessages([]);
        setNotice("这台设备上的加密历史已经清除。");
      })
      .catch(() => setNotice("清除失败，请检查浏览器是否允许本地存储。"));
  };

  const conversations = storedRooms.map((room) => ({
    roomId: room.roomId,
    lastOpenedAt: room.lastOpenedAt,
  }));

  return {
    view: invitation === undefined ? "loading" : invitation ? "chat" : "landing",
    connection,
    connectionMode,
    messages,
    draft,
    notice,
    copied,
    isRecording,
    safetyCode,
    activeRoomId: roomId,
    conversations,
    setDraft,
    clearNotice: () => setNotice(""),
    createRoom,
    createFreshRoom,
    openStoredRoom,
    submitText,
    chooseImage,
    startRecording,
    stopRecording,
    copyInvite,
    clearLocalHistory,
    reconnect,
    diagnostics,
  };
}

export type TwoOnlyChatController = ReturnType<typeof useTwoOnlyChat>;
