export type DiagnosticStage =
  | "client"
  | "credentials"
  | "signal"
  | "hello"
  | "sdp"
  | "ice"
  | "data";

export type DiagnosticLevel = "info" | "success" | "warn" | "error";
export type DiagnosticValue = string | number | boolean | null;

export type ConnectionDiagnosticEvent = {
  stage: DiagnosticStage;
  code: string;
  message: string;
  level?: DiagnosticLevel;
  details?: Record<string, DiagnosticValue | undefined>;
  dedupeKey?: string;
};

export type ConnectionDiagnosticEntry = Omit<ConnectionDiagnosticEvent, "details" | "dedupeKey"> & {
  id: number;
  timestamp: number;
  elapsedMs: number;
  repeat: number;
  details?: Record<string, DiagnosticValue>;
  dedupeKey?: string;
};

export type ConnectionDiagnosticsSnapshot = {
  revision: number;
  entries: readonly ConnectionDiagnosticEntry[];
};

export type ConnectionDiagnosticSink = (event: ConnectionDiagnosticEvent) => void;

const MAX_ENTRIES = 200;
const NOTIFY_DELAY_MS = 120;
const DEDUPE_WINDOW_MS = 30_000;
const SENSITIVE_DETAIL_KEY = /^(?:secret|credential|password|token|authorization|sdp|candidate|roomId|senderId|apiKey)$/i;

export function sanitizeDiagnosticText(value: unknown) {
  const text = value instanceof Error
    ? `${value.name}: ${value.message}`
    : typeof value === "string"
      ? value
      : String(value ?? "unknown");

  return text
    .replace(/\bcandidate:[^\r\n]*/gi, "[redacted-candidate]")
    .replace(/\bv=0(?:.|\r|\n)*/i, "[redacted-sdp]")
    .replace(/\ba=(?:ice-ufrag|ice-pwd):[^\s]+/gi, "a=[redacted]")
    .replace(/((?:https?|wss?):\/\/[^\s?#]+)(?:[?#][^\s]*)?/gi, "$1?[redacted]")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[redacted-ip]")
    .replace(/\b(?:[a-f0-9]{1,4}:){2,}[a-f0-9:]+\b/gi, "[redacted-ip]")
    .replace(/[A-Za-z0-9_-]{48,}/g, "[redacted]")
    .slice(0, 280);
}

export function diagnosticErrorDetails(error: unknown) {
  if (error instanceof Error) {
    const cause = "cause" in error && error.cause
      ? sanitizeDiagnosticText(error.cause)
      : undefined;
    return {
      errorName: error.name,
      errorMessage: sanitizeDiagnosticText(error.message),
      ...(cause ? { cause } : {}),
    };
  }
  return { errorMessage: sanitizeDiagnosticText(error) };
}

function sanitizeDetails(details: ConnectionDiagnosticEvent["details"]) {
  if (!details) return undefined;
  const safe: Record<string, DiagnosticValue> = {};
  for (const [key, value] of Object.entries(details)) {
    if (value === undefined) continue;
    safe[key] = SENSITIVE_DETAIL_KEY.test(key)
      ? "[redacted]"
      : typeof value === "string"
        ? sanitizeDiagnosticText(value)
        : value;
  }
  return Object.keys(safe).length ? safe : undefined;
}

function formatConsoleTime(timestamp: number) {
  return new Date(timestamp).toLocaleTimeString("zh-CN", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
  });
}

export class ConnectionDiagnostics {
  readonly traceId: string;

  private readonly startedAt = Date.now();
  private entries: ConnectionDiagnosticEntry[] = [];
  private listeners = new Set<() => void>();
  private sequence = 0;
  private notifyTimer: ReturnType<typeof setTimeout> | undefined;
  private snapshot: ConnectionDiagnosticsSnapshot = { revision: 0, entries: [] };

  constructor() {
    this.traceId = globalThis.crypto?.randomUUID?.().slice(0, 8)
      ?? Math.random().toString(36).slice(2, 10);
  }

  report: ConnectionDiagnosticSink = (event) => {
    const timestamp = Date.now();
    const details = sanitizeDetails(event.details);
    const entry: ConnectionDiagnosticEntry = {
      id: ++this.sequence,
      timestamp,
      elapsedMs: timestamp - this.startedAt,
      repeat: 1,
      stage: event.stage,
      code: event.code,
      level: event.level ?? "info",
      message: sanitizeDiagnosticText(event.message),
      details,
      dedupeKey: event.dedupeKey,
    };

    const consoleMethod = entry.level === "error"
      ? console.error
      : entry.level === "warn"
        ? console.warn
        : console.info;
    consoleMethod(
      `[twoonly][${this.traceId}][${formatConsoleTime(timestamp)}][${entry.stage}][${entry.code}] ${entry.message}`,
      details ?? "",
    );

    if (event.dedupeKey) {
      const duplicateIndex = this.entries.findLastIndex((item) =>
        item.dedupeKey === event.dedupeKey
        && timestamp - item.timestamp <= DEDUPE_WINDOW_MS,
      );
      if (duplicateIndex >= 0) {
        const previous = this.entries.splice(duplicateIndex, 1)[0];
        entry.repeat = previous.repeat + 1;
      }
    }

    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    this.scheduleNotify();
  };

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = () => this.snapshot;
  getServerSnapshot = () => this.snapshot;

  clear = () => {
    this.entries = [];
    this.publish();
  };

  exportText = () => this.entries.map((entry) => {
    const details = entry.details
      ? ` ${Object.entries(entry.details).map(([key, value]) => `${key}=${value}`).join(" ")}`
      : "";
    const repeat = entry.repeat > 1 ? ` x${entry.repeat}` : "";
    return `${new Date(entry.timestamp).toISOString()} +${entry.elapsedMs}ms [${entry.level}] [${entry.stage}] ${entry.code}${repeat} - ${entry.message}${details}`;
  }).join("\n");

  dispose = () => {
    if (this.notifyTimer !== undefined) clearTimeout(this.notifyTimer);
    this.notifyTimer = undefined;
    this.listeners.clear();
  };

  private scheduleNotify() {
    if (this.notifyTimer !== undefined) return;
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = undefined;
      this.publish();
    }, NOTIFY_DELAY_MS);
  }

  private publish() {
    this.snapshot = {
      revision: this.snapshot.revision + 1,
      entries: [...this.entries],
    };
    for (const listener of this.listeners) listener();
  }
}
