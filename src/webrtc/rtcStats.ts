type CandidateLike = RTCIceCandidateInit
  & Partial<Pick<RTCIceCandidate, "type" | "protocol" | "tcpType">>
  & { relayProtocol?: string };

type CandidateStats = RTCStats & {
  candidateType?: string;
  protocol?: string;
  relayProtocol?: string;
};
type CandidatePairStats = RTCIceCandidatePairStats & { selected?: boolean };

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
  let pair: CandidatePairStats | undefined;
  let nominated: CandidatePairStats | undefined;
  let selectedPairId = "";

  stats.forEach((raw) => {
    if (raw.type === "transport") {
      selectedPairId = (raw as RTCTransportStats).selectedCandidatePairId ?? selectedPairId;
    } else if (raw.type === "candidate-pair") {
      const stat = raw as CandidatePairStats;
      if (stat.selected) pair = stat;
      else if (stat.nominated && stat.state === "succeeded") nominated = stat;
    }
  });

  pair = (selectedPairId ? stats.get(selectedPairId) as CandidatePairStats | undefined : pair) ?? nominated;
  if (!pair?.localCandidateId || !pair.remoteCandidateId) return { mode: "unknown" as const };

  const local = stats.get(pair.localCandidateId) as CandidateStats | undefined;
  const remote = stats.get(pair.remoteCandidateId) as CandidateStats | undefined;
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
