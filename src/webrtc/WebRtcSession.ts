import type { ConnectionState, EncryptedWire } from "@/src/chat/types";
import { randomToken } from "@/src/crypto/messageCrypto";
import {
  diagnosticErrorDetails,
  type ConnectionDiagnosticEvent,
  type ConnectionDiagnosticSink,
  type DiagnosticStage,
} from "@/src/diagnostics/connectionDiagnostics";
import { encodeEncryptedWire, EncryptedWireAssembler } from "@/src/protocol/wireProtocol";
import {
  SIGNAL_PROTOCOL_VERSION,
  type AnswerSignal,
  type CandidateSignal,
  type HelloSignal,
  type OfferSignal,
  type OutgoingSignal,
  type SignalMessage,
} from "@/src/signal/types";
import { describeCandidate, inspectConnectionPath } from "@/src/webrtc/rtcStats";

type SessionOptions = {
  participantId: string;
  iceConfiguration: RTCConfiguration;
  turnConfigured: boolean;
  sendSignal: (message: SignalMessage) => void;
  onWire: (wire: EncryptedWire) => void;
  onConnectionChange: (state: ConnectionState, mode: string) => void;
  onNotice: (notice: string) => void;
  onDiagnostic: ConnectionDiagnosticSink;
};

type Phase = "idle" | "discovering" | "negotiating" | "connected" | "full" | "disposed";
type NegotiationSide = "offerer" | "answerer";
type TraceOptions = Omit<ConnectionDiagnosticEvent, "stage" | "code" | "message">;

type PeerLock = {
  id: string;
  epoch: number;
  seenAt: number;
};

type Negotiation = {
  id: string;
  side: NegotiationSide;
  localEpoch: number;
  remoteEpoch: number;
};

type Timers = {
  announce?: number;
  reconnect?: number;
  signalWarning?: number;
};

const RECONNECT_DELAY_MS = 800;
const DISCONNECTED_GRACE_MS = 2_500;
const ANNOUNCE_INTERVAL_MS = 1_500;
const SIGNAL_WARNING_DELAY_MS = 3_500;
const PEER_LOCK_TIMEOUT_MS = 10_000;
const REJECT_BACKOFF_MS = 5_000;
const MAX_PENDING_NEGOTIATIONS = 2;
const MAX_PENDING_CANDIDATES = 32;

function negotiationTag(value: string | undefined) {
  return value?.slice(-6);
}

function candidateKey(signal: CandidateSignal) {
  return `${signal.from}:${signal.fromEpoch}:${signal.toEpoch}:${signal.negotiationId}`;
}

function negotiationKey(peerId: string, negotiation: Negotiation) {
  return `${peerId}:${negotiation.remoteEpoch}:${negotiation.localEpoch}:${negotiation.id}`;
}

export function electOfferer(localParticipantId: string, remoteParticipantId: string) {
  return localParticipantId < remoteParticipantId;
}

export class WebRtcSession {
  private readonly wireAssembler = new EncryptedWireAssembler();
  private readonly pendingIce = new Map<string, RTCIceCandidateInit[]>();
  private readonly timers: Timers = {};
  private phase: Phase = "idle";
  private peer: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private lock: PeerLock | null = null;
  private negotiation: Negotiation | null = null;
  private localEpoch = 1;
  private rejectedUntil = 0;
  private offerSentAt = 0;
  private reconnectAttempt = 0;
  private signalWarningShown = false;
  private electionKey = "";
  private signalQueue = Promise.resolve();

  constructor(private readonly options: SessionOptions) {}

  start() {
    if (this.phase === "disposed") return;
    this.phase = "idle";
    this.signalQueue = Promise.resolve();
  }

  onSignalReady() {
    if (this.phase === "disposed") return;
    this.clearTimer("signalWarning");
    if (this.signalWarningShown) this.options.onNotice("信令服务已恢复，正在重新握手。");
    this.signalWarningShown = false;
    this.trace("signal", "signal.ready", "WebRTC 状态机收到信令就绪通知", { level: "success" });
    if (this.channel?.readyState === "open") return;
    this.phase = "discovering";
    this.enableAnnouncements();
  }

