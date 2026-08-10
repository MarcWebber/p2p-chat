import { ChangeEvent, FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  ChatMessage,
  ConnectionState,
  DecryptedChatMessage,
  EncryptedWire,
  LegacyRole,
  MessageKind,
} from "@/src/chat/types";
import { createMessageCrypto, createSafetyCode, randomToken, type MessageCrypto } from "@/src/crypto/messageCrypto";
import { ConnectionDiagnostics } from "@/src/diagnostics/connectionDiagnostics";
import { MAX_FILE_BYTES, readAsDataUrl } from "@/src/media/files";
import { useAudioRecorder } from "@/src/media/useAudioRecorder";
import { createRoomInvitation, createRoomUrl, readRoomInvitation } from "@/src/room/invitation";
import { createSignalTransport, hasRemoteSignaling, type SignalTransport } from "@/src/signal/signalTransport";
import {
  clearEncryptedHistory,
  loadEncryptedHistory,
  markMessageAsSent,
  persistEncryptedMessage,
  wasMessageSentByThisTab,
} from "@/src/storage/chatStorage";
import { WebRtcSession } from "@/src/webrtc/WebRtcSession";
import { resolveIceConfiguration } from "@/src/webrtc/iceConfig";

function normalizeStoredMessage(
  message: DecryptedChatMessage,
  sentByThisTab: boolean,
  legacyRole: LegacyRole | undefined,
): ChatMessage {
  const legacyMine = legacyRole
    && (message.author === "host" || message.author === "guest")
    && message.author === legacyRole;
  return {
    ...message,
    author: sentByThisTab || legacyMine ? "self" : "peer",
  };
}

