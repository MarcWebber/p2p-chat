// Offline transport regression: real TypeScript and AES-GCM, virtual time and HTTP.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");
const secret = "offline-regression-room-secret";

function harness() {
  let now = Date.UTC(2026, 0, 1);
  let nextTimer = 0;
  let nextSignal = 0;
  const timers = new Map();
  const pending = new Set();
  const requests = [];
  const streams = new Map();
  const channels = [];
  const failures = [];
  const modules = new Map();

  function track(promise) {
    pending.add(promise);
    promise.then(() => pending.delete(promise), () => pending.delete(promise));
    return promise;
  }
  const subtle = new Proxy(webcrypto.subtle, {
    get(target, key) {
      const value = target[key];
      return typeof value === "function"
        ? (...args) => track(value.apply(target, args)) : value;
    },
  });
  const window = {
    setTimeout(callback, delay = 0) {
      const id = ++nextTimer;
      timers.set(id, { at: now + delay, callback });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
  };
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const context = vm.createContext({
    console, Date: ClockDate, window, TextEncoder, TextDecoder, AbortSignal,
    URL, btoa, atob, crypto: { subtle, getRandomValues: webcrypto.getRandomValues.bind(webcrypto) },
    fetch: async (_url, options) => {
      const body = JSON.parse(options.body);
      requests.push({ at: now, ...body });
      if (failures.length) {
        const { status, error } = failures.shift();
        return Response.json({ error, requestId: "offline-request" }, { status });
      }
      let stream = streams.get(body.roomId);
      if (stream && stream.expires <= now) {
        streams.delete(body.roomId);
        stream = undefined;
      }
      if (body.action === "publish") {
        stream ??= { events: [], expires: 0, sequence: 0 };
        const cursor = `${now}-${++stream.sequence}`;
        stream.events.push({ cursor, publishedAt: now, senderId: body.senderId,
          signalId: body.signalId, payload: body.payload });
        stream.events = stream.events.slice(-policy.httpsQueueMaxEvents);
        stream.expires = now + policy.httpsQueueTtlSeconds * 1000;
        streams.set(body.roomId, stream);
        return Response.json({ accepted: true, cursor });
      }
      assert.equal(body.action, "poll");
      const after = (cursor) => {
        const [ms, seq] = cursor.split("-").map(Number);
        const [oldMs, oldSeq] = body.cursor.split("-").map(Number);
        return ms > oldMs || (ms === oldMs && seq > oldSeq);
      };
      const unread = (stream?.events ?? []).filter((event) => after(event.cursor));
      return Response.json({
        cursor: unread.at(-1)?.cursor ?? body.cursor,
        events: unread.filter((event) => event.senderId !== body.participantId),
      });
    },
  });
  const fakeSupabase = {
    createClient() {
      return {
        realtime: { disconnect() {} },
        channel() {
          const listeners = new Map();
          const channel = {
            sent: [],
            on(_type, { event }, callback) { listeners.set(event, callback); return channel; },
            deliver(event, payload) { listeners.get(event)?.({ payload }); },
            subscribe(callback) { channel.notify = callback; return channel; },
            send(message) { channel.sent.push(message); return Promise.resolve("ok"); },
          };
          channels.push(channel);
          return channel;
        },
        removeChannel() { return Promise.resolve("ok"); },
      };
    },
  };
  function load(specifier, from = path.join(root, "entry.ts")) {
    if (specifier === "@supabase/supabase-js") return fakeSupabase;
    if (specifier === "@/src/config/publicRuntime") {
      return { PUBLIC_SIGNAL_CONFIG: { url: "https://signal.invalid", key: "test" } };
    }
    let filename = specifier.startsWith("@/")
      ? path.join(root, specifier.slice(2)) : path.resolve(path.dirname(from), specifier);
    if (!path.extname(filename)) filename += ".ts";
    if (modules.has(filename)) return modules.get(filename).exports;
    const module = { exports: {} };
    modules.set(filename, module);
    const output = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
      fileName: filename,
    }).outputText;
    const execute = vm.runInContext(`(function(require,module,exports){${output}\n})`, context,
      { filename });
    execute((name) => load(name, filename), module, module.exports);
    return module.exports;
  }
  const { SIGNAL_POLICY: policy } = load("@/src/config/policy");
  async function settle() {
    // Drain crypto work as well as the promise continuations that can start more crypto.
    for (;;) {
      if (pending.size) await Promise.allSettled([...pending]);
      await new Promise(setImmediate);
      if (pending.size) continue;
      await new Promise(setImmediate);
      if (!pending.size) return;
    }
  }
  async function advance(milliseconds) {
    const until = now + milliseconds;
    await settle();
    let steps = 0;
    for (;;) {
      const next = [...timers].filter(([, timer]) => timer.at <= until)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) break;
      assert.ok(++steps < 10_000, "timer loop must remain bounded");
      now = next[1].at;
      timers.delete(next[0]);
      next[1].callback();
      await settle();
    }
    now = until;
    await settle();
  }
  function signal(from, type, to) {
    const base = {
      protocol: policy.protocolVersion, from, fromEpoch: 1,
      signalId: `signal-${++nextSignal}`, sentAt: now,
      member: { memberId: `member-${from}`, publicKey: "A".repeat(80), signature: "B".repeat(64) },
      type,
    };
    if (type === "wake") return { ...base, wakeSeq: 1 };
    if (type === "wake-ack") return { ...base, wakeSeq: 1, to, toEpoch: 1 };
    return {
      ...base, to, toEpoch: 1, negotiationId: "negotiation-test",
      payload: { type, sdp: `v=0\r\na=test-${type}\r\n` },
    };
  }
  function https(id, onMessage = () => {}, autoWake = true) {
    const states = [];
    const errors = [];
    const messages = [];
    const { createHttpsSignalTransport } = load("@/src/signal/httpsSignalTransport");
    const transport = createHttpsSignalTransport({
      roomId: "regression-room", participantId: id, secret,
      onDiagnostic() {}, onClientError(error) { errors.push(error); },
      onMessage(message) { messages.push(message); onMessage(message); },
      onState(state) {
        states.push(state);
        if (state === "ready" && autoWake) transport.send(signal(id, "wake"));
      },
    });
    transport.start();
    transport.setNegotiationActive(true);
    return { transport, states, errors, messages };
  }
  return { policy, load, advance, settle, signal, https, requests, channels, failures,
    now: () => now, pendingTimers: () => timers.size };
}