  onSignalUnavailable() {
    if (this.phase === "disposed" || this.channel?.readyState === "open" || this.timers.signalWarning) return;
    this.trace("signal", "signal.unavailable", "信令传输当前不可用", { level: "error" });
    this.timers.signalWarning = window.setTimeout(() => {
      delete this.timers.signalWarning;
      if (this.phase === "disposed" || this.channel?.readyState === "open") return;
      this.signalWarningShown = true;
      this.show("disconnected", "信令服务暂时中断，等待恢复", "信令服务正在自动重连，恢复后会重新握手。");
    }, SIGNAL_WARNING_DELAY_MS);
  }

  handleSignal = (signal: SignalMessage) => {
    this.signalQueue = this.signalQueue
      .then(() => this.processSignal(signal))
      .catch((error: unknown) => this.handleFailure(error));
  };

  reconnect(automatic = false, delayMs = RECONNECT_DELAY_MS) {
    if (this.phase === "disposed" || (automatic && this.timers.reconnect)) return;
    this.clearTimer("reconnect");
    this.clearTimer("signalWarning");
    this.signalWarningShown = false;
    this.trace("client", automatic ? "client.reconnect.scheduled" : "client.reconnect.immediate", automatic
      ? "已安排自动重新握手"
      : "立即开始重新握手", {
      level: automatic ? "warn" : "info",
      details: { delayMs: automatic ? delayMs : 0, nextAttempt: this.reconnectAttempt + 1 },
      dedupeKey: automatic ? "reconnect-scheduled" : undefined,
    });

    const run = () => {
      delete this.timers.reconnect;
      if (this.phase === "disposed") return;
      if (this.channel?.readyState === "open" && this.peer?.connectionState === "connected") {
        this.markConnected();
        return;
      }
      this.reconnectAttempt += 1;
      this.localEpoch += 1;
      this.rejectedUntil = 0;
      this.resetPeerState();
      this.phase = "discovering";
      this.show("connecting", "正在重新建立加密连接", "正在重新握手，请保持双方页面打开。");
      this.trace("client", "client.reconnect.begin", "开始新一轮对等握手", {
        details: { attempt: this.reconnectAttempt, localEpoch: this.localEpoch },
      });
      this.enableAnnouncements();
    };

    if (automatic) this.timers.reconnect = window.setTimeout(run, delayMs);
    else run();
  }

  send(wire: EncryptedWire) {
    if (!this.channel || this.channel.readyState !== "open") return false;
    const packets = encodeEncryptedWire(wire);
    for (const packet of packets) this.channel.send(packet);
    return true;
  }

  dispose() {
    if (this.phase === "disposed") return;
    this.phase = "disposed";
    this.stopAnnouncements();
    this.clearTimer("reconnect");
    this.clearTimer("signalWarning");
    this.pendingIce.clear();
    this.wireAssembler.clear();
    this.closePeer();
  }

  private enableAnnouncements(immediate = true) {
    if (immediate) this.announce();
    if (!this.timers.announce) {
      this.timers.announce = window.setInterval(() => this.announce(), ANNOUNCE_INTERVAL_MS);
    }
  }

  private stopAnnouncements() {
    if (this.timers.announce) window.clearInterval(this.timers.announce);
    delete this.timers.announce;
  }

  private announce() {
    if (
      this.phase === "idle"
      || this.phase === "connected"
      || this.phase === "disposed"
      || Date.now() < this.rejectedUntil
    ) return;
    this.sendSignal({ type: "hello", restart: this.reconnectAttempt > 0 });
  }

  private sendSignal(message: OutgoingSignal) {
    this.options.sendSignal({
      ...message,
      protocol: SIGNAL_PROTOCOL_VERSION,
      from: this.options.participantId,
      fromEpoch: this.localEpoch,
    } as SignalMessage);
  }

