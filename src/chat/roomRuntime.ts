import type {
  AttachmentMessageKind,
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
import {
  createAttachmentChunkPayload,
  createAttachmentStartPayload,
  decodeAttachmentChunk,
  isAttachmentChunkPayload,
  isAttachmentStartPayload,
  type AttachmentDescriptor,
} from "@/src/protocol/attachmentProtocol";
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

type SendMessageOptions = {
  fileName?: string;
  fileSize?: number;
  mimeType?: string;
};

type IncomingAttachment = {
  descriptor: AttachmentDescriptor;
  total: number;
  chunks: Array<Uint8Array<ArrayBuffer> | undefined>;
  received: number;
  receivedBytes: number;
  lastProgress: number;
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
  return (
    kind === "text" || kind === "image" || kind === "audio" || kind === "file"
  )
    && typeof message.id === "string"
    && typeof message.content === "string"
    && typeof message.createdAt === "number";
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
  private transferEpoch = 0;
  private readonly incomingAttachments = new Map<string, IncomingAttachment>();
  private readonly objectUrls = new Set<string>();
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
            if (this.snapshot.connection === "connected" && connection !== "connected") {
              this.cancelActiveTransfers();
            }
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

  async send(
    kind: MessageKind,
    content: string,
    profile: ChatProfile,
    options: SendMessageOptions = {},
  ) {
    if (this.disposed) return false;
    const message: ChatMessage = {
      id: crypto.randomUUID(),
      kind,
      content,
      author: "self",
      createdAt: Date.now(),
      ...options,
      profile,
    };
    const wire = await this.messageCrypto.encrypt(message);
    if (this.disposed) return false;

    this.publish({ messages: mergeMessages(this.snapshot.messages, [message]) });
    const delivered = Boolean(await this.session?.send(wire));
    if (this.disposed) return false;
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

  async sendAttachment(kind: AttachmentMessageKind, file: File, profile: ChatProfile) {
    if (this.disposed) return false;
    const id = crypto.randomUUID();
    const fileName = file.name || (kind === "image" ? "图片" : "未命名文件");
    const descriptor: AttachmentDescriptor = {
      id,
      kind,
      createdAt: Date.now(),
      fileName,
      fileSize: file.size,
      mimeType: file.type || "application/octet-stream",
      profile,
    };
    const objectUrl = URL.createObjectURL(file);
    this.objectUrls.add(objectUrl);
    const message: ChatMessage = {
      ...descriptor,
      content: objectUrl,
      author: "self",
      transferState: "sending",
      transferProgress: 0,
      transient: true,
    };
    const transferEpoch = this.transferEpoch;
    this.publish({ messages: mergeMessages(this.snapshot.messages, [message]) });

    try {
      const start = createAttachmentStartPayload(descriptor);
      const startWire = await this.messageCrypto.encryptPayload(`${id}:start`, start);
      if (
        this.disposed
        || transferEpoch !== this.transferEpoch
        || !await this.session?.send(startWire)
      ) throw new Error("attachment connection unavailable");

      let lastProgress = 0;
      for (let index = 0; index < start.total; index += 1) {
        const payload = await createAttachmentChunkPayload(id, file, index);
        const wire = await this.messageCrypto.encryptPayload(`${id}:${index}`, payload);
        if (
          this.disposed
          || transferEpoch !== this.transferEpoch
          || !await this.session?.send(wire)
        ) throw new Error("attachment transfer interrupted");
        const progress = (index + 1) / start.total;
        if (progress === 1 || progress - lastProgress >= 0.05) {
          lastProgress = progress;
          this.updateTransferMessage(id, { transferProgress: progress });
        }
      }

      this.updateTransferMessage(id, { transferState: "ready", transferProgress: 1 });
      this.setNotice(kind === "file"
        ? "Beta 文件发送完成；大文件只保留在双方当前页面中。"
        : "大图片发送完成；该图片只保留在双方当前页面中。");
      return true;
    } catch {
      if (!this.disposed) {
        this.updateTransferMessage(id, { transferState: "failed" });
        this.setNotice(kind === "file"
          ? "Beta 文件传输已中断，请保持双方在线后重新选择文件。"
          : "大图片传输已中断，请保持双方在线后重新选择图片。");
      }
      return false;
    }
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
    this.cancelActiveTransfers();
    this.revokeObjectUrls();
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
    this.transferEpoch += 1;
    this.incomingAttachments.clear();
    this.revokeObjectUrls();
    this.transport?.dispose();
    this.session?.dispose();
    this.transport = null;
    this.session = null;
  }

  private async acceptWire(wire: EncryptedWire) {
    let payload: unknown;
    try {
      payload = await this.messageCrypto.decryptPayload(wire);
    } catch {
      this.setNotice("收到一条无法解密的消息，请核对邀请链接。");
      return;
    }
    if (this.disposed) return;
    try {
      if (isAttachmentStartPayload(payload)) {
        this.acceptAttachmentStart(payload);
        return;
      }
      if (isAttachmentChunkPayload(payload)) {
        this.acceptAttachmentChunk(payload);
        return;
      }
    } catch {
      if (isAttachmentChunkPayload(payload)) this.failIncomingAttachment(payload.transferId);
      this.setNotice("收到的附件数据不完整，传输已经停止。");
      return;
    }
    const message = { ...(payload as ChatMessage), author: "peer" } satisfies ChatMessage;
    if (!isSupportedMessage(message)) return;
    this.publish({ messages: mergeMessages(this.snapshot.messages, [message]) });
    try {
      await persistEncryptedMessage(this.roomId, wire, "peer");
    } catch {
      this.setNotice("本机存储空间不可用，这条消息只保留在当前页面中。");
    }
  }

  private acceptAttachmentStart(payload: ReturnType<typeof createAttachmentStartPayload>) {
    if (
      this.incomingAttachments.has(payload.transferId)
      || this.snapshot.messages.some((message) => message.id === payload.transferId)
    ) return;
    this.incomingAttachments.set(payload.transferId, {
      descriptor: payload.descriptor,
      total: payload.total,
      chunks: Array<Uint8Array<ArrayBuffer> | undefined>(payload.total),
      received: 0,
      receivedBytes: 0,
      lastProgress: 0,
    });
    this.publish({
      messages: mergeMessages(this.snapshot.messages, [{
        ...payload.descriptor,
        content: "",
        author: "peer",
        transferState: "receiving",
        transferProgress: 0,
        transient: true,
      }]),
    });
  }

  private acceptAttachmentChunk(payload: Parameters<typeof decodeAttachmentChunk>[0]) {
    const incoming = this.incomingAttachments.get(payload.transferId);
    if (!incoming || incoming.total !== payload.total) throw new Error("attachment metadata missing");
    if (incoming.chunks[payload.index]) return;
    const bytes = decodeAttachmentChunk(payload, incoming.descriptor.fileSize);
    incoming.chunks[payload.index] = bytes;
    incoming.received += 1;
    incoming.receivedBytes += bytes.byteLength;
    const progress = incoming.received / incoming.total;
    if (progress === 1 || progress - incoming.lastProgress >= 0.05) {
      incoming.lastProgress = progress;
      this.updateTransferMessage(payload.transferId, { transferProgress: progress });
    }
    if (incoming.received !== incoming.total) return;
    if (incoming.receivedBytes !== incoming.descriptor.fileSize || incoming.chunks.some((chunk) => !chunk)) {
      throw new Error("attachment size mismatch");
    }

    const blob = new Blob(incoming.chunks as Uint8Array<ArrayBuffer>[], {
      type: incoming.descriptor.mimeType,
    });
    const objectUrl = URL.createObjectURL(blob);
    this.objectUrls.add(objectUrl);
    this.incomingAttachments.delete(payload.transferId);
    this.updateTransferMessage(payload.transferId, {
      content: objectUrl,
      transferState: "ready",
      transferProgress: 1,
    });
    this.setNotice(incoming.descriptor.kind === "file"
      ? "收到一个 Beta 文件；大文件只保留在当前页面中。"
      : "大图片接收完成；该图片只保留在当前页面中。");
  }

  private updateTransferMessage(messageId: string, patch: Partial<ChatMessage>) {
    this.publish({
      messages: this.snapshot.messages.map((message) => message.id === messageId
        ? { ...message, ...patch }
        : message),
    });
  }

  private failIncomingAttachment(transferId: string) {
    this.incomingAttachments.delete(transferId);
    this.updateTransferMessage(transferId, { transferState: "failed" });
  }

  private cancelActiveTransfers() {
    const active = this.incomingAttachments.size > 0
      || this.snapshot.messages.some((message) => (
        message.transferState === "sending" || message.transferState === "receiving"
      ));
    if (!active) return;
    this.transferEpoch += 1;
    this.incomingAttachments.clear();
    this.publish({
      messages: this.snapshot.messages.map((message) => (
        message.transferState === "sending" || message.transferState === "receiving"
          ? { ...message, transferState: "failed" }
          : message
      )),
    });
  }

  private revokeObjectUrls() {
    for (const objectUrl of this.objectUrls) URL.revokeObjectURL(objectUrl);
    this.objectUrls.clear();
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
