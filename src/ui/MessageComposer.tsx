import type { ChangeEventHandler, FormEventHandler } from "react";

import type { ConnectionState } from "@/src/chat/types";

type MessageComposerProps = {
  connection: ConnectionState;
  draft: string;
  isRecording: boolean;
  onDraftChange: (draft: string) => void;
  onSubmit: FormEventHandler<HTMLFormElement>;
  onChooseImage: ChangeEventHandler<HTMLInputElement>;
  onStartRecording: () => void;
  onStopRecording: () => void;
};

export function MessageComposer({
  connection,
  draft,
  isRecording,
  onDraftChange,
  onSubmit,
  onChooseImage,
  onStartRecording,
  onStopRecording,
}: MessageComposerProps) {
  const connected = connection === "connected";

  return (
    <>
      <form className="composer" onSubmit={onSubmit}>
        <div className="composer-tools">
          <label className={`tool-button ${connected ? "" : "disabled"}`} title="发送图片">
            <span aria-hidden>▧</span><span className="tool-label">图片</span>
            <input type="file" accept="image/*" onChange={onChooseImage} disabled={!connected} />
          </label>
          <button
            type="button"
            className={`tool-button record ${isRecording ? "recording" : ""}`}
            onClick={isRecording ? onStopRecording : onStartRecording}
            aria-label={isRecording ? "停止并发送录音" : "录制语音"}
            disabled={!connected}
          >
            <span aria-hidden>{isRecording ? "■" : "◉"}</span>
            <span className="tool-label">{isRecording ? "发送" : "语音"}</span>
          </button>
        </div>
        <input
          className="message-input"
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
          placeholder={connected ? "输入消息" : "连接后即可发送"}
          aria-label="消息内容"
          disabled={!connected}
        />
        <button className="send-button" type="submit" disabled={!connected || !draft.trim()}>发送</button>
      </form>
      <p className="composer-hint">{connected ? "消息已加密保存在本机 · 图片/语音上限 1.5 MB" : "等待安全连接建立后即可发送"}</p>
    </>
  );
}