  private createPeer(side: NegotiationSide, negotiation: Negotiation) {
    this.closePeer();
    this.wireAssembler.clear();
    const peer = new RTCPeerConnection(this.options.iceConfiguration);
    const gathered = { host: 0, srflx: 0, prflx: 0, relay: 0, unknown: 0 };
    this.peer = peer;

    peer.onicecandidate = (event) => {
      if (!this.isCurrent(peer, negotiation)) return;
      if (!event.candidate) {
        this.trace("ice", "ice.gathering.complete", "本地 ICE Candidate 收集完成", {
          level: "success",
          details: gathered,
        });
        return;
      }
      const lock = this.lock;
      if (!lock) return;
      const summary = describeCandidate(event.candidate);
      const type = summary.candidateType in gathered
        ? summary.candidateType as keyof typeof gathered
        : "unknown";
      gathered[type] += 1;
      this.trace("ice", "ice.candidate.gathered", "收集到本地 ICE Candidate", {
        details: summary,
        dedupeKey: `candidate-gathered-${type}-${summary.protocol}`,
      });
      this.sendSignal({
        type: "candidate",
        to: lock.id,
        toEpoch: negotiation.remoteEpoch,
        negotiationId: negotiation.id,
        payload: event.candidate.toJSON(),
      });
    };

    peer.onicecandidateerror = (event) => {
      if (this.peer !== peer) return;
      this.trace("ice", "ice.candidate.error", "ICE Server 候选收集出现错误", {
        level: "warn",
        details: { errorCode: event.errorCode, errorText: event.errorText },
      });
    };

    peer.onicegatheringstatechange = () => {
      if (this.peer !== peer) return;
      this.trace("ice", `ice.gathering.${peer.iceGatheringState}`, `ICE 收集状态：${peer.iceGatheringState}`);
    };

    peer.oniceconnectionstatechange = () => {
      if (this.peer !== peer) return;
      const state = peer.iceConnectionState;
      this.trace("ice", `ice.${state}`, `ICE 连接状态：${state}`, {
        level: state === "failed"
          ? "error"
          : state === "connected" || state === "completed"
            ? "success"
            : "info",
      });
    };

    peer.onconnectionstatechange = () => this.handlePeerState(peer);
    if (side === "offerer") this.attachChannel(peer.createDataChannel("twoonly-messages", { ordered: true }));
    else peer.ondatachannel = (event) => this.attachChannel(event.channel);
    return peer;
  }

  private handlePeerState(peer: RTCPeerConnection) {
    if (this.peer !== peer) return;
    const state = peer.connectionState;
    this.trace("ice", `ice.peer.${state}`, `PeerConnection 状态：${state}`, {
      level: state === "failed" ? "error" : state === "connected" ? "success" : state === "disconnected" ? "warn" : "info",
      details: { iceState: peer.iceConnectionState },
    });
    if (state === "connected") {
      this.markConnected();
    } else if (state === "failed") {
      this.show(
        "disconnected",
        this.options.turnConfigured ? "连接失败，正在自动重连" : "直连失败（未配置 TURN）",
        this.options.turnConfigured
          ? "直连和 TURN 中继均未建立，正在重新握手。"
          : "当前仅配置了 STUN；严格 NAT 或企业网络需要 TURN 中继。",
      );
      this.reconnect(true);
    } else if (state === "disconnected") {
      this.show("connecting", "连接波动，正在确认", "连接暂时中断；若未自动恢复，系统会重新握手。");
      this.reconnect(true, DISCONNECTED_GRACE_MS);
    }
  }

  private attachChannel(channel: RTCDataChannel) {
    this.channel = channel;
    channel.onopen = () => {
      if (this.channel !== channel) return;
      this.trace("data", "data.open", "DataChannel 已打开，可以双向传输", { level: "success" });
      this.markConnected();
    };
    channel.onclose = () => {
      if (this.channel !== channel || this.phase === "disposed") return;
      this.trace("data", "data.closed", "DataChannel 已关闭", { level: "error" });
      this.show("disconnected", "连接已断开，正在自动重连");
      this.reconnect(true);
    };
    channel.onerror = () => {
      if (this.channel !== channel) return;
      this.trace("data", "data.error", "DataChannel 报告传输错误", {
        level: "error",
        details: { readyState: channel.readyState, bufferedAmount: channel.bufferedAmount },
      });
      this.options.onNotice("点对点连接出现异常，系统正在自动重新握手。");
    };
    channel.onmessage = (event: MessageEvent<unknown>) => {
      if (this.channel !== channel) return;
      try {
        if (typeof event.data !== "string") throw new Error("unsupported data channel payload");
        const wire = this.wireAssembler.accept(event.data);
        if (wire) this.options.onWire(wire);
      } catch (error: unknown) {
        this.trace("data", "data.receive.invalid", "收到格式无效的传输数据", {
          level: "error",
          details: diagnosticErrorDetails(error),
        });
        this.options.onNotice("收到了一条格式不正确的传输数据。");
      }
    };
  }

