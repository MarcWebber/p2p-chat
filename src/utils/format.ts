import { DIAGNOSTICS_POLICY } from "@/src/config/policy";

const timeFormatter = (options: Intl.DateTimeFormatOptions = {}) => new Intl.DateTimeFormat("zh-CN", {
  hour12: false,
  hour: "2-digit",
  minute: "2-digit",
  ...options,
}).format;

export const formatMinuteTime = timeFormatter();
export const formatSecondTime = timeFormatter({ second: "2-digit" });
export const formatMillisecondTime = timeFormatter({ second: "2-digit", fractionalSecondDigits: 3 });

export function formatBytes(bytes: number) {
  const megabytes = bytes / 1_000_000;
  return `${Number.isInteger(megabytes) ? megabytes : megabytes.toFixed(1)} MB`;
}

export function shortId(value: string | undefined) {
  return value?.slice(-DIAGNOSTICS_POLICY.shortIdLength);
}
