type CandidateLike = RTCIceCandidateInit & {
  type?: string;
  protocol?: string;
  relayProtocol?: string;
  tcpType?: string;
};

type Stat = {
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

export function describeCandidate(value: RTCIceCandidate | RTCIceCandidateInit) {
  const candidate = value as CandidateLike;
  const line = candidate.candidate ?? "";
  return {
    candidateType: candidate.type
      ?? line.match(/\btyp\s+(host|srflx|prflx|relay)\b/i)?.[1]?.toLowerCase()
      ?? "unknown",
    protocol: candidate.protocol ?? line.split(/\s+/)[2]?.toLowerCase() ?? "unknown",
    relayProtocol: candidate.relayProtocol,
    tcpType: candidate.tcpType,
  };
}

export async function inspectConnectionPath(peer: RTCPeerConnection) {
  const stats = await peer.getStats();
  let pair: Stat | undefined;
  let nominated: Stat | undefined;
  let selectedPairId = "";

  stats.forEach((raw) => {
    const stat = raw as Stat;
    if (stat.type === "transport" && stat.selectedCandidatePairId) {
      selectedPairId = stat.selectedCandidatePairId;
    } else if (stat.type === "candidate-pair") {
      if (stat.selected) pair = stat;
      else if (stat.nominated && stat.state === "succeeded") nominated = stat;
    }
  });

  pair = (selectedPairId ? stats.get(selectedPairId) as Stat | undefined : pair) ?? nominated;
  if (!pair?.localCandidateId || !pair.remoteCandidateId) return { mode: "unknown" as const };

  const local = stats.get(pair.localCandidateId) as Stat | undefined;
  const remote = stats.get(pair.remoteCandidateId) as Stat | undefined;
  return {
    mode: local?.candidateType === "relay" || remote?.candidateType === "relay"
      ? "relay" as const
      : "direct" as const,
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
