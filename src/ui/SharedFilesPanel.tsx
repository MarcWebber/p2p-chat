import type { TwoOnlyChatController } from "@/src/chat/useTwoOnlyChat";

export function SharedFilesPanel({ sharedFiles, files, connection }: Pick<TwoOnlyChatController, "sharedFiles" | "files" | "connection">) {
  const connected = connection === "connected";
  return (
    <details className="shared-files">
      <summary>共享文件夹{files?.local ? ` · 正在共享 ${files.local}` : ""}{files?.peer ? " · 对方已共享" : ""}</summary>
      <button disabled={!connected} onClick={() => void sharedFiles?.toggle()}>
        {files?.local ? "停止共享" : "选择文件夹，只读共享"}
      </button>
      {files?.peer ? <>
        <p>对方：{[files.peer, ...files.path].join(" / ")}</p>
        <button disabled={files.busy || !connected || !files.path.length}
          onClick={() => void sharedFiles?.request("list", files.path.slice(0, -1))}>上一级</button>
        <button disabled={files.busy || !connected}
          onClick={() => void sharedFiles?.request("list", files.path)}>刷新</button>
        <span role="status">{files.busy ? "处理中…" : "点击文件后，在聊天中下载"}</span>
        <ul>{files.entries.map((entry) => <li key={entry.name}>
          <button disabled={files.busy || !connected}
            onClick={() => void sharedFiles?.request(entry.directory ? "list" : "get", [...files.path, entry.name])}>
            {entry.directory ? "📁" : "📄"} {entry.name}
          </button>
        </li>)}</ul>
        {!files.busy && !files.entries.length ? <p>目录为空</p> : null}
      </> : <p>对方共享后，可浏览目录并获取文件。断线后需重新共享。</p>}
    </details>
  );
}