  private markConnected() {
    if (this.phase === "disposed" || this.channel?.readyState !== "open") return;
    this.phase = "connected";
    this.rejectedUntil = 0;
    this.stopAnnouncements();
    this.clearTimer("reconnect");
    this.clearTimer("signalWarning");
    this.signalWarningShown = false;
    this.show("connected", "WebRTC 已连接", "");
    void this.updateConnectionPath();
  }

  private async updateConnectionPath() {
    const peer = this.peer;
    if (!peer) return;
    try {
      const summary = await inspectConnectionPath(peer);
      if (this.peer !== peer || this.channel?.readyState !== "open") return;
      this.trace("ice", "ice.selected_pair", summary.mode === "relay"
        ? "已选中 TURN relay Candidate Pair"
        : summary.mode === "direct"
          ? "已选中点对点直连 Candidate Pair"
          : "连接已建立，但浏览器暂未提供选中路径详情", {
        level: "success",
        details: { ...summary },
      });
      this.options.onConnectionChange("connected", summary.mode === "relay"
        ? "TURN 加密中继"
        : summary.mode === "direct"
          ? "WebRTC 点对点直连"
          : "WebRTC 已连接");
    } catch (error: unknown) {
      this.trace("ice", "ice.stats.unavailable", "浏览器暂时无法读取选中的 Candidate Pair", {
        level: "warn",
        details: diagnosticErrorDetails(error),
      });
    }
  }

  private lockPeer(remoteId: string, remoteEpoch: number) {
    const now = Date.now();
    if (!this.lock) {
      this.lock = { id: remoteId, epoch: remoteEpoch, seenAt: now };
      return "accepted" as const;
    }

    if (this.lock.id !== remoteId) {
      const peerState = this.peer?.connectionState;
      const expired = now - this.lock.seenAt >= PEER_LOCK_TIMEOUT_MS;
      const replaceable = this.channel?.readyState !== "open"
        && (peerState === "failed" || peerState === "closed" || expired);
      if (!replaceable) return "busy" as const;
      this.lock = { id: remoteId, epoch: remoteEpoch, seenAt: now };
      this.resetPeerState();
      this.trace("hello", "peer.replaced", "旧连接已失效，接受新的页面实例", {
        level: "warn",
        details: { remoteEpoch },
      });
      return "accepted" as const;
    }

    if (remoteEpoch < this.lock.epoch) return "stale" as const;
    this.lock.seenAt = now;
    if (remoteEpoch > this.lock.epoch) {
      this.lock.epoch = remoteEpoch;
      this.resetPeerState();
      this.phase = "discovering";
      this.show("connecting", "对方正在重新连接");
      this.enableAnnouncements(false);
      this.trace("hello", "peer.epoch.updated", "检测到对方的新重连轮次", {
        level: "warn",
        details: { remoteEpoch },
      });
    }
    return "accepted" as const;
  }

  private reportElection() {
    const lock = this.lock;
    if (!lock) return;
    const key = `${this.localEpoch}:${lock.epoch}:${lock.id}`;
    if (key === this.electionKey) return;
    this.electionKey = key;
    const localIsOfferer = electOfferer(this.options.participantId, lock.id);
    this.trace("hello", "peer.elected", localIsOfferer
      ? "本端被选为本轮 Offer 发起方"
      : "对端被选为本轮 Offer 发起方", {
      level: "success",
      details: { localIsOfferer, localEpoch: this.localEpoch, remoteEpoch: lock.epoch },
    });
  }

