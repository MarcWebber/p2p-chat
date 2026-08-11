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
} from "@/src/room/invitation";
import { createSignalTransport } from "@/src/signal/signalTransport";
import {
  clearEncryptedHistory,
  loadEncryptedHistory,
  markMessageAsSent,
  persistEncryptedMessage,
  wasMessageSentByThisTab,
} from "@/src/storage/chatStorage";
import { copyText, readAsDataUrl } from "@/src/utils/browser";
import { formatBytes } from "@/src/utils/format";
import { WebRtcSession } from "@/src/webrtc/WebRtcSession";
import { resolveIceConfiguration } from "@/src/webrtc/iceConfig";

export function useTwoOnlyChat() {
  const [invitation, setInvitation] = useState<ReturnType<typeof readRoomInvitation>>();
  const roomId = invitation?.roomId ?? "";
  const secret = invitation?.secret ?? "";
  const legacyRole = invitation?.legacyRole;
  const [participantId, setParticipantId] = useState(createParticipantId);
  const [connection, setConnection] = useState<ConnectionState>("waiting");
  const [connectionMode, setConnectionMode] = useState("等待另一位成员");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState("");
  const [copied, setCopied] = useState(false);
  const [diagnostics] = useState(() => new ConnectionDiagnostics());

  const sessionRef = useRef<WebRtcSession | null>(null);
  const messageCryptoRef = useRef<ReturnType<typeof createMessageCrypto> | null>(null);
  const copyTimerRef = useRef<number | undefined>(undefined);

  const sendMessage = async (kind: MessageKind, content: string, fileName?: string) => {
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
    if (!persistEncryptedMessage(roomId, wire)) {
      setNotice("本地空间不足，这条大文件消息没有写入历史记录。");
    }
    setMessages((current) => [...current, message]);
    if (!sessionRef.current?.send(wire)) {
      setNotice("消息已加密保存在本机；对方连接后发送的新消息会实时送达。");
    }
  };

  const { isRecording, startRecording, stopRecording, cancelRecording } = useAudioRecorder({
    sessionKey: roomId,
    onAudio: (content) => sendMessage("audio", content, "语音消息"),
    onNotice: setNotice,
  });

  useEffect(() => {
    const currentInvitation = readRoomInvitation(window.location);
    if (currentInvitation) {
      diagnostics.report({
        stage: "client",
        code: "client.invitation.ready",
        level: "success",
        message: "邀请信息解析完成",
        details: {
          protocol: SIGNAL_POLICY.protocolVersion,
          legacyLink: Boolean(currentInvitation.legacyRole),
          online: navigator.onLine,
        },
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
    setInvitation(currentInvitation);
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
        if (!persistEncryptedMessage(roomId, wire)) {
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

    void Promise.all(
      loadEncryptedHistory(roomId).map(async (wire) => {
        try {
          const message = await messageCrypto.decrypt(wire);
          const mine = wasMessageSentByThisTab(roomId, message.id) || message.author === legacyRole;
          return { ...message, author: mine ? "self" : "peer" } satisfies ChatMessage;
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
      if (sessionRef.current === session) sessionRef.current = null;
      if (messageCryptoRef.current === messageCrypto) messageCryptoRef.current = null;
    };
  }, [diagnostics, legacyRole, participantId, roomId, secret]);

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

  const createRoom = () => {
    cancelRecording();
    sessionRef.current?.dispose();
    const nextInvitation = createRoomInvitation();
    window.history.replaceState(null, "", createRoomUrl(window.location.origin, nextInvitation));
    setParticipantId(createParticipantId());
    setInvitation(nextInvitation);
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
      details: { protocol: SIGNAL_POLICY.protocolVersion },
    });
  };

  const createFreshRoom = () => {
    if (!window.confirm("创建新聊天将离开当前会话；已保存的记录仍保留在本机。继续吗？")) return;
    createRoom();
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
    await sendMessage("image", await readAsDataUrl(file), file.name);
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
    clearEncryptedHistory(roomId);
    setMessages([]);
    setNotice("这台设备上的加密历史已经清除。");
  };

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
    setDraft,
    clearNotice: () => setNotice(""),
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