export function useTwoOnlyChat() {
  const [roomId, setRoomId] = useState("");
  const [secret, setSecret] = useState("");
  const [legacyRole, setLegacyRole] = useState<LegacyRole | undefined>(undefined);
  const [participantId, setParticipantId] = useState(() => `peer-${randomToken(12)}`);
  const [connection, setConnection] = useState<ConnectionState>("waiting");
  const [connectionMode, setConnectionMode] = useState("等待另一位成员");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState("");
  const [copied, setCopied] = useState(false);
  const [ready, setReady] = useState(false);
  const [diagnostics] = useState(() => new ConnectionDiagnostics());

  const sessionRef = useRef<WebRtcSession | null>(null);
  const transportRef = useRef<SignalTransport | null>(null);
  const messageCryptoRef = useRef<MessageCrypto | null>(null);
  const copyTimerRef = useRef<number | undefined>(undefined);

  const updateConnection = useCallback((state: ConnectionState, mode: string) => {
    setConnection(state);
    setConnectionMode(mode);
  }, []);

  const persistWire = useCallback((wire: EncryptedWire) => {
    if (!roomId) return;
    try {
      persistEncryptedMessage(roomId, wire);
    } catch {
      setNotice("本地空间不足，这条大文件消息没有写入历史记录。");
    }
  }, [roomId]);

  const sendMessage = useCallback(async (kind: MessageKind, content: string, fileName?: string) => {
    const messageCrypto = messageCryptoRef.current;
    if (!roomId || !messageCrypto) return;
    const message: ChatMessage = {
      id: crypto.randomUUID(),
      kind,
      content,
      author: "self",
      createdAt: Date.now(),
      fileName,
    };
    markMessageAsSent(roomId, message.id);
    const wire = await messageCrypto.encrypt(message);
    persistWire(wire);
    setMessages((current) => [...current, message]);
    if (!sessionRef.current?.send(wire)) {
      setNotice("消息已加密保存在本机；对方连接后发送的新消息会实时送达。");
    }
  }, [persistWire, roomId]);

  const sendAudio = useCallback(
    (content: string) => sendMessage("audio", content, "语音消息"),
    [sendMessage],
  );

  const { isRecording, startRecording, stopRecording, cancelRecording } = useAudioRecorder({
    sessionKey: roomId,
    onAudio: sendAudio,
    onNotice: setNotice,
  });

  useEffect(() => {
    const invitation = readRoomInvitation(window.location);
    if (invitation) {
      setRoomId(invitation.roomId);
      setSecret(invitation.secret);
      setLegacyRole(invitation.legacyRole);
      diagnostics.report({
        stage: "client",
        code: "client.invitation.ready",
        level: "success",
        message: "邀请信息解析完成",
        details: { protocol: 2, legacyLink: Boolean(invitation.legacyRole), online: navigator.onLine },
        dedupeKey: "invitation-ready",
      });
    } else {
      diagnostics.report({
        stage: "client",
        code: "client.landing.ready",
        message: "未检测到房间邀请，显示首页",
        details: { online: navigator.onLine },
        dedupeKey: "landing-ready",
      });
    }
    setReady(true);
  }, [diagnostics]);

  useEffect(() => {
    if (!roomId || !secret) return;

    let active = true;
    let transport: SignalTransport | null = null;
    diagnostics.report({
      stage: "client",
      code: "client.bootstrap.start",
      message: "开始初始化加密聊天连接",
      details: { protocol: 2, online: navigator.onLine },
    });
    const messageCrypto = createMessageCrypto(secret);
    messageCryptoRef.current = messageCrypto;
    diagnostics.report({
      stage: "client",
      code: "client.crypto.ready",
      level: "success",
      message: "本地消息加密器已就绪",
    });

    const acceptWire = async (wire: EncryptedWire) => {
      try {
        const decrypted = await messageCrypto.decrypt(wire);
        const message: ChatMessage = { ...decrypted, author: "peer" };
        if (!active) return;
        try {
          persistEncryptedMessage(roomId, wire);
        } catch {
          setNotice("本地空间不足，这条大文件消息没有写入历史记录。");
        }
        setMessages((current) => current.some((item) => item.id === message.id)
          ? current
          : [...current, message].sort((a, b) => a.createdAt - b.createdAt));
      } catch {
        if (active) setNotice("收到一条无法解密的消息，请核对邀请链接。");
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
        onConnectionChange: updateConnection,
        onNotice: setNotice,
        onDiagnostic: diagnostics.report,
      });
      session = createdSession;
      sessionRef.current = createdSession;

      transport = createSignalTransport({
        roomId,
        onMessage: createdSession.handleSignal,
        onDiagnostic: diagnostics.report,
        onStatus: (status) => {
          if (status === "subscribed") createdSession.onSignalReady();
          else createdSession.onSignalUnavailable();
        },
      });
      transportRef.current = transport;
      createdSession.start();
      transport.start();
    });

    void Promise.all(
      loadEncryptedHistory(roomId).map(async (wire) => {
        try {
          const message = await messageCrypto.decrypt(wire);
          return normalizeStoredMessage(
            message,
            wasMessageSentByThisTab(roomId, message.id),
            legacyRole,
          );
        } catch {
          return null;
        }
      }),
    ).then((items) => {
      if (!active) return;
      const history = items.filter((item): item is ChatMessage => Boolean(item));
      setMessages((current) => {
        const merged = new Map(history.map((message) => [message.id, message]));
        for (const message of current) merged.set(message.id, message);
        return [...merged.values()].sort((a, b) => a.createdAt - b.createdAt);
      });
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
      if (transportRef.current === transport) transportRef.current = null;
      if (sessionRef.current === session) sessionRef.current = null;
      if (messageCryptoRef.current === messageCrypto) messageCryptoRef.current = null;
    };
  }, [diagnostics, legacyRole, participantId, roomId, secret, updateConnection]);

  const reconnect = useCallback(() => {
    diagnostics.report({
      stage: "client",
      code: "client.reconnect.requested",
      message: "客户端请求立即重新握手",
      details: { online: navigator.onLine },
    });
    sessionRef.current?.reconnect(false);
  }, [diagnostics]);
  const clearNotice = useCallback(() => setNotice(""), []);

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

  const inviteUrl = useMemo(() => {
    if (!roomId || !secret || typeof window === "undefined") return "";
    return createRoomUrl(window.location.origin, { roomId, secret });
  }, [roomId, secret]);

  const safetyCode = useMemo(() => secret ? createSafetyCode(secret) : "", [secret]);

  const createRoom = useCallback(() => {
    cancelRecording();
    sessionRef.current?.dispose();
    const invitation = createRoomInvitation();
    window.history.replaceState(null, "", createRoomUrl(window.location.origin, invitation));
    setParticipantId(`peer-${randomToken(12)}`);
    setRoomId(invitation.roomId);
    setSecret(invitation.secret);
    setLegacyRole(undefined);
    setConnection("waiting");
    setConnectionMode("等待另一位成员");
    setMessages([]);
    setDraft("");
    setCopied(false);
    setNotice("");
    diagnostics.report({
      stage: "client",
      code: "client.room.created",
      message: "已创建新的无角色双人会话",
      details: { protocol: 2 },
    });
  }, [cancelRecording, diagnostics]);

  const createFreshRoom = useCallback(() => {
    if (!window.confirm("创建新聊天将离开当前会话；已保存的记录仍保留在本机。继续吗？")) return;
    createRoom();
  }, [createRoom]);

  const submitText = useCallback((event: FormEvent) => {
    event.preventDefault();
    const content = draft.trim();
    if (!content) return;
    setDraft("");
    void sendMessage("text", content);
  }, [draft, sendMessage]);

  const chooseImage = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) {
      setNotice("为了保证点对点传输稳定，当前版本仅支持 1.5 MB 以内的图片。");
      return;
    }
    await sendMessage("image", await readAsDataUrl(file), file.name);
  }, [sendMessage]);

  const copyInvite = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopied(true);
      if (copyTimerRef.current !== undefined) window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = window.setTimeout(() => setCopied(false), 1_600);
    } catch {
      setNotice("复制失败，请从浏览器地址栏复制完整邀请链接。");
    }
  }, [inviteUrl]);

  const clearLocalHistory = useCallback(() => {
    if (!messages.length) {
      setNotice("这台设备上还没有聊天记录。");
      return;
    }
    if (!window.confirm("只清除这台设备上的聊天记录，且无法恢复。确定继续吗？")) return;
    clearEncryptedHistory(roomId);
    setMessages([]);
    setNotice("这台设备上的加密历史已经清除。");
  }, [messages.length, roomId]);

  return {
    ready,
    hasRemoteSignaling: hasRemoteSignaling(),
    inRoom: Boolean(roomId && secret),
    connection,
    connectionMode,
    messages,
    draft,
    notice,
    copied,
    isRecording,
    safetyCode,
    setDraft,
    clearNotice,
    createRoom,
    createFreshRoom,
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