  private async handleHello(signal: HelloSignal) {
    const state = this.lockPeer(signal.from, signal.fromEpoch);
    this.trace("hello", state === "accepted" ? "hello.received" : `hello.${state}`, state === "accepted"
      ? "收到另一位参与者的 Hello"
      : state === "busy"
        ? "当前会话已有另一位参与者"
        : "忽略旧页面实例的 Hello", {
      level: state === "accepted" ? "success" : "warn",
      details: { restart: signal.restart, remoteEpoch: signal.fromEpoch },
      dedupeKey: `hello-${state}-${signal.fromEpoch}`,
    });
    if (state === "busy") {
      this.sendSignal({ type: "rejected", to: signal.from, toEpoch: signal.fromEpoch, reason: "room-full" });
      return;
    }
    if (state !== "accepted") return;
    if (this.phase === "full") this.phase = "discovering";
    this.rejectedUntil = 0;
    if (this.channel?.readyState !== "open") this.enableAnnouncements(false);
    this.reportElection();
    await this.ensureOffer();
  }

  private async ensureOffer() {
    const lock = this.lock;
    if (!lock || !electOfferer(this.options.participantId, lock.id) || this.phase === "disposed") return;
    const active = this.negotiation;
    const sameRound = active?.side === "offerer"
      && active.localEpoch === this.localEpoch
      && active.remoteEpoch === lock.epoch;
    if (sameRound) {
      const offer = this.peer?.localDescription;
      if (offer?.type === "offer" && this.peer?.signalingState === "have-local-offer" && Date.now() - this.offerSentAt >= 1_000) {
        this.sendSignal({
          type: "offer",
          to: lock.id,
          toEpoch: active.remoteEpoch,
          negotiationId: active.id,
          payload: { type: offer.type, sdp: offer.sdp },
        });
        this.offerSentAt = Date.now();
        this.trace("sdp", "sdp.offer.resent", "重复 Hello 命中当前协商，重新发送 Offer", {
          details: { negotiation: negotiationTag(active.id) },
        });
      }
      return;
    }
    await this.startOffer(lock);
  }

  private async startOffer(lock: PeerLock) {
    const negotiation: Negotiation = {
      id: randomToken(8),
      side: "offerer",
      localEpoch: this.localEpoch,
      remoteEpoch: lock.epoch,
    };
    this.negotiation = negotiation;
    this.phase = "negotiating";
    this.show("connecting", "正在建立加密连接");
    const peer = this.createPeer("offerer", negotiation);
    const offer = await peer.createOffer({ iceRestart: true });
    if (!this.isCurrent(peer, negotiation)) return;
    this.trace("sdp", "sdp.offer.created", "本端已创建 Offer", {
      details: { negotiation: negotiationTag(negotiation.id), sdpBytes: offer.sdp?.length ?? 0 },
    });
    await peer.setLocalDescription(offer);
    if (!this.isCurrent(peer, negotiation)) return;
    const local = peer.localDescription;
    if (local?.type !== "offer") throw new Error("local offer unavailable");
    this.sendSignal({
      type: "offer",
      to: lock.id,
      toEpoch: lock.epoch,
      negotiationId: negotiation.id,
      payload: { type: local.type, sdp: local.sdp },
    });
    this.offerSentAt = Date.now();
  }

  private async handleOffer(signal: OfferSignal) {
    const state = this.lockPeer(signal.from, signal.fromEpoch);
    if (state === "busy") {
      this.sendSignal({ type: "rejected", to: signal.from, toEpoch: signal.fromEpoch, reason: "room-full" });
      return;
    }
    if (state !== "accepted") return;
    if (!electOfferer(signal.from, this.options.participantId)) {
      this.trace("sdp", "sdp.offer.unexpected_offerer", "忽略未按确定性选举产生的 Offer", { level: "warn" });
      return;
    }

    this.reportElection();
    const active = this.negotiation;
    const duplicate = active?.side === "answerer"
      && active.id === signal.negotiationId
      && active.localEpoch === this.localEpoch
      && active.remoteEpoch === signal.fromEpoch;
    if (duplicate) {
      const answer = this.peer?.localDescription;
      if (answer?.type === "answer") {
        this.sendSignal({
          type: "answer",
          to: signal.from,
          toEpoch: signal.fromEpoch,
          negotiationId: signal.negotiationId,
          payload: { type: answer.type, sdp: answer.sdp },
        });
        this.trace("sdp", "sdp.answer.resent", "重复 Offer 命中当前协商，重新发送 Answer");
      }
      return;
    }

    const negotiation: Negotiation = {
      id: signal.negotiationId,
      side: "answerer",
      localEpoch: this.localEpoch,
      remoteEpoch: signal.fromEpoch,
    };
    this.negotiation = negotiation;
    this.phase = "negotiating";
    this.show("connecting", "正在建立加密连接");
    const peer = this.createPeer("answerer", negotiation);
    await peer.setRemoteDescription(signal.payload);
    if (!this.isCurrent(peer, negotiation)) return;
    this.trace("sdp", "sdp.offer.remote_applied", "Offer 已设置为远端描述", { level: "success" });
    await this.flushPendingIce(negotiation, peer);
    const answer = await peer.createAnswer();
    if (!this.isCurrent(peer, negotiation)) return;
    this.trace("sdp", "sdp.answer.created", "本端已创建 Answer", {
      details: { negotiation: negotiationTag(signal.negotiationId), sdpBytes: answer.sdp?.length ?? 0 },
    });
    await peer.setLocalDescription(answer);
    if (!this.isCurrent(peer, negotiation)) return;
    const local = peer.localDescription;
    if (local?.type !== "answer") throw new Error("local answer unavailable");
    this.sendSignal({
      type: "answer",
      to: signal.from,
      toEpoch: signal.fromEpoch,
      negotiationId: signal.negotiationId,
      payload: { type: local.type, sdp: local.sdp },
    });
  }

