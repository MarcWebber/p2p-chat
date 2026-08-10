import type { ConnectionState, EncryptedWire, Role } from "@/src/chat/types";
import { randomToken } from "@/src/crypto/messageCrypto";
import { encodeEncryptedWire, EncryptedWireAssembler } from "@/src/protocol/wireProtocol";
import type { OutgoingSignal, SignalMessage } from "@/src/signal/types";
import { HAS_TURN_CONFIGURATION, ICE_CONFIGURATION } from "@/src/webrtc/iceConfig";

type SessionOptions = {
  role: Role;
  senderId: string;
  sendSignal: (message: SignalMessage) => void;
  onWire: (wire: EncryptedWire) => void;
  onConnectionChange: (state: ConnectionState, mode: string) => void;
  onNotice: (notice: string) => void;
};

const RECONNECT_DELAY_MS = 800;
const ANNOUNCE_INTERVAL_MS = 1_500;
const SIGNAL_WARNING_DELAY_MS = 3_500;

export class WebRtcSession {
  private readonly role: Role;
  private readonly senderId: string;
  private readonly sendSignalMessage: SessionOptions["sendSignal"];
  private readonly onWire: SessionOptions["onWire"];
  private readonly onConnectionChange: SessionOptions["onConnectionChange"];
  private readonly onNotice: SessionOptions["onNotice"];
  private readonly wireAssembler = new EncryptedWireAssembler();

  private peer: RTCPeerConnection | null = null;
  private dataChannel: RTCDataChannel | null = null;
  private peerId = "";
  private pendingIce: RTCIceCandidateInit[] = [];
  private activeNegotiationId = "";
  private handledOfferId = "";
  private announceEnabled = false;
  private restartRequested = false;
  private offerCreating = false;
  private reconnectTimer: number | undefined;
  private announceTimer: number | undefined;
  private signalWarningTimer: number | undefined;
  private signalWarningVisible = false;
  private signalQueue = Promise.resolve();
  private disposed = false;

  constructor(options: SessionOptions) {
    this.role = options.role;
    this.senderId = options.senderId;
    this.sendSignalMessage = options.sendSignal;
    this.onWire = options.onWire;
    this.onConnectionChange = options.onConnectionChange;
    this.onNotice = options.onNotice;
  }

  start() {
    this.activeNegotiationId = "";
    this.handledOfferId = "";
    this.announceEnabled = false;
    this.signalQueue = Promise.resolve();
    if (this.role === "guest") this.createPeer();
  }

  onSignalReady() {
    if (this.disposed) return;
    if (this.signalWarningTimer !== undefined) window.clearTimeout(this.signalWarningTimer);
    this.signalWarningTimer = undefined;
    if (this.signalWarningVisible) {
      this.signalWarningVisible = false;
      this.onNotice("信令服务已恢复，正在重新握手。");
    }
    if (this.role !== "guest") return;
    this.announceEnabled = true;
    this.announce();
    if (this.announceTimer === undefined) {
      this.announceTimer = window.setInterval(() => this.announce(), ANNOUNCE_INTERVAL_MS);
    }
  }

  onSignalUnavailable() {
    // Signaling is only needed to negotiate/re-negotiate. A healthy DataChannel keeps working
    // during a temporary Realtime outage and must not be presented as disconnected.
    if (this.disposed || this.dataChannel?.readyState === "open" || this.signalWarningTimer !== undefined) return;
    this.signalWarningTimer = window.setTimeout(() => {
      this.signalWarningTimer = undefined;
      if (this.disposed || this.dataChannel?.readyState === "open") return;
      this.signalWarningVisible = true;
      this.onConnectionChange("disconnected", "信令服务暂时中断，等待恢复");
      this.onNotice("信令服务正在自动重连，恢复后会重新握手。");
    }, SIGNAL_WARNING_DELAY_MS);
  }

  handleSignal = (signal: SignalMessage) => {
    this.signalQueue = this.signalQueue
      .then(() => this.processSignal(signal))
      .catch((error: unknown) => this.handleNegotiationFailure(error));
  };

