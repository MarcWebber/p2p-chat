import { CHAT_POLICY } from "@/src/config/policy";

type Entry = { name: string; directory: boolean };
type Directory = FileSystemDirectoryHandle & { values(): AsyncIterable<FileSystemHandle> };
type Packet = {
  protocol: "twoonly-files-v1";
  type: "share" | "list" | "get" | "result";
  id: string;
  request?: string;
  name?: string;
  path?: string[];
  entries?: Entry[];
  error?: string;
};
export type SharedFilesState = { local: string; peer: string; path: string[]; entries: Entry[]; busy: boolean };
const validName = (name: unknown): name is string => typeof name === "string"
  && name.length > 0 && name.length <= 255 && !/[\\/\0]/u.test(name) && name !== "." && name !== "..";
const validPath = (path: unknown): path is string[] => Array.isArray(path) && path.length <= 64 && path.every(validName);

export class SharedFiles {
  state: SharedFilesState = { local: "", peer: "", path: [], entries: [], busy: false };
  private root?: Directory;
  private localId = "";
  private peerId = "";
  private pending = "";
  private serving = "";
  private generation = 0;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(private readonly options: {
    send: (packet: Packet, allowed?: () => boolean) => Promise<boolean>;
    sendFile: (file: File, allowed: () => boolean, request: string) => Promise<boolean>;
    cancelFile: (request: string) => void;
    change: (state: SharedFilesState) => void;
    notice: (message: string) => void;
  }) {}

  private update(patch: Partial<SharedFilesState>) {
    this.state = { ...this.state, ...patch, busy: Boolean(this.pending) };
    this.options.change(this.state);
  }

  private finish(cancel = false) {
    if (cancel && this.pending) this.options.cancelFile(this.pending);
    clearTimeout(this.timer);
    this.pending = "";
    this.update({});
  }

  reset() {
    this.generation += 1;
    this.root = undefined;
    this.localId = this.peerId = "";
    this.finish(true);
    this.update({ local: "", peer: "", path: [], entries: [] });
  }

  async toggle() {
    const generation = ++this.generation;
    try {
      if (this.root) {
        this.root = undefined;
        this.localId = "";
      } else {
        const picker = (window as Window & { showDirectoryPicker?: (options: { mode: "read" }) => Promise<Directory> }).showDirectoryPicker;
        if (!picker) return this.options.notice("共享目录需要桌面 Chrome 或 Edge。");
        const root = await picker.call(window, { mode: "read" });
        if (generation !== this.generation) return;
        this.root = root;
        this.localId = crypto.randomUUID();
      }
      this.update({ local: this.root?.name ?? "" });
      const id = this.localId;
      if (!await this.options.send({ protocol: "twoonly-files-v1", type: "share", id, name: this.state.local }, () => id === this.localId)) {
        if (generation === this.generation) this.reset();
        this.options.notice("连接已断开，请重新共享目录。");
      }
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) this.options.notice("无法共享目录，请检查浏览器读取权限。");
    }
  }

  async request(type: "list" | "get", path: string[]) {
    if (!this.peerId || this.pending || !validPath(path)) return;
    const request = this.pending = crypto.randomUUID();
    this.update({});
    this.timer = setTimeout(() => {
      this.finish(true);
      this.options.notice("文件访问超时，请重试。");
    }, 120_000);
    if (!await this.options.send({ protocol: "twoonly-files-v1", type, id: this.peerId, request, path })) {
      if (this.pending === request) this.finish(true);
      this.options.notice("文件访问发送失败，请检查连接。");
    }
  }

  async receive(value: unknown) {
    const packet = value as Partial<Packet> | null;
    if (packet?.protocol !== "twoonly-files-v1") return false;
    if (typeof packet.id !== "string" || packet.id.length > 128) return true;
    if (packet.type === "share" && Boolean(packet.name) === Boolean(packet.id) && (packet.name === "" || validName(packet.name))) {
      this.finish(true);
      this.peerId = packet.id;
      this.update({ peer: packet.name, path: [], entries: [] });
      await this.request("list", []);
    } else if (packet.type === "result" && packet.id === this.peerId && packet.request === this.pending && this.pending) {
      this.finish(Boolean(packet.error));
      if (typeof packet.error === "string") this.options.notice(packet.error.slice(0, 200));
      else if (validPath(packet.path) && Array.isArray(packet.entries) && packet.entries.length <= 1000
        && packet.entries.every((entry) => entry && validName(entry.name) && typeof entry.directory === "boolean")) {
        this.update({ path: packet.path, entries: packet.entries });
      }
    } else if ((packet.type === "list" || packet.type === "get") && packet.id && packet.id === this.localId
      && validPath(packet.path) && (packet.type === "list" || packet.path.length > 0)
      && typeof packet.request === "string" && packet.request.length > 0 && packet.request.length <= 128) {
      const allowed = () => packet.id === this.localId;
      const response: Packet = { protocol: "twoonly-files-v1", type: "result", id: packet.id, request: packet.request };
      if (this.serving === packet.id) {
        await this.options.send({ ...response, error: "正在读取文件，请稍后重试。" }, allowed);
        return true;
      }
      this.serving = packet.id;
      try {
        let directory = this.root!;
        const parents = packet.type === "get" ? packet.path.slice(0, -1) : packet.path;
        for (const name of parents) directory = await directory.getDirectoryHandle(name) as Directory;
        if (!allowed()) return true;
        if (packet.type === "get") {
          const file = await (await directory.getFileHandle(packet.path.at(-1)!)).getFile();
          if (file.size > CHAT_POLICY.maxFileBytes) throw new Error("文件超过 100 MB。");
          if (!allowed() || !await this.options.sendFile(file, allowed, packet.request)) throw new Error("文件传输未完成，请重试。");
        } else {
          response.path = packet.path;
          response.entries = [];
          for await (const entry of directory.values()) {
            if (response.entries.length === 1000) throw new Error("目录超过 1000 项，请共享较小的子目录。");
            response.entries.push({ name: entry.name, directory: entry.kind === "directory" });
          }
          response.entries.sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
        }
      } catch (error) {
        response.error = error instanceof Error && !(error instanceof DOMException) ? error.message : "文件不存在或目录读取权限已失效。";
      } finally {
        if (this.serving === packet.id) this.serving = "";
      }
      await this.options.send(response, allowed);
    }
    return true;
  }
}
