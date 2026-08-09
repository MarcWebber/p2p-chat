import { ChangeEvent, FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ChatMessage, ConnectionState, EncryptedWire, MessageKind, Role } from "@/src/chat/types";
import { createMessageCrypto, createSafetyCode, randomToken, type MessageCrypto } from "@/src/crypto/messageCrypto";
import { MAX_FILE_BYTES, readAsDataUrl } from "@/src/media/files";
import { useAudioRecorder } from "@/src/media/useAudioRecorder";
import { createGuestInviteUrl, createHostRoom, createRoomUrl, readRoomInvitation } from "@/src/room/invitation";
import { createSignalTransport, hasRemoteSignaling, type SignalTransport } from "@/src/signal/signalTransport";
import { clearEncryptedHistory, getOrCreateSenderId, loadEncryptedHistory, persistEncryptedMessage, saveSenderId } from "@/src/storage/chatStorage";
import { WebRtcSession } from "@/src/webrtc/WebRtcSession";

export function useTwoOnlyChat() {
  const [role, setRole] = useState<Role | null>(null);
  const [roomId, setRoomId] = useState("");
  const [secret, setSecret] = useState("");
  const [connection, setConnection] = useState<ConnectionState>("waiting");
  const [connectionMode, setConnectionMode] = useState("等待另一位成员");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState("");
  const [copied, setCopied] = useState(false);
  const [ready, setReady] = useState(false);

  const senderIdRef = useRef("");
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
    if (!role || !messageCrypto) return;
    const message: ChatMessage = {
      id: crypto.randomUUID(),
      kind,
      content,
      author: role,
      createdAt: Date.now(),
      fileName,
    };
    const wire = await messageCrypto.encrypt(message);
    persistWire(wire);
    setMessages((current) => [...current, message]);
    if (!sessionRef.current?.send(wire)) {
      setNotice("消息已加密保存在本机；对方连接后发送的新消息会实时送达。");
    }
  }, [persistWire, role]);

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
      const senderId = getOrCreateSenderId(
        invitation.roomId,
        invitation.role,
        () => `${invitation.role}-${randomToken(8)}`,
      );
      senderIdRef.current = senderId;
      setRole(invitation.role);
      setRoomId(invitation.roomId);
      setSecret(invitation.secret);
    }
    setReady(true);
  }, []);

  useEffect(() => {
    if (!role || !roomId || !secret) return;

    let active = true;
    let transport: SignalTransport | null = null;
    const messageCrypto = createMessageCrypto(secret);
    messageCryptoRef.current = messageCrypto;

    const acceptWire = async (wire: EncryptedWire) => {
      try {
        const message = await messageCrypto.decrypt(wire);
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

    const session = new WebRtcSession({
      role,
      senderId: senderIdRef.current || `${role}-${randomToken(8)}`,
      sendSignal: (message) => transport?.send(message),
      onWire: (wire) => void acceptWire(wire),
      onConnectionChange: updateConnection,
      onNotice: setNotice,
    });
    sessionRef.current = session;

    transport = createSignalTransport({
      roomId,
      onMessage: session.handleSignal,
      onStatus: (status) => {
        if (status === "subscribed") session.onSignalReady();
        else session.onSignalUnavailable();
      },
    });
    transportRef.current = transport;
    session.start();
    transport.start();

    void Promise.all(
      loadEncryptedHistory(roomId).map((wire) => messageCrypto.decrypt(wire).catch(() => null)),
    ).then((items) => {
      if (!active) return;
      setMessages(
        items
          .filter((item): item is ChatMessage => Boolean(item))
          .sort((a, b) => a.createdAt - b.createdAt),
      );
    });

    return () => {
      active = false;
      transport?.dispose();
      session.dispose();
      if (transportRef.current === transport) transportRef.current = null;
      if (sessionRef.current === session) sessionRef.current = null;
      if (messageCryptoRef.current === messageCrypto) messageCryptoRef.current = null;
    };
  }, [role, roomId, secret, updateConnection]);

  const reconnect = useCallback(() => sessionRef.current?.reconnect(false), []);
  const clearNotice = useCallback(() => setNotice(""), []);

  useEffect(() => {
    window.addEventListener("online", reconnect);
    return () => window.removeEventListener("online", reconnect);
  }, [reconnect]);

  useEffect(() => () => {
    if (copyTimerRef.current !== undefined) window.clearTimeout(copyTimerRef.current);
  }, []);

  const inviteUrl = useMemo(() => {
    if (!roomId || !secret || typeof window === "undefined") return "";
    return createGuestInviteUrl(window.location.origin, roomId, secret);
  }, [roomId, secret]);

  const safetyCode = useMemo(() => secret ? createSafetyCode(secret) : "", [secret]);

  const createRoom = useCallback(() => {
    cancelRecording();
    sessionRef.current?.dispose();
    const invitation = createHostRoom();
    const senderId = `host-${randomToken(8)}`;
    senderIdRef.current = senderId;
    saveSenderId(invitation.roomId, invitation.role, senderId);
    window.history.replaceState(null, "", createRoomUrl(window.location.origin, invitation));
    setRole(invitation.role);
    setRoomId(invitation.roomId);
    setSecret(invitation.secret);
    setConnection("waiting");
    setConnectionMode("等待另一位成员");
    setMessages([]);
    setDraft("");
    setCopied(false);
    setNotice("");
  }, [cancelRecording]);

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
    role,
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
  };
}

export type TwoOnlyChatController = ReturnType<typeof useTwoOnlyChat>;