  reconnect(automatic = false) {
    if (this.reconnectTimer !== undefined) window.clearTimeout(this.reconnectTimer);
    if (this.signalWarningTimer !== undefined) window.clearTimeout(this.signalWarningTimer);
    this.signalWarningTimer = undefined;
    this.signalWarningVisible = false;

    const reconnectNow = () => {
      this.reconnectTimer = undefined;
      if (this.disposed || this.dataChannel?.readyState === "open") return;

      this.activeNegotiationId = "";
      this.handledOfferId = "";
      this.pendingIce = [];
      this.onConnectionChange("connecting", "正在重新建立加密连接");
      this.onNotice("正在重新握手，请保持双方页面打开。");

      if (this.role === "guest") {
        this.createPeer();
        this.announceEnabled = true;
        this.restartRequested = true;
        this.sendSignal({ type: "hello", restart: true });
        return;
      }

      if (this.peerId) {
        void this.startHostOffer(this.peerId).catch((error: unknown) => this.handleNegotiationFailure(error));
      } else {
        this.onConnectionChange("waiting", "等待另一位成员");
        this.onNotice("等待对方重新上线；邀请链接仍然有效。");
      }
    };

    if (automatic) this.reconnectTimer = window.setTimeout(reconnectNow, RECONNECT_DELAY_MS);
    else reconnectNow();
  }

  send(wire: EncryptedWire) {
    const channel = this.dataChannel;
    if (!channel || channel.readyState !== "open") return false;
    for (const packet of encodeEncryptedWire(wire)) channel.send(packet);
    return true;
  }

  dispose() {
    this.disposed = true;
    this.announceEnabled = false;
    if (this.announceTimer !== undefined) window.clearInterval(this.announceTimer);
    if (this.reconnectTimer !== undefined) window.clearTimeout(this.reconnectTimer);
    this.announceTimer = undefined;
    this.reconnectTimer = undefined;
    this.signalWarningTimer = undefined;
    this.signalWarningVisible = false;
    this.restartRequested = false;
    this.wireAssembler.clear();
    const peer = this.peer;
    this.peer = null;
    this.dataChannel = null;
    peer?.close();
  }

  private announce() {
    if (
      !this.announceEnabled
      || this.role !== "guest"
      || this.dataChannel?.readyState === "open"
      || this.disposed
    ) return;
    this.sendSignal({ type: "hello", restart: this.restartRequested });
  }

  private sendSignal(message: OutgoingSignal) {
    this.sendSignalMessage({ ...message, from: this.senderId });
  }

  private createPeer() {
    const previousPeer = this.peer;
    this.peer = null;
    this.dataChannel = null;
    previousPeer?.close();
    this.pendingIce = [];

    const peer = new RTCPeerConnection(ICE_CONFIGURATION);
    this.peer = peer;
    peer.onicecandidate = (event) => {
      if (this.peer !== peer || !event.candidate) return;
      this.sendSignal({
        type: "candidate",
        to: this.peerId,
        negotiationId: this.activeNegotiationId,
        payload: event.candidate.toJSON(),
      });
    };
    peer.onconnectionstatechange = () => {
      if (this.peer !== peer) return;
      if (peer.connectionState === "failed") {
        this.onConnectionChange(
          "disconnected",
          HAS_TURN_CONFIGURATION ? "连接失败，正在自动重连" : "直连失败（未配置 TURN）",
        );
        this.onNotice(
          HAS_TURN_CONFIGURATION
            ? "直连和 TURN 中继均未建立，正在重新握手。"
            : "当前仅配置了 STUN；严格 NAT 或企业网络需要 TURN 中继。",
        );
        this.reconnect(true);
      } else if (peer.connectionState === "disconnected") {
        this.onConnectionChange("disconnected", "连接已断开，正在自动重连");
        this.onNotice("连接中断，正在重新握手；也可以点击“立即重连”。");
        this.reconnect(true);
      }
    };

    if (this.role === "host") {
      this.attachDataChannel(peer.createDataChannel("twoonly-messages", { ordered: true }));
    } else {
      peer.ondatachannel = (event) => this.attachDataChannel(event.channel);
    }
    return peer;
  }

  private attachDataChannel(channel: RTCDataChannel) {
    this.dataChannel = channel;
    channel.onopen = () => {
      if (this.dataChannel !== channel) return;
      if (this.reconnectTimer !== undefined) window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
      this.restartRequested = false;
      this.announceEnabled = false;
      this.onConnectionChange("connected", "WebRTC 点对点直连");
      this.onNotice("");
      void this.inspectConnectionMode();
    };
    channel.onclose = () => {
      if (this.dataChannel !== channel) return;
      this.onConnectionChange("disconnected", "连接已断开，正在自动重连");
      this.reconnect(true);
    };
    channel.onerror = () => {
      if (this.dataChannel === channel) this.onNotice("点对点连接出现异常，系统正在自动重新握手。");
    };
    channel.onmessage = (event: MessageEvent<string>) => {
      if (this.dataChannel !== channel) return;
      try {
        const wire = this.wireAssembler.accept(event.data);
        if (wire) this.onWire(wire);
      } catch {
        this.onNotice("收到了一条格式不正确的传输数据。");
      }
    };
  }

