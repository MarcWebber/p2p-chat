import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { DIAGNOSTICS_POLICY } from "@/src/config/policy";
import type {
  ConnectionDiagnosticEntry,
  ConnectionDiagnostics,
  DiagnosticStage,
} from "@/src/diagnostics/connectionDiagnostics";
import { copyText } from "@/src/utils/browser";
import { formatSecondTime } from "@/src/utils/format";

type ConnectionDiagnosticsPanelProps = {
  diagnostics: ConnectionDiagnostics;
};

type StageStatus = "pending" | "success" | "warning" | "error";

const STAGE_STATUS_LABELS: Record<StageStatus, string> = {
  pending: "等待",
  success: "成功",
  warning: "降级或警告",
  error: "失败",
};

const STAGES: Array<{ stage: DiagnosticStage; label: string }> = [
  { stage: "credentials", label: "凭据" },
  { stage: "signal", label: "信令" },
  { stage: "hello", label: "Hello" },
  { stage: "sdp", label: "SDP" },
  { stage: "ice", label: "ICE" },
  { stage: "data", label: "通道" },
];

const SUCCESS_CODES: Partial<Record<DiagnosticStage, Set<string>>> = {
  credentials: new Set(["credentials.success", "credentials.ready"]),
  signal: new Set(["signal.route.dual", "signal.route.degraded"]),
  hello: new Set(["hello.sent", "hello.received"]),
  sdp: new Set(["sdp.answer.sent", "sdp.answer.applied"]),
  ice: new Set(["ice.connected", "ice.completed", "ice.selected_pair"]),
  data: new Set(["data.open"]),
};

function getStageStatus(entries: readonly ConnectionDiagnosticEntry[], stage: DiagnosticStage): StageStatus {
  if (entries.some((entry) => entry.code === "data.open") && stage !== "credentials") return "success";
  const stageEntries = entries.filter((entry) => entry.stage === stage);
  const latestSuccess = stageEntries.findLast((entry) =>
    entry.level === "success"
    || (SUCCESS_CODES[stage]?.has(entry.code) && entry.level !== "warn" && entry.level !== "error"),
  );
  const latestProblem = stageEntries.findLast((entry) => entry.level === "warn" || entry.level === "error");
  if (latestProblem && (!latestSuccess || latestProblem.timestamp > latestSuccess.timestamp)) {
    return latestProblem.level === "error" ? "error" : "warning";
  }
  if (latestSuccess) return "success";
  return "pending";
}

export function ConnectionDiagnosticsPanel({ diagnostics }: ConnectionDiagnosticsPanelProps) {
  const snapshot = useSyncExternalStore(
    diagnostics.subscribe,
    diagnostics.getSnapshot,
    diagnostics.getSnapshot,
  );
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const copyTimerRef = useRef<number | undefined>(undefined);
  const entries = snapshot.entries;
  const latest = entries.at(-1);
  const stageStatuses = STAGES.map((item) => ({ ...item, status: getStageStatus(entries, item.stage) }));
  const hasActiveError = stageStatuses.some((item) => item.status === "error");
  const visibleEntries = entries.slice(-DIAGNOSTICS_POLICY.visibleEntries);

  useEffect(() => () => {
    if (copyTimerRef.current !== undefined) window.clearTimeout(copyTimerRef.current);
  }, []);

  const copyLogs = async () => {
    const copied = await copyText(diagnostics.exportText());
    setCopyState(copied ? "copied" : "failed");
    if (copyTimerRef.current !== undefined) window.clearTimeout(copyTimerRef.current);
    copyTimerRef.current = window.setTimeout(() => {
      copyTimerRef.current = undefined;
      setCopyState("idle");
    }, DIAGNOSTICS_POLICY.logCopyFeedbackMs);
  };

  return (
    <details className={`connection-diagnostics${hasActiveError ? " has-error" : ""}`}>
      <summary>
        <span className="diagnostics-title"><i />连接诊断</span>
        <span className="diagnostics-latest">
          {latest ? `${formatSecondTime(latest.timestamp)} ${latest.message}` : "等待初始化日志"}
        </span>
        <span className="diagnostics-count">{entries.length}</span>
      </summary>
      <div className="diagnostics-body">
        <div className="diagnostics-stages" aria-label="连接阶段">
          {stageStatuses.map((item) => (
            <span
              aria-label={`${item.label}：${STAGE_STATUS_LABELS[item.status]}`}
              className={`diagnostics-stage ${item.status}`}
              key={item.stage}
            >
              <i />{item.label}
            </span>
          ))}
        </div>
        <p className="diagnostics-expectation">
          期望：凭据就绪 → 至少一条信令可用 → 双方 Hello → 选举临时发起方 → Offer/Answer → ICE connected → DataChannel open
        </p>
        <div className="diagnostics-actions">
          <span>Trace {diagnostics.traceId} · 日志已脱敏，仅保存在本页内存</span>
          <div>
            <button type="button" onClick={() => void copyLogs()}>
              {copyState === "copied" ? "已复制" : copyState === "failed" ? "复制失败" : "复制日志"}
            </button>
            <button type="button" onClick={diagnostics.clear}>清空</button>
          </div>
        </div>
        <ol className="diagnostics-log">
          {visibleEntries.length ? visibleEntries.map((entry) => (
            <li className={entry.level} key={entry.id}>
              <time>{formatSecondTime(entry.timestamp)}</time>
              <code>{entry.stage}/{entry.code}</code>
              <span>{entry.message}{entry.repeat > 1 ? ` ×${entry.repeat}` : ""}</span>
              {entry.details ? (
                <small>{Object.entries(entry.details).map(([key, value]) => `${key}=${value}`).join(" · ")}</small>
              ) : null}
            </li>
          )) : <li className="empty">暂无日志，请重新进入房间或点击立即重连。</li>}
        </ol>
      </div>
    </details>
  );
}