async function testBoundedIdle() {
  const h = harness();
  const startedAt = h.now();
  const a = h.https("alice");
  await h.advance(30 * 24 * 60 * 60 * 1000);
  const reads = h.requests.filter((request) => request.action === "poll");
  assert.deepEqual(reads.map((request) => request.at - startedAt),
    [0, 1_000, 3_000, 7_000, 12_000, 18_000, 25_000],
    "fallback must stop after seven polls, even when left waiting for a month");
  assert.equal(h.requests.filter((request) => request.action === "publish").length, 1,
    "idle transport must not publish new wakes on its own");
  assert.equal(h.pendingTimers(), 0, "exhausted fallback must have no background timer");
  const b = h.https("bob");
  await h.advance(60_000);
  assert.equal(h.requests.filter((request) => request.action === "poll"
    && request.participantId === "alice").length, reads.length,
    "a Redis write alone must not restart the waiting peer's polling");
  assert.equal(a.messages.length, 0, "without push, an exhausted reader cannot discover a late peer");
  a.transport.dispose();
  b.transport.dispose();
}

async function testBoundedExchange() {
  const h = harness();
  const a = h.https("alice", (message) => {
    if (message.type === "wake") a.transport.send(h.signal("alice", "offer", "bob"));
  });
  await h.advance(5_000);
  const joinedAt = h.now();
  const b = h.https("bob", (message) => {
    if (message.type === "offer") b.transport.send(h.signal("bob", "answer", "alice"));
  });
  await h.advance(15_000);
  assert.ok(a.messages.some((message) => message.type === "wake"), "wake arrives within the fallback window");
  assert.ok(b.messages.some((message) => message.type === "offer"), "offer reaches peer");
  assert.ok(a.messages.some((message) => message.type === "answer"), "answer completes exchange");
  const readsAfterJoin = h.requests.filter((request) => request.action === "poll"
    && request.participantId === "alice" && request.at >= joinedAt);
  assert.ok(readsAfterJoin.some((request) => request.cursor !== "0-0"), "activity preserves cursor");
  a.transport.setNegotiationActive(false);
  b.transport.setNegotiationActive(false);
  await h.settle();
  const stoppedAt = h.requests.length;
  await h.advance(300_000);
  assert.equal(h.requests.length, stoppedAt, "connected peers must stop polling");
  a.transport.dispose();
  b.transport.dispose();
}

