import type { ConnectionState, EncryptedWire } from "@/src/chat/types";
import { randomToken } from "@/src/crypto/messageCrypto";
import {
  diagnosticErrorDetails,
  type ConnectionDiagnosticSink,
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

type ActiveNegotiation = {
  id: string;
  localEpoch: number;
  remoteEpoch: number;
};

type PendingIceBucket = {
  from: string;
  fromEpoch: number;
  toEpoch: number;
  negotiationId: string;
  candidates: RTCIceCandidateInit[];
};

const RECONNECT_DELAY_MS = 800;
const DISCONNECTED_GRACE_MS = 2_500;
const ANNOUNCE_INTERVAL_MS = 1_500;
const SIGNAL_WARNING_DELAY_MS = 3_500;
const PEER_LOCK_TIMEOUT_MS = 10_000;
const MAX_PENDING_NEGOTIATIONS = 2;
const MAX_PENDING_CANDIDATES = 32;

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

export function electOfferer(localParticipantId: string, remoteParticipantId: string) {
  return localParticipantId < remoteParticipantId;
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

function pendingIceKey(signal: CandidateSignal | OfferSignal | ActiveNegotiation, peerId = "") {
  if ("type" in signal) {
    return `${signal.from}:${signal.fromEpoch}:${signal.toEpoch}:${signal.negotiationId}`;
  }
  return `${peerId}:${signal.remoteEpoch}:${signal.localEpoch}:${signal.id}`;
}

export class WebRtcSession {
  private readonly participantId: string;
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
  private peerEpoch = 0;
  private peerLastSeenAt = 0;
  private localEpoch = 1;
  private activeNegotiation: ActiveNegotiation | null = null;
  private pendingIce = new Map<string, PendingIceBucket>();
  private handledOfferId = "";
  private announceEnabled = false;
  private restartRequested = false;
  private offerCreating = false;
  private offerStartedFor = "";
  private lastOfferSentAt = 0;
  private lastElectionKey = "";
  private helloReplyKeys = new Set<string>();
  private rejectedUntil = 0;
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
    this.participantId = options.participantId;
    this.iceConfiguration = options.iceConfiguration;
    this.turnConfigured = options.turnConfigured;
    this.sendSignalMessage = options.sendSignal;
    this.onWire = options.onWire;
    this.onConnectionChange = options.onConnectionChange;
    this.onNotice = options.onNotice;
    this.onDiagnostic = options.onDiagnostic;
    this.onDiagnostic({
      stage: "client",
      code: "client.session.created",
      level: "success",
      message: "无角色 WebRTC 会话对象已创建",
      details: {
        protocol: SIGNAL_PROTOCOL_VERSION,
        turnConfigured: this.turnConfigured,
        policy: options.iceConfiguration.iceTransportPolicy ?? "all",
        iceServerCount: options.iceConfiguration.iceServers?.length ?? 0,
      },
    });
  }

  start() {
    this.activeNegotiation = null;
    this.handledOfferId = "";
    this.announceEnabled = false;
    this.signalQueue = Promise.resolve();
    this.onDiagnostic({
      stage: "client",
      code: "client.session.start",
      message: "启动对等 WebRTC 会话状态机",
      details: { localEpoch: this.localEpoch },
    });
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
    if (this.dataChannel?.readyState === "open") return;
    this.onDiagnostic({
      stage: "hello",
      code: "hello.announce.start",
      message: "开始广播 Hello 发现另一位参与者",
      details: { localEpoch: this.localEpoch },
    });
    this.enableAnnouncing();
  }

  onSignalUnavailable() {
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
      details: {
        localEpoch: this.localEpoch,
        remoteEpoch: signal.fromEpoch,
        negotiation: "negotiationId" in signal ? negotiationTag(signal.negotiationId) : undefined,
      },
      dedupeKey: signal.type === "candidate" ? "candidate-queued" : undefined,
    });
    this.signalQueue = this.signalQueue
      .then(() => this.processSignal(signal))
      .catch((error: unknown) => this.handleNegotiationFailure(error));
  };

  reconnect(automatic = false, delayMs = RECONNECT_DELAY_MS) {
    if (automatic && this.reconnectTimer !== undefined) return;
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
      this.localEpoch += 1;
      this.activeNegotiation = null;
      this.handledOfferId = "";
      this.offerCreating = false;
      this.offerStartedFor = "";
      this.lastOfferSentAt = 0;
      this.lastElectionKey = "";
      this.helloReplyKeys.clear();
      this.rejectedUntil = 0;
      this.closePeer();
      this.onDiagnostic({
        stage: "client",
        code: "client.reconnect.begin",
        message: "开始新一轮对等握手",
        details: { attempt: this.reconnectAttempt, localEpoch: this.localEpoch },
      });
      this.onConnectionChange("connecting", "正在重新建立加密连接");
      this.onNotice("正在重新握手，请保持双方页面打开。");
      this.restartRequested = true;
      this.enableAnnouncing();
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
      details: { peerGeneration: this.peerGeneration, localEpoch: this.localEpoch },
    });
    this.announceEnabled = false;
    if (this.announceTimer !== undefined) window.clearInterval(this.announceTimer);
    if (this.reconnectTimer !== undefined) window.clearTimeout(this.reconnectTimer);
    if (this.signalWarningTimer !== undefined) window.clearTimeout(this.signalWarningTimer);
    this.announceTimer = undefined;
    this.reconnectTimer = undefined;
    this.signalWarningTimer = undefined;
    this.signalWarningVisible = false;
    this.restartRequested = false;
    this.pendingIce.clear();
    this.wireAssembler.clear();
    this.closePeer();
  }

  private announce() {
    if (
      !this.announceEnabled
      || this.dataChannel?.readyState === "open"
      || this.disposed
      || Date.now() < this.rejectedUntil
    ) return;
    this.sendSignal({ type: "hello", restart: this.restartRequested });
  }

  private enableAnnouncing(immediate = true) {
    this.announceEnabled = true;
    if (immediate) this.announce();
    if (this.announceTimer === undefined) {
      this.announceTimer = window.setInterval(() => this.announce(), ANNOUNCE_INTERVAL_MS);
    }
  }

  private sendSignal(message: OutgoingSignal) {
    this.sendSignalMessage({
      ...message,
      protocol: SIGNAL_PROTOCOL_VERSION,
      from: this.participantId,
      fromEpoch: this.localEpoch,
    } as SignalMessage);
  }

  private closePeer() {
    const peer = this.peer;
    this.peer = null;
    this.dataChannel = null;
    peer?.close();
  }

  private createPeer(createsDataChannel: boolean, negotiation: ActiveNegotiation) {
    this.closePeer();
    this.peerGeneration += 1;
    this.gatheredCandidates = { host: 0, srflx: 0, prflx: 0, relay: 0, unknown: 0 };

    const peer = new RTCPeerConnection(this.iceConfiguration);
    this.peer = peer;
    const generation = this.peerGeneration;
    this.onDiagnostic({
      stage: "ice",
      code: "ice.peer.created",
      message: "创建新的 RTCPeerConnection",
      details: {
        generation,
        createsDataChannel,
        turnConfigured: this.turnConfigured,
        localEpoch: negotiation.localEpoch,
        remoteEpoch: negotiation.remoteEpoch,
      },
    });

    peer.onicecandidate = (event) => {
      if (this.peer !== peer || this.activeNegotiation !== negotiation) return;
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
        toEpoch: negotiation.remoteEpoch,
        negotiationId: negotiation.id,
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

    if (createsDataChannel) {
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
    this.rejectedUntil = 0;
    this.onDiagnostic({
      stage: "data",
      code: "data.connection.ready",
      level: "success",
      message: "WebRTC 与 DataChannel 均已就绪",
      details: {
        reconnectAttempt: this.reconnectAttempt,
        peerGeneration: this.peerGeneration,
        localEpoch: this.localEpoch,
        remoteEpoch: this.peerEpoch,
      },
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

  private peerLockState(remoteId: string, remoteEpoch: number) {
    if (!this.peerId) {
      this.peerId = remoteId;
      this.peerEpoch = remoteEpoch;
      this.peerLastSeenAt = Date.now();
      this.onDiagnostic({
        stage: "hello",
        code: "peer.locked",
        level: "success",
        message: "已锁定另一位参与者",
        details: { remoteEpoch },
      });
      return "accepted" as const;
    }

    if (this.peerId !== remoteId) {
      const lockExpired = this.peerLastSeenAt > 0
        && Date.now() - this.peerLastSeenAt >= PEER_LOCK_TIMEOUT_MS;
      const replaceable = this.peer?.connectionState === "failed"
        || this.peer?.connectionState === "closed"
        || lockExpired;
      if (!replaceable || this.dataChannel?.readyState === "open") return "busy" as const;
      this.peerId = remoteId;
      this.peerEpoch = remoteEpoch;
      this.peerLastSeenAt = Date.now();
      this.activeNegotiation = null;
      this.handledOfferId = "";
      this.offerStartedFor = "";
      this.lastOfferSentAt = 0;
      this.lastElectionKey = "";
      this.closePeer();
      this.onDiagnostic({
        stage: "hello",
        code: "peer.replaced",
        level: "warn",
        message: "旧连接已失效，接受新的页面实例",
        details: { remoteEpoch },
      });
      return "accepted" as const;
    }

    if (remoteEpoch < this.peerEpoch) return "stale" as const;
    this.peerLastSeenAt = Date.now();
    if (remoteEpoch > this.peerEpoch) {
      this.peerEpoch = remoteEpoch;
      this.activeNegotiation = null;
      this.handledOfferId = "";
      this.offerStartedFor = "";
      this.lastOfferSentAt = 0;
      this.lastElectionKey = "";
      this.closePeer();
      this.onConnectionChange("connecting", "对方正在重新连接");
      this.onDiagnostic({
        stage: "hello",
        code: "peer.epoch.updated",
        level: "warn",
        message: "检测到对方的新重连轮次",
        details: { remoteEpoch },
      });
    }
    return "accepted" as const;
  }

  private reportElection() {
    if (!this.peerId) return;
    const key = `${this.localEpoch}:${this.peerEpoch}:${this.peerId}`;
    if (key === this.lastElectionKey) return;
    this.lastElectionKey = key;
    this.onDiagnostic({
      stage: "hello",
      code: "peer.elected",
      level: "success",
      message: electOfferer(this.participantId, this.peerId)
        ? "本端被选为本轮 Offer 发起方"
        : "对端被选为本轮 Offer 发起方",
      details: {
        localIsOfferer: electOfferer(this.participantId, this.peerId),
        localEpoch: this.localEpoch,
        remoteEpoch: this.peerEpoch,
      },
    });
  }

  private replyHello(signal: HelloSignal) {
    const key = `${signal.from}:${signal.fromEpoch}:${this.localEpoch}`;
    if (this.helloReplyKeys.has(key)) return;
    this.helloReplyKeys.add(key);
    this.sendSignal({
      type: "hello",
      to: signal.from,
      toEpoch: signal.fromEpoch,
      restart: this.restartRequested,
    });
  }

  private async maybeStartOffer() {
    if (!this.peerId || !electOfferer(this.participantId, this.peerId) || this.disposed) return;
    const offerKey = `${this.localEpoch}:${this.peerEpoch}:${this.peerId}`;
    if (this.offerStartedFor === offerKey || this.offerCreating) {
      const offer = this.peer?.localDescription;
      const active = this.activeNegotiation;
      if (
        active
        && offer?.type === "offer"
        && this.peer?.signalingState === "have-local-offer"
        && Date.now() - this.lastOfferSentAt >= 1_000
      ) {
        this.onDiagnostic({
          stage: "sdp",
          code: "sdp.offer.resent",
          message: "重复 Hello 命中当前协商，重新发送现有 Offer",
          details: { negotiation: negotiationTag(active.id) },
        });
        this.sendSignal({
          type: "offer",
          to: this.peerId,
          toEpoch: active.remoteEpoch,
          negotiationId: active.id,
          payload: { type: offer.type, sdp: offer.sdp },
        });
        this.lastOfferSentAt = Date.now();
      }
      return;
    }
    this.offerStartedFor = offerKey;
    await this.startOffer(this.peerId, this.peerEpoch);
  }

  private async startOffer(targetId: string, targetEpoch: number) {
    if (!targetId || this.offerCreating || this.disposed) return;
    this.offerCreating = true;
    this.onConnectionChange("connecting", "正在建立加密连接");
    this.onDiagnostic({
      stage: "sdp",
      code: "sdp.offer.start",
      message: "选举出的本端开始创建 Offer",
      details: {
        peerGeneration: this.peerGeneration + 1,
        localEpoch: this.localEpoch,
        remoteEpoch: targetEpoch,
      },
    });

    try {
      const negotiation: ActiveNegotiation = {
        id: randomToken(8),
        localEpoch: this.localEpoch,
        remoteEpoch: targetEpoch,
      };
      this.activeNegotiation = negotiation;
      this.handledOfferId = "";
      const peer = this.createPeer(true, negotiation);
      const offer = await peer.createOffer({ iceRestart: true });
      if (this.peer !== peer || this.activeNegotiation !== negotiation) return;
      this.onDiagnostic({
        stage: "sdp",
        code: "sdp.offer.created",
        message: "本端已创建 Offer",
        details: { negotiation: negotiationTag(negotiation.id), sdpBytes: offer.sdp?.length ?? 0 },
      });
      await peer.setLocalDescription(offer);
      if (this.peer !== peer || this.activeNegotiation !== negotiation) return;
      this.onDiagnostic({
        stage: "sdp",
        code: "sdp.offer.local_applied",
        level: "success",
        message: "Offer 已设置为本地描述",
        details: { negotiation: negotiationTag(negotiation.id) },
      });
      const localOffer = peer.localDescription;
      if (localOffer?.type !== "offer") throw new Error("local offer unavailable");
      this.sendSignal({
        type: "offer",
        to: targetId,
        toEpoch: targetEpoch,
        negotiationId: negotiation.id,
        payload: { type: localOffer.type, sdp: localOffer.sdp },
      });
      this.lastOfferSentAt = Date.now();
    } finally {
      this.offerCreating = false;
    }
  }

  private storePendingIce(signal: CandidateSignal) {
    const key = pendingIceKey(signal);
    let bucket = this.pendingIce.get(key);
    if (!bucket) {
      while (this.pendingIce.size >= MAX_PENDING_NEGOTIATIONS) {
        const oldestKey = this.pendingIce.keys().next().value as string | undefined;
        if (!oldestKey) break;
        this.pendingIce.delete(oldestKey);
      }
      bucket = {
        from: signal.from,
        fromEpoch: signal.fromEpoch,
        toEpoch: signal.toEpoch,
        negotiationId: signal.negotiationId,
        candidates: [],
      };
      this.pendingIce.set(key, bucket);
    }
    if (bucket.candidates.length < MAX_PENDING_CANDIDATES) bucket.candidates.push(signal.payload);
    this.onDiagnostic({
      stage: "ice",
      code: "ice.candidate.pending",
      message: "远端描述尚未就绪，按协商轮次暂存 ICE Candidate",
      details: {
        ...describeCandidate(signal.payload),
        pendingCount: bucket.candidates.length,
        negotiation: negotiationTag(signal.negotiationId),
      },
      dedupeKey: `candidate-pending-${signal.negotiationId}-${describeCandidate(signal.payload).candidateType}`,
    });
  }

  private async flushPendingIce(negotiation: ActiveNegotiation, peer: RTCPeerConnection) {
    if (!peer.remoteDescription) return;
    const key = pendingIceKey(negotiation, this.peerId);
    const bucket = this.pendingIce.get(key);
    if (!bucket) return;
    this.pendingIce.delete(key);
    this.onDiagnostic({
      stage: "ice",
      code: "ice.pending.flush",
      message: "开始添加当前协商轮次等待中的远端 Candidate",
      details: { count: bucket.candidates.length, negotiation: negotiationTag(negotiation.id) },
    });
    for (const candidate of bucket.candidates) {
      try {
        await peer.addIceCandidate(candidate);
      } catch (error: unknown) {
        this.onDiagnostic({
          stage: "ice",
          code: "ice.candidate.rejected",
          level: "warn",
          message: "浏览器拒绝了一条暂存 Candidate，继续处理同轮其他候选",
          details: diagnosticErrorDetails(error),
          dedupeKey: "pending-candidate-rejected",
        });
      }
    }
  }

  private async handleHello(signal: HelloSignal) {
    const lockState = this.peerLockState(signal.from, signal.fromEpoch);
    this.onDiagnostic({
      stage: "hello",
      code: lockState === "accepted" ? "hello.received" : `hello.${lockState}`,
      level: lockState === "accepted" ? "success" : "warn",
      message: lockState === "accepted"
        ? "收到另一位参与者的 Hello"
        : lockState === "busy"
          ? "当前会话已有另一位参与者"
          : "忽略旧页面实例的 Hello",
      details: { restart: signal.restart, remoteEpoch: signal.fromEpoch },
      dedupeKey: `hello-${lockState}-${signal.fromEpoch}`,
    });
    if (lockState === "busy") {
      this.sendSignal({
        type: "rejected",
        to: signal.from,
        toEpoch: signal.fromEpoch,
        reason: "room-full",
      });
      return;
    }
    if (lockState !== "accepted") return;
    this.rejectedUntil = 0;
    if (this.dataChannel?.readyState !== "open") this.enableAnnouncing(false);
    this.replyHello(signal);
    this.reportElection();
    await this.maybeStartOffer();
  }

  private async handleOffer(signal: OfferSignal) {
    if (signal.payload.type !== "offer") {
      this.onDiagnostic({
        stage: "sdp",
        code: "sdp.offer.invalid",
        level: "warn",
        message: "忽略类型无效的 Offer",
      });
      return;
    }
    const lockState = this.peerLockState(signal.from, signal.fromEpoch);
    if (lockState === "busy") {
      this.sendSignal({
        type: "rejected",
        to: signal.from,
        toEpoch: signal.fromEpoch,
        reason: "room-full",
      });
      return;
    }
    if (lockState !== "accepted") return;
    if (!electOfferer(signal.from, this.participantId)) {
      this.onDiagnostic({
        stage: "sdp",
        code: "sdp.offer.unexpected_offerer",
        level: "warn",
        message: "忽略未按确定性选举产生的 Offer",
        details: { remoteEpoch: signal.fromEpoch },
      });
      return;
    }

    this.reportElection();
    this.onConnectionChange("connecting", "正在建立加密连接");
    if (this.handledOfferId === signal.negotiationId) {
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
          toEpoch: signal.fromEpoch,
          negotiationId: signal.negotiationId,
          payload: { type: answer.type, sdp: answer.sdp },
        });
      }
      return;
    }

    const negotiation: ActiveNegotiation = {
      id: signal.negotiationId,
      localEpoch: this.localEpoch,
      remoteEpoch: signal.fromEpoch,
    };
    this.activeNegotiation = negotiation;
    this.handledOfferId = signal.negotiationId;
    this.offerStartedFor = "";
    const peer = this.createPeer(false, negotiation);
    this.onDiagnostic({
      stage: "sdp",
      code: "sdp.offer.accepted",
      level: "success",
      message: "本端开始处理对方 Offer",
      details: { negotiation: negotiationTag(signal.negotiationId), sdpBytes: signal.payload.sdp?.length ?? 0 },
    });
    await peer.setRemoteDescription(signal.payload);
    if (this.peer !== peer || this.activeNegotiation !== negotiation) return;
    this.onDiagnostic({
      stage: "sdp",
      code: "sdp.offer.remote_applied",
      level: "success",
      message: "Offer 已设置为远端描述",
      details: { negotiation: negotiationTag(signal.negotiationId) },
    });
    await this.flushPendingIce(negotiation, peer);
    const answer = await peer.createAnswer();
    if (this.peer !== peer || this.activeNegotiation !== negotiation) return;
    this.onDiagnostic({
      stage: "sdp",
      code: "sdp.answer.created",
      message: "本端已创建 Answer",
      details: { negotiation: negotiationTag(signal.negotiationId), sdpBytes: answer.sdp?.length ?? 0 },
    });
    await peer.setLocalDescription(answer);
    if (this.peer !== peer || this.activeNegotiation !== negotiation) return;
    this.onDiagnostic({
      stage: "sdp",
      code: "sdp.answer.local_applied",
      level: "success",
      message: "Answer 已设置为本地描述",
      details: { negotiation: negotiationTag(signal.negotiationId) },
    });
    const localAnswer = peer.localDescription;
    if (localAnswer?.type !== "answer") throw new Error("local answer unavailable");
    this.sendSignal({
      type: "answer",
      to: signal.from,
      toEpoch: signal.fromEpoch,
      negotiationId: signal.negotiationId,
      payload: { type: localAnswer.type, sdp: localAnswer.sdp },
    });
  }

  private async handleAnswer(signal: AnswerSignal) {
    const active = this.activeNegotiation;
    if (
      signal.payload.type !== "answer"
      || !active
      || signal.from !== this.peerId
      || signal.fromEpoch !== active.remoteEpoch
      || signal.negotiationId !== active.id
      || !electOfferer(this.participantId, signal.from)
    ) {
      this.onDiagnostic({
        stage: "sdp",
        code: "sdp.answer.stale",
        level: "warn",
        message: "忽略不属于当前选举轮次的 Answer",
        details: {
          negotiation: negotiationTag(signal.negotiationId),
          active: negotiationTag(active?.id),
          remoteEpoch: signal.fromEpoch,
        },
      });
      return;
    }
    const peer = this.peer;
    if (!peer || peer.signalingState !== "have-local-offer") {
      this.onDiagnostic({
        stage: "sdp",
        code: "sdp.answer.unexpected_state",
        level: "warn",
        message: "当前 SDP 状态无法应用 Answer",
        details: { signalingState: peer?.signalingState ?? "missing" },
      });
      return;
    }
    await peer.setRemoteDescription(signal.payload);
    if (this.peer !== peer || this.activeNegotiation !== active) return;
    this.onDiagnostic({
      stage: "sdp",
      code: "sdp.answer.applied",
      level: "success",
      message: "本端已应用对方 Answer",
      details: { negotiation: negotiationTag(signal.negotiationId), sdpBytes: signal.payload.sdp?.length ?? 0 },
    });
    await this.flushPendingIce(active, peer);
  }

  private async handleCandidate(signal: CandidateSignal) {
    if (this.peerId && signal.from !== this.peerId) {
      this.onDiagnostic({
        stage: "ice",
        code: "ice.candidate.wrong_peer",
        level: "warn",
        message: "忽略其他参与者的 ICE Candidate",
        dedupeKey: "candidate-wrong-peer",
      });
      return;
    }
    if (this.peerId === signal.from && signal.fromEpoch < this.peerEpoch) {
      this.onDiagnostic({
        stage: "ice",
        code: "ice.candidate.stale",
        level: "warn",
        message: "忽略旧重连轮次的 ICE Candidate",
        details: { remoteEpoch: signal.fromEpoch, activeRemoteEpoch: this.peerEpoch },
        dedupeKey: "stale-candidate",
      });
      return;
    }

    const active = this.activeNegotiation;
    const matchesActive = active
      && signal.from === this.peerId
      && signal.fromEpoch === active.remoteEpoch
      && signal.toEpoch === active.localEpoch
      && signal.negotiationId === active.id;
    if (matchesActive && this.peer?.remoteDescription) {
      try {
        await this.peer.addIceCandidate(signal.payload);
        const summary = describeCandidate(signal.payload);
        this.onDiagnostic({
          stage: "ice",
          code: "ice.candidate.added",
          message: "已添加当前协商轮次的远端 ICE Candidate",
          details: summary,
          dedupeKey: `candidate-added-${summary.candidateType}-${summary.protocol}`,
        });
      } catch (error: unknown) {
        this.onDiagnostic({
          stage: "ice",
          code: "ice.candidate.rejected",
          level: "warn",
          message: "浏览器拒绝了一条远端 ICE Candidate，继续处理其他候选",
          details: diagnosticErrorDetails(error),
          dedupeKey: "candidate-add-rejected",
        });
      }
      return;
    }
    this.storePendingIce(signal);
  }

  private async processSignal(signal: SignalMessage) {
    if (this.disposed) return;
    if (signal.from === this.participantId) {
      this.onDiagnostic({
        stage: "signal",
        code: "signal.message.self_ignored",
        message: "忽略本页面回显的信令",
        details: { type: signal.type },
        dedupeKey: `self-${signal.type}`,
      });
      return;
    }
    if ("to" in signal && signal.to && signal.to !== this.participantId) {
      this.onDiagnostic({
        stage: "signal",
        code: "signal.message.wrong_target",
        message: "忽略发给其他参与者的信令",
        details: { type: signal.type },
        dedupeKey: `wrong-target-${signal.type}`,
      });
      return;
    }
    if ("toEpoch" in signal && signal.toEpoch !== undefined && signal.toEpoch !== this.localEpoch) {
      this.onDiagnostic({
        stage: "signal",
        code: "signal.message.stale_epoch",
        level: "warn",
        message: "忽略发给旧页面轮次的信令",
        details: { type: signal.type, targetEpoch: signal.toEpoch, localEpoch: this.localEpoch },
        dedupeKey: `stale-epoch-${signal.type}`,
      });
      return;
    }
    if (signal.from === this.peerId && signal.fromEpoch >= this.peerEpoch) {
      this.peerLastSeenAt = Date.now();
    }

    if (signal.type === "hello") {
      await this.handleHello(signal);
      return;
    }
    if (signal.type === "offer") {
      await this.handleOffer(signal);
      return;
    }
    if (signal.type === "answer") {
      await this.handleAnswer(signal);
      return;
    }
    if (signal.type === "candidate") {
      await this.handleCandidate(signal);
      return;
    }

    if (
      (this.peerId && signal.from !== this.peerId)
      || (this.peerEpoch && signal.fromEpoch !== this.peerEpoch)
      || this.dataChannel?.readyState === "open"
    ) {
      this.onDiagnostic({
        stage: "hello",
        code: "hello.rejected.ignored",
        message: "忽略不属于当前连接的拒绝信令",
        details: { remoteEpoch: signal.fromEpoch },
        dedupeKey: "rejected-ignored",
      });
      return;
    }
    this.rejectedUntil = Date.now() + 5_000;
    this.enableAnnouncing(false);
    this.onConnectionChange("disconnected", "这个会话已经有两位成员");
    this.onNotice("无法加入：会话成员已锁定为两个人。");
    this.onDiagnostic({
      stage: "hello",
      code: "hello.rejected",
      level: "warn",
      message: "当前页面被已有双人会话拒绝",
      details: { reason: signal.reason },
    });
  }

  private handleNegotiationFailure(error: unknown) {
    if (this.disposed) return;
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
