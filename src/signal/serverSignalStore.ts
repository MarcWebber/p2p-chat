import "server-only";

import { Redis } from "@upstash/redis";

import { RESOURCE_NAMES, SIGNAL_POLICY } from "@/src/config/policy";
import { SERVER_RUNTIME_CONFIG } from "@/src/config/serverRuntime";
import {
  isHttpsSignalEvent,
  isSignalCursor,
  type HttpsSignalEvent,
  type HttpsSignalPublishRequest,
} from "@/src/signal/httpsSignalProtocol";

type StoredSignal = Omit<HttpsSignalEvent, "cursor">;

const { signalFallback } = SERVER_RUNTIME_CONFIG;
const redis = signalFallback.redisRestUrl && signalFallback.redisRestToken
  ? new Redis({
    url: signalFallback.redisRestUrl,
    token: signalFallback.redisRestToken,
    retry: false,
    enableTelemetry: false,
  })
  : null;

function streamKey(roomId: string) {
  return `${RESOURCE_NAMES.httpsSignalStreamPrefix}${roomId}`;
}

function createRedis() {
  if (!redis) throw new Error("signal store not configured");
  return redis;
}

export function isHttpsSignalStoreConfigured() {
  return Boolean(redis);
}

export async function publishHttpsSignal(request: HttpsSignalPublishRequest) {
  const key = streamKey(request.roomId);
  const record: StoredSignal = {
    senderId: request.senderId,
    signalId: request.signalId,
    publishedAt: Date.now(),
    payload: request.payload,
  };
  const [cursor] = await createRedis().pipeline()
    .xadd(
      key,
      "*",
      { record },
      { trim: { type: "MAXLEN", comparison: "~", threshold: SIGNAL_POLICY.httpsQueueMaxEvents } },
    )
    .expire(key, SIGNAL_POLICY.httpsQueueTtlSeconds)
    .exec();
  if (!isSignalCursor(cursor)) throw new Error("signal store rejected publish");
  return cursor;
}

export async function pollHttpsSignals(roomId: string, participantId: string, cursor: string) {
  const start = cursor === "0-0" ? "-" : `(${cursor}`;
  const records = await createRedis().xrange<{ record: StoredSignal }>(
    streamKey(roomId),
    start,
    "+",
    SIGNAL_POLICY.httpsQueueMaxEvents,
  );

  let nextCursor = cursor;
  const events: HttpsSignalEvent[] = [];
  for (const [entryCursor, { record }] of Object.entries(records)) {
    if (!isSignalCursor(entryCursor)) continue;
    nextCursor = entryCursor;
    const event = { cursor: entryCursor, ...record } as unknown;
    if (isHttpsSignalEvent(event) && event.senderId !== participantId) events.push(event);
  }
  return { events, cursor: nextCursor };
}
