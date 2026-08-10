import type { ConnectionState, EncryptedWire, Role } from "@/src/chat/types";
import { randomToken } from "@/src/crypto/messageCrypto";
import {
  diagnosticErrorDetails,
  type ConnectionDiagnosticSink,
} from "@/src/diagnostics/connectionDiagnostics";
import { encodeEncryptedWire, EncryptedWireAssembler } from "@/src/protocol/wireProtocol";
import type { OutgoingSignal, SignalMessage } from "@/src/signal/types";

type SessionOptions = {
  role: Role;
  senderId: string;
  iceConfiguration: RTCConfiguration;
  turnConfigured: boolean;
  sendSignal: (message: SignalMessage) => void;
  onWire: (wire: EncryptedWire) => void;
  onConnectionChange: (state: ConnectionState, mode: string) => void;
  onNotice: (notice: string) => void;
  onDiagnostic: ConnectionDiagnosticSink;
};

const RECONNECT_DELAY_MS = 800;
const DISCONNECTED_GRACE_MS = 2_500;
const ANNOUNCE_INTERVAL_MS = 1_500;
const SIGNAL_WARNING_DELAY_MS = 3_500;

type ConnectionStatsReport = {
  id: string;
  type: string;
  state?: string;
  nominated?: boolean;
  selected?: boolean;
  selectedCandidatePairId?: string;
  localCandidateId?: string;
  remoteCandidateId?: string;
  candidateType?: string;
  protocol?: string;
  relayProtocol?: string;
  bytesSent?: number;
  bytesReceived?: number;
  currentRoundTripTime?: number;
};

type CandidateShape = RTCIceCandidateInit & {
  type?: string;
  protocol?: string;
  relayProtocol?: string;
  tcpType?: string;
};

function negotiationTag(value: string | undefined) {
  return value ? value.slice(-6) : undefined;
}

function describeCandidate(value: RTCIceCandidate | RTCIceCandidateInit) {
  const candidate = value as CandidateShape;
  const line = candidate.candidate ?? "";
  return {
    candidateType: candidate.type ?? line.match(/\btyp\s+(host|srflx|prflx|relay)\b/i)?.[1]?.toLowerCase() ?? "unknown",
    protocol: candidate.protocol ?? line.split(/\s+/)[2]?.toLowerCase() ?? "unknown",
    relayProtocol: candidate.relayProtocol ?? undefined,
    tcpType: candidate.tcpType ?? undefined,
  };
}

function getSelectedCandidatePair(stats: RTCStatsReport) {
  let selectedPairId = "";
  let selectedPair: ConnectionStatsReport | null = null;
  let nominatedPair: ConnectionStatsReport | null = null;

  stats.forEach((report) => {
    const item = report as ConnectionStatsReport;
    if (item.type === "transport" && item.selectedCandidatePairId) {
      selectedPairId = item.selectedCandidatePairId;
    }
    if (item.type !== "candidate-pair") return;
    if (item.selected) selectedPair = item;
    else if (item.nominated && item.state === "succeeded") nominatedPair = item;
  });

  if (selectedPairId) {
    return (stats.get(selectedPairId) as ConnectionStatsReport | undefined) ?? null;
  }
  return selectedPair ?? nominatedPair;
}

function getConnectionSummary(stats: RTCStatsReport) {
  const pair = getSelectedCandidatePair(stats);
  if (!pair?.localCandidateId || !pair.remoteCandidateId) {
    return { mode: "unknown" as const };
  }
  const local = stats.get(pair.localCandidateId) as ConnectionStatsReport | undefined;
  const remote = stats.get(pair.remoteCandidateId) as ConnectionStatsReport | undefined;
  const mode = local?.candidateType === "relay" || remote?.candidateType === "relay"
    ? "relay" as const
    : "direct" as const;
  return {
    mode,
    pairState: pair.state,
    localType: local?.candidateType ?? "unknown",
    remoteType: remote?.candidateType ?? "unknown",
    protocol: local?.protocol ?? remote?.protocol ?? "unknown",
    relayProtocol: local?.relayProtocol ?? remote?.relayProtocol,
    bytesSent: pair.bytesSent ?? 0,
    bytesReceived: pair.bytesReceived ?? 0,
    rttMs: typeof pair.currentRoundTripTime === "number"
      ? Math.round(pair.currentRoundTripTime * 1_000)
      : undefined,
  };
}

