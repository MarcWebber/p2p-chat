import type {
  ChatMessage,
  ChatProfile,
  ConnectionState,
  EncryptedWire,
  MessageKind,
} from "@/src/chat/types";
import { SIGNAL_POLICY } from "@/src/config/policy";
import { createMessageCrypto } from "@/src/crypto/messageCrypto";
import { ConnectionDiagnostics } from "@/src/diagnostics/connectionDiagnostics";
import { createParticipantId } from "@/src/room/invitation";
import { createSignalTransport } from "@/src/signal/signalTransport";
import {
  clearEncryptedHistory,
  loadEncryptedHistory,
  persistEncryptedMessage,
  type StoredRoom,
} from "@/src/storage/chatStorage";
import { WebRtcSession } from "@/src/webrtc/WebRtcSession";
import { resolveIceConfiguration } from "@/src/webrtc/iceConfig";

export type RoomRuntimeSnapshot = {
  roomId: string;
  connection: ConnectionState;
  connectionMode: string;
  messages: ChatMessage[];
  notice: string;
  diagnostics: ConnectionDiagnostics;
};

type RoomRuntimeOptions = {
  room: StoredRoom;
  onChange: (snapshot: RoomRuntimeSnapshot) => void;
};

function mergeMessages(current: ChatMessage[], incoming: ChatMessage[]) {
  const merged = new Map<string, ChatMessage>();
  for (const message of [...current, ...incoming]) {
    if (isSupportedMessage(message)) merged.set(message.id, message);
  }
  return [...merged.values()].sort((left, right) => left.createdAt - right.createdAt);
}

function isSupportedMessage(message: ChatMessage) {
  const kind = (message as { kind?: unknown }).kind;
  return kind === "text" || kind === "image" || kind === "audio";
}

export class RoomRuntime {
  readonly roomId: string;
  readonly secret: string;
  readonly diagnostics = new ConnectionDiagnostics();

  private readonly participantId = createParticipantId();
  private readonly messageCrypto: ReturnType<typeof createMessageCrypto>;
  private session: WebRtcSession | null = null;
  private transport: ReturnType<typeof createSignalTransport> | null = null;
  private disposed = false;
  private snapshot: RoomRuntimeSnapshot;

  constructor(private readonly options: RoomRuntimeOptions) {
    this.roomId = options.room.roomId;
    this.secret = options.room.secret;
    this.messageCrypto = createMessageCrypto(this.secret);
    this.snapshot = {
      roomId: this.roomId,
      connection: "waiting",
      connectionMode: "等待另一位成员",
      messages: [],
      notice: "",
      diagnostics: this.diagnostics,
    };
  }

  getSnapshot() {
    return this.snapshot;
  }

  start() {
    this.diagnostics.report({
      stage: "client",
      code: "client.bootstrap.start",
      message: "开始初始化当前房间的加密聊天连接",
      details: { protocol: SIGNAL_POLICY.protocolVersion, online: navigator.onLine },
    });
    this.diagnostics.report({
      stage: "client",
      code: "client.crypto.ready",
      level: "success",
      message: "本地消息加密器已就绪",
    });

    void this.loadHistory();
    void resolveIceConfiguration(this.diagnostics.report)
      .then(({ configuration, turnConfigured }) => {
        if (this.disposed) return;
        const session = new WebRtcSession({
          participantId: this.participantId,
          iceConfiguration: configuration,
          turnConfigured,
          sendSignal: (message) => this.transport?.send(message),
          onWire: (wire) => void this.acceptWire(wire),
          onConnectionChange: (connection, connectionMode) => {
            this.publish({ connection, connectionMode });
            this.transport?.setNegotiationActive(connection !== "connected");
          },
          onNotice: (notice) => this.setNotice(notice),
          onDiagnostic: this.diagnostics.report,
        });
        this.session = session;
        this.transport = createSignalTransport({
          roomId: this.roomId,
          participantId: this.participantId,
          secret: this.secret,
          onMessage: session.handleSignal,
          onDiagnostic: this.diagnostics.report,
          onStatus: (status) => {
            if (status === "subscribed") session.onSignalReady();
            else session.onSignalUnavailable();
          },
        });
        this.transport.start();
      })
      .catch(() => {
        this.setNotice("无法初始化这个房间的连接，请稍后重试。");
      });
  }

  async send(kind: MessageKind, content: string, profile: ChatProfile, fileName?: string) {
    if (this.disposed) return false;
    const message: ChatMessage = {
      id: crypto.randomUUID(),
      kind,
      content,
      author: "self",
      createdAt: Date.now(),
      fileName,
      profile,
    };
    const wire = await this.messageCrypto.encrypt(message);
    if (this.disposed) return false;

    this.publish({ messages: mergeMessages(this.snapshot.messages, [message]) });
    const delivered = Boolean(this.session?.send(wire));
    if (!delivered) {
      this.setNotice("消息已加密保存在本机；对方连接后发送的新消息会实时送达。");
    }
    try {
      await persistEncryptedMessage(this.roomId, wire, "self");
    } catch {
      this.setNotice("本机存储空间不可用，这条消息只保留在当前页面中。");
    }
    return delivered;
  }

  reconnect() {
    if (this.disposed) return;
    this.diagnostics.report({
      stage: "client",
      code: "client.reconnect.requested",
      message: "客户端请求立即重新握手",
      details: { online: navigator.onLine },
    });
    this.session?.reconnect(false);
  }

  reportOffline() {
    this.diagnostics.report({
      stage: "client",
      code: "client.network.offline",
      level: "warn",
      message: "浏览器报告网络离线",
    });
  }

  setNotice(notice: string) {
    this.publish({ notice });
  }

  async clearHistory() {
    await clearEncryptedHistory(this.roomId);
    this.publish({
      messages: [],
      notice: "这台设备上的加密历史已经清除。",
    });
  }

  dispose() {
    if (this.disposed) return;
    this.diagnostics.report({
      stage: "client",
      code: "client.bootstrap.dispose",
      message: "释放当前房间的连接资源",
    });
    this.disposed = true;
    this.transport?.dispose();
    this.session?.dispose();
    this.transport = null;
    this.session = null;
  }

  private async acceptWire(wire: EncryptedWire) {
    let message: ChatMessage;
    try {
      message = { ...await this.messageCrypto.decrypt(wire), author: "peer" };
    } catch {
      this.setNotice("收到一条无法解密的消息，请核对邀请链接。");
      return;
    }
    if (this.disposed) return;
    if (!isSupportedMessage(message)) return;
    this.publish({ messages: mergeMessages(this.snapshot.messages, [message]) });
    try {
      await persistEncryptedMessage(this.roomId, wire, "peer");
    } catch {
      this.setNotice("本机存储空间不可用，这条消息只保留在当前页面中。");
    }
  }

  private async loadHistory() {
    try {
      const records = await loadEncryptedHistory(this.roomId);
      const history = await Promise.all(records.map(async ({ wire, localDirection }) => ({
        ...await this.messageCrypto.decrypt(wire),
        author: localDirection,
      } satisfies ChatMessage)));
      if (this.disposed) return;
      this.publish({ messages: mergeMessages(this.snapshot.messages, history) });
    } catch {
      this.setNotice("无法读取这台设备上的聊天记录。");
    }
  }

  private publish(patch: Partial<Omit<RoomRuntimeSnapshot, "roomId" | "diagnostics">>) {
    if (this.disposed) return;
    this.snapshot = { ...this.snapshot, ...patch };
    this.options.onChange(this.snapshot);
  }
}