async function testWakeAndDisposal() {
  const h = harness();
  const a = h.https("alice", undefined, false);
  await h.advance(120_000);
  const before = h.requests.length;
  a.transport.send(h.signal("alice", "wake"));
  a.transport.send(h.signal("alice", "wake"));
  await h.advance(2_000);
  assert.equal(h.requests.slice(before).filter((request) => request.action === "publish").length, 2,
    "wake retries must not discard an encrypting publish");
  assert.ok(h.requests.slice(before).some((request) => request.action === "poll"),
    "a new local wake must start another bounded polling window");
  await h.advance(60_000);
  assert.equal(h.requests.slice(before).filter((request) => request.action === "poll").length, 7,
    "multiple wakes inside a window must not reset or extend its polling budget");
  a.transport.dispose();
  const stoppedAt = h.requests.length;
  a.transport.send(h.signal("alice", "wake"));
  await h.advance(300_000);
  assert.equal(h.requests.length, stoppedAt, "disposed transport must stay silent");
}

async function testRequestErrors() {
  const terminal = harness();
  terminal.failures.push({ status: 426, error: {
    code: "client_upgrade_required", level: "terminal", retryable: false,
    message: "Refresh required", expectedProtocol: terminal.policy.protocolVersion,
  } });
  const stopped = terminal.https("alice");
  await terminal.advance(300_000);
  assert.equal(terminal.requests.length, 1, "426 must stop polling permanently");
  stopped.transport.send(terminal.signal("alice", "wake"));
  await terminal.advance(120_000);
  assert.equal(terminal.requests.length, 1, "426 must also stop publishing");
  assert.equal(stopped.errors[0]?.code, "client_upgrade_required");

  const retry = harness();
  retry.failures.push({ status: 502, error: {
    code: "signal_fallback_unavailable", level: "recoverable", retryable: true,
    message: "Temporary failure",
  } });
  const recovered = retry.https("alice");
  await retry.advance(retry.policy.httpsFallbackPollDelaysMs[1] - 1);
  assert.equal(retry.requests.length, 1, "failure must wait for the next bounded retry");
  await retry.advance(2_000);
  assert.deepEqual(recovered.states, ["unavailable", "ready"], "502 must recover automatically");
  recovered.transport.dispose();

  const unavailable = harness();
  for (let i = 0; i < 10; i += 1) unavailable.failures.push({ status: 502, error: {
    code: "signal_fallback_unavailable", level: "recoverable", retryable: true,
    message: "Temporary failure",
  } });
  const failed = unavailable.https("alice");
  await unavailable.advance(30 * 24 * 60 * 60 * 1000);
  assert.equal(unavailable.requests.length, 7, "persistent errors must not cause endless retries");
  assert.equal(unavailable.pendingTimers(), 0);
  failed.transport.dispose();
}

async function testReverseWakeWithoutRedis() {
  const h = harness();
  const messages = [];
  const { createSignalTransport } = h.load("@/src/signal/signalTransport");
  const transport = createSignalTransport({
    roomId: "regression-room", participantId: "alice", secret,
    onDiagnostic() {}, onClientError() {}, onStatus() {},
    onMessage(message) {
      messages.push(message);
      if (message.type === "wake") transport.send({
        ...h.signal("alice", "wake-ack", "bob"), wakeSeq: message.wakeSeq,
      });
    },
  });
  transport.start();
  const channel = h.channels[0];
  channel.notify("SUBSCRIBED");
  const startedAt = h.now();
  for (const delay of h.policy.wakeRetryDelaysMs) {
    await h.advance(startedAt + delay - h.now());
    transport.send(h.signal("alice", "wake"));
    await h.settle();
  }
  await h.advance(30 * 24 * 60 * 60 * 1000);
  assert.equal(channel.sent.length, 4, "idle subscription must not publish more wakes");
  assert.equal(h.requests.length, 0, "an offline peer must not activate Redis when push is healthy");
  const wake = h.signal("bob", "wake");
  wake.wakeSeq = 2;
  channel.deliver(h.policy.realtimeEvent, wake);
  await h.settle();
  assert.equal(messages.length, 1, "waiting subscription must still receive the returning peer");
  assert.equal(channel.sent.at(-1).payload.type, "wake-ack", "reply uses the push channel");
  assert.equal(channel.sent.at(-1).payload.wakeSeq, wake.wakeSeq, "reply acknowledges the new wake");
  assert.equal(h.requests.length, 0, "reverse wake must not require Redis polling");
  transport.dispose();
}