export class WebRtcSession {
  private readonly role: Role;
  private readonly senderId: string;
  private readonly iceConfiguration: RTCConfiguration;
  private readonly turnConfigured: boolean;
  private readonly sendSignalMessage: SessionOptions["sendSignal"];
  private readonly onWire: SessionOptions["onWire"];
  private readonly onConnectionChange: SessionOptions["onConnectionChange"];
  private readonly onNotice: SessionOptions["onNotice"];
  private readonly onDiagnostic: SessionOptions["onDiagnostic"];
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
  private peerGeneration = 0;
  private reconnectAttempt = 0;
  private gatheredCandidates = { host: 0, srflx: 0, prflx: 0, relay: 0, unknown: 0 };

  constructor(options: SessionOptions) {
    this.role = options.role;
    this.senderId = options.senderId;
    this.iceConfiguration = options.iceConfiguration;
    this.turnConfigured = options.turnConfigured;
    this.sendSignalMessage = options.sendSignal;
    this.onWire = options.onWire;
    this.onConnectionChange = options.onConnectionChange;
    this.onNotice = options.onNotice;
    this.onDiagnostic = options.onDiagnostic;
    const iceServerCount = options.iceConfiguration.iceServers?.length ?? 0;
    this.onDiagnostic({
      stage: "client",
      code: "client.session.created",
      level: "success",
      message: "WebRTC 会话对象已创建",
      details: {
        role: this.role,
        turnConfigured: this.turnConfigured,
        policy: options.iceConfiguration.iceTransportPolicy ?? "all",
        iceServerCount,
      },
    });
  }

  start() {
    this.activeNegotiationId = "";
    this.handledOfferId = "";
    this.announceEnabled = false;
    this.signalQueue = Promise.resolve();
    this.onDiagnostic({
      stage: "client",
      code: "client.session.start",
      message: "启动 WebRTC 会话状态机",
      details: { role: this.role },
    });
    if (this.role === "guest") this.createPeer();
  }

  onSignalReady() {
    if (this.disposed) return;
    this.onDiagnostic({
      stage: "signal",
      code: "signal.ready",
      level: "success",
      message: "WebRTC 状态机已收到信令就绪通知",
    });
    if (this.signalWarningTimer !== undefined) window.clearTimeout(this.signalWarningTimer);
    this.signalWarningTimer = undefined;
    if (this.signalWarningVisible) {
      this.signalWarningVisible = false;
      this.onNotice("信令服务已恢复，正在重新握手。");
    }
    if (this.role !== "guest") return;
    this.announceEnabled = true;
    this.onDiagnostic({
      stage: "hello",
      code: "hello.announce.start",
      message: "访客开始发送 Hello 探测房主",
    });
    this.announce();
    if (this.announceTimer === undefined) {
      this.announceTimer = window.setInterval(() => this.announce(), ANNOUNCE_INTERVAL_MS);
    }
  }

  onSignalUnavailable() {
    // Signaling is only needed to negotiate/re-negotiate. A healthy DataChannel keeps working
    // during a temporary Realtime outage and must not be presented as disconnected.
    if (this.disposed || this.dataChannel?.readyState === "open" || this.signalWarningTimer !== undefined) return;
    this.onDiagnostic({
      stage: "signal",
      code: "signal.unavailable",
      level: "error",
      message: "信令传输当前不可用",
    });
    this.signalWarningTimer = window.setTimeout(() => {
      this.signalWarningTimer = undefined;
      if (this.disposed || this.dataChannel?.readyState === "open") return;
      this.signalWarningVisible = true;
      this.onConnectionChange("disconnected", "信令服务暂时中断，等待恢复");
      this.onNotice("信令服务正在自动重连，恢复后会重新握手。");
    }, SIGNAL_WARNING_DELAY_MS);
  }

