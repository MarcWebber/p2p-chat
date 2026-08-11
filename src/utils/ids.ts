import { DIAGNOSTICS_POLICY } from "@/src/config/policy";

export function createTraceId() {
  return globalThis.crypto?.randomUUID?.().slice(0, DIAGNOSTICS_POLICY.traceIdLength)
    ?? Math.random().toString(36).slice(2, 2 + DIAGNOSTICS_POLICY.traceIdLength);
}