  private async handleAnswer(signal: AnswerSignal) {
    const active = this.negotiation;
    const valid = active?.side === "offerer"
      && signal.from === this.lock?.id
      && signal.fromEpoch === active.remoteEpoch
      && signal.negotiationId === active.id
      && electOfferer(this.options.participantId, signal.from);
    if (!valid) {
      this.trace("sdp", "sdp.answer.stale", "忽略不属于当前选举轮次的 Answer", {
        level: "warn",
        details: { negotiation: negotiationTag(signal.negotiationId), active: negotiationTag(active?.id) },
      });
      return;
    }
    const peer = this.peer;
    if (!peer || peer.signalingState !== "have-local-offer") {
      this.trace("sdp", "sdp.answer.unexpected_state", "当前 SDP 状态无法应用 Answer", {
        level: "warn",
        details: { signalingState: peer?.signalingState ?? "missing" },
      });
      return;
    }
    await peer.setRemoteDescription(signal.payload);
    if (!this.isCurrent(peer, active)) return;
    this.trace("sdp", "sdp.answer.applied", "本端已应用对方 Answer", {
      level: "success",
      details: { negotiation: negotiationTag(signal.negotiationId), sdpBytes: signal.payload.sdp?.length ?? 0 },
    });
    await this.flushPendingIce(active, peer);
  }

  private async handleCandidate(signal: CandidateSignal) {
    if (this.lock && signal.from !== this.lock.id) return;
    if (this.lock && signal.fromEpoch < this.lock.epoch) return;
    const active = this.negotiation;
    const matches = active
      && signal.from === this.lock?.id
      && signal.fromEpoch === active.remoteEpoch
      && signal.toEpoch === active.localEpoch
      && signal.negotiationId === active.id;
    if (!matches || !this.peer?.remoteDescription) {
      this.storePendingIce(signal);
      return;
    }
    try {
      await this.peer.addIceCandidate(signal.payload);
      const summary = describeCandidate(signal.payload);
      this.trace("ice", "ice.candidate.added", "已添加当前协商轮次的远端 ICE Candidate", {
        details: summary,
        dedupeKey: `candidate-added-${summary.candidateType}-${summary.protocol}`,
      });
    } catch (error: unknown) {
      this.trace("ice", "ice.candidate.rejected", "浏览器拒绝了一条远端 ICE Candidate", {
        level: "warn",
        details: diagnosticErrorDetails(error),
        dedupeKey: "candidate-add-rejected",
      });
    }
  }