async function testBridgeReplyWithoutPolling() {
  const h = harness();
  const messages = [];
  const { createSignalTransport } = h.load("@/src/signal/signalTransport");
  const transport = createSignalTransport({
    roomId: "regression-room", participantId: "alice", secret,
    onDiagnostic() {}, onClientError() {}, onStatus() {},
    onMessage(message) {
      messages.push(message);
      transport.send(h.signal("alice", "wake-ack", "bob"));
    },
  });
  transport.start();
  h.channels[0].notify("SUBSCRIBED");
  await h.advance(3_600_000);
  const wake = h.signal("bob", "wake");
  const { createJsonCipher } = h.load("@/src/crypto/aesGcm");
  const payload = await createJsonCipher(`${secret}:twoonly-signal:v1`).encrypt(wake);
  h.channels[0].deliver(h.policy.realtimeBridgeEvent, {
    cursor: `${h.now()}-1`, publishedAt: h.now(), senderId: "bob",
    signalId: wake.signalId, payload,
  });
  await h.advance(60_000);
  assert.equal(messages.length, 1, "bridge notification must reach the subscribed peer");
  assert.equal(h.requests.filter((request) => request.action === "publish").length, 1,
    "bridge reply must be written for the failed peer to pull");
  assert.equal(h.requests.filter((request) => request.action === "poll").length, 0,
    "the healthy peer must not start a Redis reader just to receive a bridge notification");
  transport.dispose();
}

async function testProviderState() {
  const h = harness();
  const statuses = [];
  const { createSignalTransport } = h.load("@/src/signal/signalTransport");
  const transport = createSignalTransport({
    roomId: "regression-room", participantId: "alice", secret,
    onMessage() {}, onDiagnostic() {}, onClientError() {},
    onStatus(status) {
      statuses.push(status);
      if (status === "subscribed") transport.send(h.signal("alice", "wake"));
    },
  });
  transport.start();
  h.channels[0].notify("CHANNEL_ERROR");
  await h.advance(2_000);
  assert.equal(statuses.at(-1), "subscribed");
  const statesBefore = statuses.length;
  const writesBefore = h.requests.filter((request) => request.action === "publish").length;
  for (let i = 0; i < 5; i += 1) {
    h.channels[0].notify("CHANNEL_ERROR");
    await h.advance(1_000);
  }
  assert.equal(statuses.length, statesBefore, "primary failures must not hide healthy Redis");
  assert.equal(h.requests.filter((request) => request.action === "publish").length, writesBefore,
    "repeated primary failures must not create wake campaigns");
  await h.advance(60_000);
  const exhaustedAt = h.requests.length;
  h.channels[0].notify("CHANNEL_ERROR");
  await h.advance(60_000);
  assert.equal(h.requests.length, exhaustedAt,
    "repeated provider errors must not restart an exhausted fallback window");
  h.channels[0].notify("SUBSCRIBED");
  await h.settle();
  const restoredAt = h.requests.length;
  await h.advance(120_000);
  assert.equal(h.requests.length, restoredAt, "restored subscription must stop Redis polling");
  transport.dispose();

  const primary = harness();
  const states = [];
  const { createSupabaseSignalTransport } = primary.load("@/src/signal/supabaseSignalTransport");
  const provider = createSupabaseSignalTransport({
    roomId: "regression-room", onMessage() {}, onBridgeMessage() {}, onDiagnostic() {},
    onState(state) { states.push(state); },
  });
  provider.start();
  primary.channels[0].notify("CHANNEL_ERROR");
  provider.send(primary.signal("alice", "wake"));
  await primary.settle();
  assert.deepEqual(states, ["unavailable"], "publish ack is not a restored subscription");
  primary.channels[0].notify("SUBSCRIBED");
  assert.deepEqual(states, ["unavailable", "ready"]);
  provider.dispose();
}

(async () => {
  for (const test of [testBoundedIdle, testBoundedExchange, testWakeAndDisposal,
    testRequestErrors, testReverseWakeWithoutRedis, testBridgeReplyWithoutPolling, testProviderState]) {
    await test();
    console.log(`PASS ${test.name}`);
  }
  console.log("All offline signaling regressions passed (no network requests).");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