  handleSignal = (signal: SignalMessage) => {
    const stage = signal.type === "hello"
      ? "hello"
      : signal.type === "offer" || signal.type === "answer"
        ? "sdp"
        : signal.type === "candidate"
          ? "ice"
          : "signal";
    const code = signal.type === "hello"
      ? "hello"
      : signal.type === "candidate"
        ? "ice.candidate"
        : signal.type === "rejected"
          ? "signal.rejected"
          : `sdp.${signal.type}`;
    this.onDiagnostic({
      stage,
      code: `${code}.queued`,
      message: `${signal.type} 信令进入 WebRTC 处理队列`,
      details: { negotiation: negotiationTag(signal.negotiationId) },
      dedupeKey: signal.type === "candidate" ? "candidate-queued" : undefined,
    });
    this.signalQueue = this.signalQueue
      .then(() => this.processSignal(signal))
      .catch((error: unknown) => this.handleNegotiationFailure(error));
  };

  reconnect(automatic = false, delayMs = RECONNECT_DELAY_MS) {
    if (this.reconnectTimer !== undefined) window.clearTimeout(this.reconnectTimer);
    if (this.signalWarningTimer !== undefined) window.clearTimeout(this.signalWarningTimer);
    this.signalWarningTimer = undefined;
    this.signalWarningVisible = false;
    this.onDiagnostic({
      stage: "client",
      code: automatic ? "client.reconnect.scheduled" : "client.reconnect.immediate",
      level: "warn",
      message: automatic ? "已安排自动重新握手" : "立即开始重新握手",
      details: { delayMs: automatic ? delayMs : 0, nextAttempt: this.reconnectAttempt + 1 },
      dedupeKey: automatic ? "reconnect-scheduled" : undefined,
    });

    const reconnectNow = () => {
      this.reconnectTimer = undefined;
      if (this.disposed) return;
      if (this.dataChannel?.readyState === "open" && this.peer?.connectionState === "connected") {
        this.onDiagnostic({
          stage: "client",
          code: "client.reconnect.skipped",
          level: "success",
          message: "原连接已经恢复，取消重新握手",
        });
        this.markConnected();
        return;
      }

      this.reconnectAttempt += 1;
      this.onDiagnostic({
        stage: "client",
        code: "client.reconnect.begin",
        message: "开始新一轮重新握手",
        details: { attempt: this.reconnectAttempt, role: this.role },
      });
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

    if (automatic) this.reconnectTimer = window.setTimeout(reconnectNow, delayMs);
    else reconnectNow();
  }

  send(wire: EncryptedWire) {
    const channel = this.dataChannel;
    if (!channel || channel.readyState !== "open") {
      this.onDiagnostic({
        stage: "data",
        code: "data.send.skipped",
        level: "warn",
        message: "DataChannel 未打开，消息仅保存在本机",
      });
      return false;
    }
    const packets = encodeEncryptedWire(wire);
    for (const packet of packets) channel.send(packet);
    this.onDiagnostic({
      stage: "data",
      code: "data.send",
      level: "success",
      message: "加密消息已写入 DataChannel",
      details: {
        packetCount: packets.length,
        encryptedBytes: wire.data.length,
        bufferedAmount: channel.bufferedAmount,
      },
    });
    return true;
  }

  dispose() {
    this.disposed = true;
    this.onDiagnostic({
      stage: "client",
      code: "client.session.dispose",
      message: "关闭 WebRTC 会话",
      details: { peerGeneration: this.peerGeneration },
    });
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
    this.peerGeneration += 1;
    this.gatheredCandidates = { host: 0, srflx: 0, prflx: 0, relay: 0, unknown: 0 };

    const peer = new RTCPeerConnection(this.iceConfiguration);
    this.peer = peer;
    const generation = this.peerGeneration;
    this.onDiagnostic({
      stage: "ice",
      code: "ice.peer.created",
      message: "创建新的 RTCPeerConnection",
      details: { generation, role: this.role, turnConfigured: this.turnConfigured },
    });
    peer.onicecandidate = (event) => {
      if (this.peer !== peer) return;
      if (!event.candidate) {
        this.onDiagnostic({
          stage: "ice",
          code: "ice.gathering.complete",
          level: "success",
          message: "本地 ICE Candidate 收集完成",
          details: { generation, ...this.gatheredCandidates },
        });
        return;
      }
      const summary = describeCandidate(event.candidate);
      const candidateType = summary.candidateType in this.gatheredCandidates
        ? summary.candidateType as keyof typeof this.gatheredCandidates
        : "unknown";
      this.gatheredCandidates[candidateType] += 1;
      this.onDiagnostic({
        stage: "ice",
        code: "ice.candidate.gathered",
        message: "收集到本地 ICE Candidate",
        details: { generation, ...summary },
        dedupeKey: `candidate-gathered-${generation}-${summary.candidateType}-${summary.protocol}-${summary.relayProtocol ?? ""}`,
      });
      this.sendSignal({
        type: "candidate",
        to: this.peerId,
        negotiationId: this.activeNegotiationId,
        payload: event.candidate.toJSON(),
      });
    };
    peer.onicecandidateerror = (event) => {
      if (this.peer !== peer) return;
      this.onDiagnostic({
        stage: "ice",
        code: "ice.candidate.error",
        level: "warn",
        message: "ICE Server 候选收集出现错误",
        details: {
          generation,
          errorCode: event.errorCode,
          errorText: event.errorText,
        },
      });
    };
    peer.onicegatheringstatechange = () => {
      if (this.peer !== peer) return;
      this.onDiagnostic({
        stage: "ice",
        code: `ice.gathering.${peer.iceGatheringState}`,
        message: `ICE 收集状态：${peer.iceGatheringState}`,
        details: { generation },
      });
    };
    peer.oniceconnectionstatechange = () => {
      if (this.peer !== peer) return;
      const state = peer.iceConnectionState;
      this.onDiagnostic({
        stage: "ice",
        code: `ice.${state}`,
        level: state === "failed" ? "error" : state === "connected" || state === "completed" ? "success" : "info",
        message: `ICE 连接状态：${state}`,
        details: { generation },
      });
    };
    peer.onsignalingstatechange = () => {
      if (this.peer !== peer) return;
      this.onDiagnostic({
        stage: "sdp",
        code: `sdp.signaling.${peer.signalingState}`,
        message: `SDP 信令状态：${peer.signalingState}`,
        details: { generation },
      });
    };
    peer.onconnectionstatechange = () => {
      if (this.peer !== peer) return;
      this.onDiagnostic({
        stage: "ice",
        code: `ice.peer.${peer.connectionState}`,
        level: peer.connectionState === "failed"
          ? "error"
          : peer.connectionState === "connected"
            ? "success"
            : peer.connectionState === "disconnected"
              ? "warn"
              : "info",
        message: `PeerConnection 状态：${peer.connectionState}`,
        details: { generation, iceState: peer.iceConnectionState },
      });
      if (peer.connectionState === "connected") {
        this.markConnected();
      } else if (peer.connectionState === "failed") {
        this.onConnectionChange(
          "disconnected",
          this.turnConfigured ? "连接失败，正在自动重连" : "直连失败（未配置 TURN）",
        );
        this.onNotice(
          this.turnConfigured
            ? "直连和 TURN 中继均未建立，正在重新握手。"
            : "当前仅配置了 STUN；严格 NAT 或企业网络需要 TURN 中继。",
        );
        this.reconnect(true);
      } else if (peer.connectionState === "disconnected") {
        this.onConnectionChange("connecting", "连接波动，正在确认");
        this.onNotice("连接暂时中断；若未自动恢复，系统会重新握手。");
        this.reconnect(true, DISCONNECTED_GRACE_MS);
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
    this.onDiagnostic({
      stage: "data",
      code: "data.attached",
      message: "DataChannel 已挂接",
      details: { label: channel.label, ordered: channel.ordered, readyState: channel.readyState },
    });
    channel.onopen = () => {
      if (this.dataChannel !== channel) return;
      this.onDiagnostic({
        stage: "data",
        code: "data.open",
        level: "success",
        message: "DataChannel 已打开，可以双向传输",
        details: { label: channel.label, ordered: channel.ordered },
      });
      this.markConnected();
    };
    channel.onclose = () => {
      if (this.dataChannel !== channel) return;
      this.onDiagnostic({
        stage: "data",
        code: "data.closed",
        level: "error",
        message: "DataChannel 已关闭",
        details: { bufferedAmount: channel.bufferedAmount },
      });
      this.onConnectionChange("disconnected", "连接已断开，正在自动重连");
      this.reconnect(true);
    };
    channel.onerror = () => {
      if (this.dataChannel === channel) {
        this.onDiagnostic({
          stage: "data",
          code: "data.error",
          level: "error",
          message: "DataChannel 报告传输错误",
          details: { readyState: channel.readyState, bufferedAmount: channel.bufferedAmount },
        });
        this.onNotice("点对点连接出现异常，系统正在自动重新握手。");
      }
    };
    channel.onmessage = (event: MessageEvent<string>) => {
      if (this.dataChannel !== channel) return;
      try {
        const wire = this.wireAssembler.accept(event.data);
        this.onDiagnostic({
          stage: "data",
          code: wire ? "data.receive.complete" : "data.receive.chunk",
          level: wire ? "success" : "info",
          message: wire ? "已收到完整加密消息" : "收到加密消息分片",
          details: { packetBytes: event.data.length },
          dedupeKey: wire ? undefined : "data-receive-chunk",
        });
        if (wire) this.onWire(wire);
      } catch (error: unknown) {
        this.onDiagnostic({
          stage: "data",
          code: "data.receive.invalid",
          level: "error",
          message: "收到格式无效的传输数据",
          details: diagnosticErrorDetails(error),
        });
        this.onNotice("收到了一条格式不正确的传输数据。");
      }
    };
  }

  private markConnected() {
    if (this.disposed || this.dataChannel?.readyState !== "open") return;
    if (this.reconnectTimer !== undefined) window.clearTimeout(this.reconnectTimer);
    if (this.signalWarningTimer !== undefined) window.clearTimeout(this.signalWarningTimer);
    this.reconnectTimer = undefined;
    this.signalWarningTimer = undefined;
    this.signalWarningVisible = false;
    this.restartRequested = false;
    this.announceEnabled = false;
    this.onDiagnostic({
      stage: "data",
      code: "data.connection.ready",
      level: "success",
      message: "WebRTC 与 DataChannel 均已就绪",
      details: { reconnectAttempt: this.reconnectAttempt, peerGeneration: this.peerGeneration },
    });
    this.onConnectionChange("connected", "WebRTC 已连接");
    this.onNotice("");
    void this.inspectConnectionMode();
  }

  private async inspectConnectionMode() {
    const peer = this.peer;
    if (!peer) return;
    try {
      const summary = getConnectionSummary(await peer.getStats());
      if (this.peer !== peer || this.dataChannel?.readyState !== "open") return;
      this.onDiagnostic({
        stage: "ice",
        code: "ice.selected_pair",
        level: "success",
        message: summary.mode === "relay"
          ? "已选中 TURN relay Candidate Pair"
          : summary.mode === "direct"
            ? "已选中点对点直连 Candidate Pair"
            : "连接已建立，但浏览器暂未提供选中路径详情",
        details: summary,
      });
      this.onConnectionChange(
        "connected",
        summary.mode === "relay"
          ? "TURN 加密中继"
          : summary.mode === "direct"
            ? "WebRTC 点对点直连"
            : "WebRTC 已连接",
      );
    } catch (error: unknown) {
      this.onDiagnostic({
        stage: "ice",
        code: "ice.stats.unavailable",
        level: "warn",
        message: "浏览器暂时无法读取选中的 Candidate Pair",
        details: diagnosticErrorDetails(error),
      });
      if (this.peer === peer && this.dataChannel?.readyState === "open") {
        this.onConnectionChange("connected", "WebRTC 已连接");
      }
    }
  }

  private async startHostOffer(targetId = this.peerId) {
    if (!targetId || this.offerCreating || this.disposed) return;
    if (this.reconnectTimer !== undefined) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.offerCreating = true;
    this.peerId = targetId;
    this.onConnectionChange("connecting", "正在重新建立加密连接");
    this.onDiagnostic({
      stage: "sdp",
      code: "sdp.offer.start",
      message: "房主开始创建 Offer",
      details: { peerGeneration: this.peerGeneration + 1 },
    });

    try {
      const negotiationId = randomToken(8);
      this.activeNegotiationId = negotiationId;
      this.handledOfferId = "";
      const peer = this.createPeer();
      const offer = await peer.createOffer({ iceRestart: true });
      this.onDiagnostic({
        stage: "sdp",
        code: "sdp.offer.created",
        message: "房主已创建 Offer",
        details: { negotiation: negotiationTag(negotiationId), sdpBytes: offer.sdp?.length ?? 0 },
      });
      await peer.setLocalDescription(offer);
      this.onDiagnostic({
        stage: "sdp",
        code: "sdp.offer.local_applied",
        level: "success",
        message: "Offer 已设置为本地描述",
        details: { negotiation: negotiationTag(negotiationId) },
      });
      this.sendSignal({ type: "offer", to: targetId, negotiationId, payload: offer });
    } finally {
      this.offerCreating = false;
    }
  }

  private async flushPendingIce() {
    const peer = this.peer;
    if (!peer?.remoteDescription) return;
    const pending = this.pendingIce.splice(0);
    if (pending.length) {
      this.onDiagnostic({
        stage: "ice",
        code: "ice.pending.flush",
        message: "开始补加等待中的远端 Candidate",
        details: { count: pending.length },
      });
    }
    for (const candidate of pending) await peer.addIceCandidate(candidate);
  }

  private async processSignal(signal: SignalMessage) {
    if (this.disposed || signal.from === this.senderId) return;
    if (signal.to && signal.to !== this.senderId) {
      this.onDiagnostic({
        stage: "signal",
        code: "signal.message.wrong_target",
        message: "忽略发给其他成员的信令",
        details: { type: signal.type },
        dedupeKey: `wrong-target-${signal.type}`,
      });
      return;
    }

    if (signal.type === "hello" && this.role === "host") {
      this.onDiagnostic({
        stage: "hello",
        code: "hello.received",
        level: "success",
        message: "房主收到访客 Hello",
        details: { restart: signal.restart, peerAlreadyLocked: Boolean(this.peerId) },
      });
      if (this.peerId && this.peerId !== signal.from) {
        this.onDiagnostic({
          stage: "hello",
          code: "hello.rejected",
          level: "warn",
          message: "房间已锁定，拒绝第三位成员",
        });
        this.sendSignal({ type: "rejected", to: signal.from });
        return;
      }
      if (this.peerId === signal.from && this.peer) {
        const peer = this.peer;
        if (
          !signal.restart
          && (this.dataChannel?.readyState === "open" || peer.connectionState === "connected")
        ) {
          this.onDiagnostic({
            stage: "hello",
            code: "hello.duplicate.ignored",
            message: "连接健康，忽略重复 Hello",
            dedupeKey: "duplicate-hello-ignored",
          });
          return;
        }
        const offer = peer.localDescription;
        if (peer.signalingState === "have-local-offer" && offer?.type === "offer") {
          this.onDiagnostic({
            stage: "sdp",
            code: "sdp.offer.resent",
            message: "重复 Hello 命中当前协商，重新发送现有 Offer",
            details: { negotiation: negotiationTag(this.activeNegotiationId) },
          });
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
      if (offer.type !== "offer") {
        this.onDiagnostic({
          stage: "sdp",
          code: "sdp.offer.invalid",
          level: "warn",
          message: "忽略类型无效的 Offer",
        });
        return;
      }
      this.onDiagnostic({
        stage: "sdp",
        code: "sdp.offer.accepted",
        level: "success",
        message: "访客开始处理房主 Offer",
        details: { negotiation: negotiationTag(signal.negotiationId), sdpBytes: offer.sdp?.length ?? 0 },
      });
      this.peerId = signal.from;
      this.announceEnabled = false;
      this.onConnectionChange("connecting", "正在重新建立加密连接");
      const negotiationId = signal.negotiationId ?? `${signal.from}:${offer.sdp ?? ""}`;

      if (this.handledOfferId === negotiationId) {
        const answer = this.peer?.localDescription;
        if (answer?.type === "answer") {
          this.onDiagnostic({
            stage: "sdp",
            code: "sdp.answer.resent",
            message: "重复 Offer 命中当前协商，重新发送现有 Answer",
            details: { negotiation: negotiationTag(signal.negotiationId) },
          });
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
      this.onDiagnostic({
        stage: "sdp",
        code: "sdp.offer.remote_applied",
        level: "success",
        message: "Offer 已设置为远端描述",
        details: { negotiation: negotiationTag(signal.negotiationId) },
      });
      await this.flushPendingIce();
      const answer = await peer.createAnswer();
      this.onDiagnostic({
        stage: "sdp",
        code: "sdp.answer.created",
        message: "访客已创建 Answer",
        details: { negotiation: negotiationTag(signal.negotiationId), sdpBytes: answer.sdp?.length ?? 0 },
      });
      await peer.setLocalDescription(answer);
      this.onDiagnostic({
        stage: "sdp",
        code: "sdp.answer.local_applied",
        level: "success",
        message: "Answer 已设置为本地描述",
        details: { negotiation: negotiationTag(signal.negotiationId) },
      });
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
      if (!this.peer || answer.type !== "answer") {
        this.onDiagnostic({
          stage: "sdp",
          code: "sdp.answer.invalid",
          level: "warn",
          message: "忽略无法应用的 Answer",
        });
        return;
      }
      if (signal.negotiationId && signal.negotiationId !== this.activeNegotiationId) {
        this.onDiagnostic({
          stage: "sdp",
          code: "sdp.answer.stale",
          level: "warn",
          message: "忽略旧协商轮次的 Answer",
          details: {
            received: negotiationTag(signal.negotiationId),
            active: negotiationTag(this.activeNegotiationId),
          },
        });
        return;
      }
      if (this.peer.signalingState !== "have-local-offer") {
        this.onDiagnostic({
          stage: "sdp",
          code: "sdp.answer.unexpected_state",
          level: "warn",
          message: "当前 SDP 状态无法应用 Answer",
          details: { signalingState: this.peer.signalingState },
        });
        return;
      }
      await this.peer.setRemoteDescription(answer);
      this.onDiagnostic({
        stage: "sdp",
        code: "sdp.answer.applied",
        level: "success",
        message: "房主已应用访客 Answer",
        details: { negotiation: negotiationTag(signal.negotiationId), sdpBytes: answer.sdp?.length ?? 0 },
      });
      await this.flushPendingIce();
      return;
    }

    if (signal.type === "candidate") {
      if (
        signal.negotiationId
        && this.activeNegotiationId
        && signal.negotiationId !== this.activeNegotiationId
      ) {
        this.onDiagnostic({
          stage: "ice",
          code: "ice.candidate.stale",
          level: "warn",
          message: "忽略旧协商轮次的 ICE Candidate",
          details: {
            received: negotiationTag(signal.negotiationId),
            active: negotiationTag(this.activeNegotiationId),
          },
          dedupeKey: "stale-candidate",
        });
        return;
      }
      const candidate = signal.payload as RTCIceCandidateInit;
      const summary = describeCandidate(candidate);
      if (this.peer?.remoteDescription) {
        await this.peer.addIceCandidate(candidate);
        this.onDiagnostic({
          stage: "ice",
          code: "ice.candidate.added",
          message: "已添加远端 ICE Candidate",
          details: summary,
          dedupeKey: `candidate-added-${summary.candidateType}-${summary.protocol}-${summary.relayProtocol ?? ""}`,
        });
      } else {
        this.pendingIce.push(candidate);
        this.onDiagnostic({
          stage: "ice",
          code: "ice.candidate.pending",
          message: "远端描述尚未就绪，暂存 ICE Candidate",
          details: { ...summary, pendingCount: this.pendingIce.length },
          dedupeKey: `candidate-pending-${summary.candidateType}-${summary.protocol}`,
        });
      }
      return;
    }

    if (signal.type === "rejected") {
      this.onConnectionChange("disconnected", "这个会话已经有两位成员");
      this.onNotice("无法加入：会话成员已锁定为两个人。");
    }
  }

  private handleNegotiationFailure(error: unknown) {
    this.onDiagnostic({
      stage: "sdp",
      code: "sdp.negotiation.failed",
      level: "error",
      message: "连接协商执行失败",
      details: diagnosticErrorDetails(error),
    });
    this.onConnectionChange("disconnected", "连接协商失败");
    this.onNotice("连接协商出现异常，正在自动重试。");
    this.reconnect(true);
  }
}