  private storePendingIce(signal: CandidateSignal) {
    const key = candidateKey(signal);
    let candidates = this.pendingIce.get(key);
    if (!candidates) {
      while (this.pendingIce.size >= MAX_PENDING_NEGOTIATIONS) {
        const oldest = this.pendingIce.keys().next().value as string | undefined;
        if (!oldest) break;
        this.pendingIce.delete(oldest);
      }
      candidates = [];
      this.pendingIce.set(key, candidates);
    }
    if (candidates.length < MAX_PENDING_CANDIDATES) candidates.push(signal.payload);
    this.trace("ice", "ice.candidate.pending", "远端描述尚未就绪，暂存 ICE Candidate", {
      details: { pendingCount: candidates.length, negotiation: negotiationTag(signal.negotiationId) },
      dedupeKey: `candidate-pending-${negotiationTag(signal.negotiationId)}`,
    });
  }

  private async flushPendingIce(negotiation: Negotiation, peer: RTCPeerConnection) {
    const lock = this.lock;
    if (!lock || !peer.remoteDescription) return;
    const key = negotiationKey(lock.id, negotiation);
    const candidates = this.pendingIce.get(key);
    if (!candidates) return;
    this.pendingIce.delete(key);
    for (const candidate of candidates) {
      try {
        await peer.addIceCandidate(candidate);
      } catch (error: unknown) {
        this.trace("ice", "ice.candidate.rejected", "浏览器拒绝了一条暂存 Candidate", {
          level: "warn",
          details: diagnosticErrorDetails(error),
          dedupeKey: "pending-candidate-rejected",
        });
      }
    }
  }

  private async processSignal(signal: SignalMessage) {
    if (this.phase === "disposed" || signal.from === this.options.participantId) return;
    if ("to" in signal && signal.to && signal.to !== this.options.participantId) return;
    if ("toEpoch" in signal && signal.toEpoch !== undefined && signal.toEpoch !== this.localEpoch) {
      this.trace("signal", "signal.message.stale_epoch", "忽略发给旧页面轮次的信令", {
        level: "warn",
        details: { type: signal.type, targetEpoch: signal.toEpoch, localEpoch: this.localEpoch },
        dedupeKey: `stale-epoch-${signal.type}`,
      });
      return;
    }
    if (signal.from === this.lock?.id && signal.fromEpoch >= this.lock.epoch) this.lock.seenAt = Date.now();

    if (signal.type === "hello") return this.handleHello(signal);
    if (signal.type === "offer") return this.handleOffer(signal);
    if (signal.type === "answer") return this.handleAnswer(signal);
    if (signal.type === "candidate") return this.handleCandidate(signal);
    if (
      (this.lock && signal.from !== this.lock.id)
      || (this.lock && signal.fromEpoch !== this.lock.epoch)
      || this.channel?.readyState === "open"
    ) return;

    this.phase = "full";
    this.rejectedUntil = Date.now() + REJECT_BACKOFF_MS;
    this.enableAnnouncements(false);
    this.show("disconnected", "这个会话已经有两位成员", "无法加入：会话成员已锁定为两个人。");
    this.trace("hello", "hello.rejected", "当前页面被已有双人会话拒绝", {
      level: "warn",
      details: { reason: signal.reason },
    });
  }

  private resetPeerState() {
    this.negotiation = null;
    this.offerSentAt = 0;
    this.pendingIce.clear();
    this.wireAssembler.clear();
    this.closePeer();
  }

  private closePeer() {
    const peer = this.peer;
    this.peer = null;
    this.channel = null;
    peer?.close();
  }

  private isCurrent(peer: RTCPeerConnection, negotiation: Negotiation) {
    return this.phase !== "disposed" && this.peer === peer && this.negotiation === negotiation;
  }

  private clearTimer(name: "reconnect" | "signalWarning") {
    const timer = this.timers[name];
    if (timer) window.clearTimeout(timer);
    delete this.timers[name];
  }

  private show(state: ConnectionState, mode: string, notice?: string) {
    this.options.onConnectionChange(state, mode);
    if (notice !== undefined) this.options.onNotice(notice);
  }

  private trace(stage: DiagnosticStage, code: string, message: string, options: TraceOptions = {}) {
    this.options.onDiagnostic({ stage, code, message, ...options });
  }

  private handleFailure(error: unknown) {
    if (this.phase === "disposed") return;
    this.trace("sdp", "sdp.negotiation.failed", "连接协商执行失败", {
      level: "error",
      details: diagnosticErrorDetails(error),
    });
    this.show("disconnected", "连接协商失败", "连接协商出现异常，正在自动重试。");
    this.reconnect(true);
  }
}
