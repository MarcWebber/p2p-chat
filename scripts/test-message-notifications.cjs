const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const { webcrypto } = require("node:crypto");

const root = path.resolve(__dirname, "..");
function loadModule(specifier, context, mocks = {}, cache = new Map()) {
  if (specifier in mocks) return mocks[specifier];
  if (cache.has(specifier)) return cache.get(specifier);
  const filename = path.join(root, `${specifier.replace(/^@\//, "")}.ts`);
  const code = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  cache.set(specifier, module.exports);
  vm.runInContext(`(function(require,module,exports){${code}\n})`, context)(
    (name) => loadModule(name, context, mocks, cache), module, module.exports,
  );
  return module.exports;
}

function fixture({ permission = "default", supported = true, throws = false } = {}) {
  const storage = new Map();
  const notices = [];
  const popups = [];
  let permissionRequests = 0;
  let activeRoom = "a";
  let focused = true;
  let counts = {};
  let status;
  const document = { title: "TwoOnly", visibilityState: "visible", hasFocus: () => focused };
  class Notification {
    static permission = permission;
    static async requestPermission() { permissionRequests += 1; return (this.permission = "granted"); }
    constructor(title, options) {
      if (throws) throw new TypeError("service worker required");
      this.title = title;
      this.options = options;
      this.closed = false;
      popups.push(this);
    }
    close() { this.closed = true; }
  }
  const window = {
    isSecureContext: true,
    ...(supported ? { Notification } : {}),
    localStorage: { getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    focus() { focused = true; document.visibilityState = "visible"; },
  };
  const context = vm.createContext({ window, document, Notification });
  const { createMessageNotifications, isReadingRoom } = loadModule("@/src/chat/messageNotifications", context);
  const service = createMessageNotifications({
    isReading: (roomId) => isReadingRoom(activeRoom, roomId),
    onOpen: (roomId) => { activeRoom = roomId; },
    onUnread: (next) => { counts = next; },
    onStatus: (next) => { status = next; },
    onNotice: (message) => notices.push(message),
  });
  return { service, document, popups, notices, storage, Notification,
    blur() { focused = false; }, counts: () => counts, status: () => status,
    permissionRequests: () => permissionRequests, activeRoom: () => activeRoom };
}

async function testUnreadAndPrivacy() {
  const h = fixture();
  h.service.receive("a");
  assert.equal(Object.keys(h.counts()).length, 0, "reading the active room must stay quiet");
  h.service.receive("b");
  assert.equal(h.counts().b, 1);
  assert.equal(h.document.title, "(1) TwoOnly");
  assert.equal(h.popups.length, 0);
  assert.equal(h.permissionRequests(), 0, "new messages must never trigger permission prompts");
  await h.service.toggle();
  assert.equal(h.status(), "on");
  assert.equal(h.permissionRequests(), 1);
  h.service.receive("b");
  const first = h.popups[0];
  assert.equal(first.title, "TwoOnly");
  assert.equal(first.options.body, "收到新消息，点击查看。");
  h.service.receive("b");
  assert.ok(first.closed, "replace the previous popup for the same room");
  h.popups.at(-1).onclick();
  assert.equal(h.activeRoom(), "b");
  assert.equal(h.document.title, "TwoOnly");
  h.blur();
  h.service.receive("b");
  assert.equal(h.counts().b, 1, "an unfocused window must not mark the active room as read");
  h.service.markRead("b");
  assert.equal(h.counts().b, 1);
  await h.service.toggle();
  assert.equal(h.status(), "off");
  assert.ok(h.popups.at(-1).closed);
  const before = h.popups.length;
  h.service.receive("a");
  assert.equal(h.popups.length, before, "turning off popups must retain unread counts");
  assert.equal(h.document.title, "(2) TwoOnly");
  h.service.forget("b");
  assert.equal(h.document.title, "(1) TwoOnly");
  h.service.dispose();
  h.service.receive("a");
  assert.equal(h.document.title, "TwoOnly");
}

async function testPermissionFallbacks() {
  const denied = fixture({ permission: "denied" });
  await denied.service.toggle();
  denied.service.receive("b");
  assert.equal(denied.status(), "blocked");
  assert.equal(denied.permissionRequests(), 0);
  assert.equal(denied.popups.length, 0);
  assert.equal(denied.counts().b, 1);
  const unsupported = fixture({ supported: false });
  await unsupported.service.toggle();
  unsupported.service.receive("b");
  assert.equal(unsupported.status(), "unsupported");
  assert.equal(unsupported.counts().b, 1);
  const mobile = fixture({ throws: true });
  await mobile.service.toggle();
  mobile.service.receive("b");
  mobile.service.refresh();
  assert.equal(mobile.status(), "unsupported");
  assert.equal(mobile.counts().b, 1);
}

async function testHiddenAndPreference() {
  const h = fixture({ permission: "granted" });
  await h.service.toggle();
  assert.equal(h.permissionRequests(), 0);
  assert.equal(h.storage.get("twoonly.notifications.enabled"), "true");
  h.document.visibilityState = "hidden";
  h.service.receive("a");
  h.service.markRead("a");
  assert.equal(h.counts().a, 1, "hidden tabs cannot read messages");
  h.document.visibilityState = "visible";
  h.service.markRead("a");
  assert.equal(h.document.title, "TwoOnly");
  assert.ok(h.popups[0].closed);
  h.storage.set("twoonly.notifications.enabled", "false");
  h.service.refresh();
  assert.equal(h.status(), "off", "notification preference can sync from another tab");
}

async function testRuntimeOnlyNotifiesNewMessages() {
  const historyMessage = { id: "old", kind: "text", content: "old message", createdAt: 1 };
  const context = vm.createContext({ console, crypto: webcrypto, URL, Blob, TextEncoder, TextDecoder, atob, btoa });
  const mocks = {
    "@/src/crypto/messageCrypto": { randomToken: () => "test-participant", createMessageCrypto: () => ({
      decryptPayload: async (wire) => wire.payload, decrypt: async (wire) => wire.payload,
    }) },
    "@/src/storage/chatStorage": {
      loadEncryptedHistory: async () => [{ wire: { payload: historyMessage }, localDirection: "peer" }],
      persistEncryptedMessage: async () => {},
    },
    "@/src/diagnostics/connectionDiagnostics": { ConnectionDiagnostics: class { report() {} } },
    "@/src/signal/signalTransport": {},
    "@/src/webrtc/WebRtcSession": {},
    "@/src/webrtc/iceConfig": {},
  };
  const { RoomRuntime } = loadModule("@/src/chat/roomRuntime", context, mocks);
  const received = [];
  const runtime = new RoomRuntime({
    room: { roomId: "room-a", secret: "test-secret" },
    localProfile: { profile: { nickname: "me", avatar: "🙂" }, revision: 1, versionId: "1" },
    onChange() {}, onRoomMetadata() {}, onPeerProfile() {},
    onIncomingMessage: (roomId) => received.push(roomId),
  });
  await runtime.loadHistory();
  assert.equal(received.length, 0, "restored history must not notify");
  await runtime.acceptWire({ payload: historyMessage });
  assert.equal(received.length, 0, "replayed history must not notify");
  const message = { id: "new", kind: "text", content: "private text", createdAt: 2 };
  await runtime.acceptWire({ payload: message });
  await runtime.acceptWire({ payload: message });
  assert.equal(received.length, 1, "duplicate messages must notify once");
  const { createAttachmentStartPayload, createAttachmentChunkPayload } = loadModule("@/src/protocol/attachmentProtocol", context, mocks);
  const descriptor = { id: "file", kind: "file", fileName: "test.txt", fileSize: 1,
    mimeType: "text/plain", createdAt: 3, profile: { nickname: "peer", avatar: "🙂" } };
  const start = createAttachmentStartPayload(descriptor);
  await runtime.acceptWire({ payload: start });
  await runtime.acceptWire({ payload: start });
  await runtime.acceptWire({ payload: await createAttachmentChunkPayload("file", new Blob(["x"]), 0) });
  assert.equal(received.length, 2, "attachment start notifies once; chunks and completion do not");
  assert.equal(runtime.getSnapshot().messages.at(-1).transferState, "ready");
  runtime.dispose();
  await runtime.acceptWire({ payload: { ...message, id: "after-dispose" } });
  assert.equal(received.length, 2);
}

(async () => {
  for (const test of [testUnreadAndPrivacy, testPermissionFallbacks, testHiddenAndPreference,
    testRuntimeOnlyNotifiesNewMessages]) {
    await test();
    console.log(`PASS ${test.name}`);
  }
  console.log("Notification regressions passed; no network requests.");
})().catch((error) => { console.error(error); process.exitCode = 1; });