  private async inspectConnectionMode() {
    const peer = this.peer;
    if (!peer) return;
    const stats = await peer.getStats();
    let relay = false;
    stats.forEach((report) => {
      if (report.type === "local-candidate" && report.candidateType === "relay") relay = true;
    });
    if (this.peer === peer) {
      this.onConnectionChange("connected", relay ? "TURN 加密中继" : "WebRTC 点对点直连");
    }
  }

  private async startHostOffer(targetId = this.peerId) {
    if (!targetId || this.offerCreating || this.disposed) return;
    if (this.reconnectTimer !== undefined) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.offerCreating = true;
    this.peerId = targetId;
    this.onConnectionChange("connecting", "正在重新建立加密连接");

    try {
      const negotiationId = randomToken(8);
      this.activeNegotiationId = negotiationId;
      this.handledOfferId = "";
      const peer = this.createPeer();
      const offer = await peer.createOffer({ iceRestart: true });
      await peer.setLocalDescription(offer);
      this.sendSignal({ type: "offer", to: targetId, negotiationId, payload: offer });
    } finally {
      this.offerCreating = false;
    }
  }

  private async flushPendingIce() {
    const peer = this.peer;
    if (!peer?.remoteDescription) return;
    for (const candidate of this.pendingIce.splice(0)) await peer.addIceCandidate(candidate);
  }

  private async processSignal(signal: SignalMessage) {
    if (this.disposed || signal.from === this.senderId || (signal.to && signal.to !== this.senderId)) return;

    if (signal.type === "hello" && this.role === "host") {
      if (this.peerId && this.peerId !== signal.from) {
        this.sendSignal({ type: "rejected", to: signal.from });
        return;
      }
      if (this.peerId === signal.from && this.peer) {
        const peer = this.peer;
        if (
          !signal.restart
          && (this.dataChannel?.readyState === "open" || peer.connectionState === "connected")
        ) return;
        const offer = peer.localDescription;
        if (peer.signalingState === "have-local-offer" && offer?.type === "offer") {
          this.sendSignal({
            type: "offer",
            to: signal.from,
            negotiationId: this.activeNegotiationId,
            payload: { type: offer.type, sdp: offer.sdp },
          });
          return;
        }
        await this.startHostOffer(signal.from);
        return;
      }
      this.peerId = signal.from;
      await this.startHostOffer(signal.from);
      return;
    }

    if (signal.type === "offer" && this.role === "guest") {
      const offer = signal.payload as RTCSessionDescriptionInit;
      if (offer.type !== "offer") return;
      this.peerId = signal.from;
      this.announceEnabled = false;
      this.onConnectionChange("connecting", "正在重新建立加密连接");
      const negotiationId = signal.negotiationId ?? `${signal.from}:${offer.sdp ?? ""}`;

      if (this.handledOfferId === negotiationId) {
        const answer = this.peer?.localDescription;
        if (answer?.type === "answer") {
          this.sendSignal({
            type: "answer",
            to: signal.from,
            negotiationId: signal.negotiationId,
            payload: { type: answer.type, sdp: answer.sdp },
          });
        }
        return;
      }

      this.activeNegotiationId = negotiationId;
      const peer = this.createPeer();
      this.handledOfferId = negotiationId;
      await peer.setRemoteDescription(offer);
      await this.flushPendingIce();
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      this.sendSignal({
        type: "answer",
        to: signal.from,
        negotiationId: signal.negotiationId,
        payload: answer,
      });
      return;
    }

    if (signal.type === "answer" && this.role === "host") {
      const answer = signal.payload as RTCSessionDescriptionInit;
      if (!this.peer || answer.type !== "answer") return;
      if (signal.negotiationId && signal.negotiationId !== this.activeNegotiationId) return;
      if (this.peer.signalingState !== "have-local-offer") return;
      await this.peer.setRemoteDescription(answer);
      await this.flushPendingIce();
      return;
    }

    if (signal.type === "candidate") {
      if (
        signal.negotiationId
        && this.activeNegotiationId
        && signal.negotiationId !== this.activeNegotiationId
      ) return;
      const candidate = signal.payload as RTCIceCandidateInit;
      if (this.peer?.remoteDescription) await this.peer.addIceCandidate(candidate);
      else this.pendingIce.push(candidate);
      return;
    }

    if (signal.type === "rejected") {
      this.onConnectionChange("disconnected", "这个会话已经有两位成员");
      this.onNotice("无法加入：会话成员已锁定为两个人。");
    }
  }

  private handleNegotiationFailure(error: unknown) {
    console.error("[twoonly:signal] negotiation failed", error);
    this.onConnectionChange("disconnected", "连接协商失败");
    this.onNotice("连接协商出现异常，正在自动重试。");
    this.reconnect(true);
  }
}
