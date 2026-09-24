const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");
const path = require("node:path");
const load = (name) => {
  const exports = {};
  const source = fs.readFileSync(path.join(__dirname, "..", name.replace("@/", "") + ".ts"), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(code, { exports, require: load, window: picker, crypto, DOMException, setTimeout, clearTimeout });
  return exports;
};
const file = new File(["shared content"], "hello.txt");
const child = { name: "sub", kind: "directory", async *values() { yield { name: file.name, kind: "file" }; },
  async getFileHandle(name) { assert.equal(name, file.name); return { getFile: async () => file }; } };
const root = { name: "fixture", async *values() { yield child; },
  async getDirectoryHandle(name) { assert.equal(name, "sub"); return child; } };
const picker = { showDirectoryPicker: async (options) => { assert.equal(options.mode, "read"); return root; } };
const { SharedFiles } = load("@/src/chat/sharedFiles");
const packets = [], received = [], notices = [], cancelled = [];
const options = { change() {}, notice: (text) => notices.push(text), cancelFile: (id) => cancelled.push(id) };
let owner, peer;
owner = new SharedFiles({ ...options,
  send: async (p, allowed = () => true) => { if (!allowed()) return false; packets.push(p); await peer.receive(p); return true; },
  sendFile: async (f, allowed) => { if (!allowed()) return false; received.push(await f.text()); return true; } });
peer = new SharedFiles({ ...options,
  send: async (p) => { await owner.receive(p); return true; }, sendFile: async () => false });
(async () => {
  await owner.toggle();
  assert.equal(owner.state.local, "fixture");
  assert.equal(peer.state.entries[0].name, "sub");
  const grant = packets.find((p) => p.type === "share").id;
  await peer.request("list", ["sub"]);
  assert.equal(peer.state.entries[0].name, "hello.txt");
  await peer.request("get", ["sub", "hello.txt"]);
  assert.deepEqual(received, ["shared content"]);
  assert.equal(peer.state.busy, false);
  for (const invalid of [["..", "secret"], ["/etc"], ["sub/../secret"], ["sub\\secret"], ["\0"]]) {
    await owner.receive({ protocol: "twoonly-files-v1", type: "get", id: grant, request: "bad", path: invalid });
  }
  await owner.toggle();
  await owner.receive({ protocol: "twoonly-files-v1", type: "get", id: grant, request: "stale", path: ["sub", "hello.txt"] });
  assert.equal(received.length, 1);
  assert.equal(peer.state.peer, "");
  let release;
  picker.showDirectoryPicker = () => new Promise((resolve) => { release = resolve; });
  const choosing = owner.toggle();
  owner.reset();
  release(root);
  await choosing;
  assert.equal(owner.state.local, "", "disconnect while picker is open must not grant access");
  picker.showDirectoryPicker = async () => root;
  await owner.toggle();
  child.getFileHandle = async () => ({ getFile: () => new Promise((resolve) => { release = resolve; }) });
  const reading = peer.request("get", ["sub", "hello.txt"]);
  await new Promise(setImmediate);
  await owner.toggle();
  child.getFileHandle = async () => ({ getFile: async () => file });
  await owner.toggle();
  await peer.request("get", ["sub", "hello.txt"]);
  assert.equal(received.length, 2, "a new grant must not wait for the old grant's read");
  release(file);
  await reading;
  assert.equal(received.length, 2, "revocation during a read must stop transmission");
  assert.ok(cancelled.length);
  assert.equal(notices.length, 0);
  owner.reset(); peer.reset();
  console.log("PASS directory navigation, file content, traversal rejection, revocation, picker/disconnect race");
})().catch((error) => { owner.reset(); peer.reset(); console.error(error); process.exitCode = 1; });
