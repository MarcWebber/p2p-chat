import {
  useEffect,
  useRef,
  useState,
  type ChangeEventHandler,
  type ClipboardEvent,
  type FormEventHandler,
  type KeyboardEvent,
} from "react";

import type { ConnectionState } from "@/src/chat/types";
import { CHAT_POLICY } from "@/src/config/policy";
import { ExpressionPicker } from "@/src/ui/ExpressionPicker";
import { formatBytes } from "@/src/utils/format";

type MessageComposerProps = {
  connection: ConnectionState;
  draft: string;
  isRecording: boolean;
  onDraftChange: (draft: string) => void;
  onSubmit: FormEventHandler<HTMLFormElement>;
  onChooseImage: ChangeEventHandler<HTMLInputElement>;
  onChooseFile: ChangeEventHandler<HTMLInputElement>;
  onPasteFile: (file: File) => Promise<void>;
  onSendSticker: (src: string, label: string) => Promise<boolean>;
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
  onChooseFile,
  onPasteFile,
  onSendSticker,
  onStartRecording,
  onStopRecording,
}: MessageComposerProps) {
  const connected = connection === "connected";
  const [pickerOpen, setPickerOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!connected) setPickerOpen(false);
  }, [connected]);

  const insertExpression = (value: string) => {
    const start = inputRef.current?.selectionStart ?? draft.length;
    const end = inputRef.current?.selectionEnd ?? draft.length;
    onDraftChange(`${draft.slice(0, start)}${value}${draft.slice(end)}`);
    requestAnimationFrame(() => {
      const cursor = start + value.length;
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(cursor, cursor);
    });
  };

  const handleInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.code === "Space") {
      event.preventDefault();
      setPickerOpen((current) => !current);
    } else if (event.key === "Escape" && pickerOpen) {
      setPickerOpen(false);
    }
  };

  const handleSubmit: FormEventHandler<HTMLFormElement> = (event) => {
    setPickerOpen(false);
    onSubmit(event);
  };

  const handlePaste = (event: ClipboardEvent<HTMLInputElement>) => {
    const clipboardFile = Array.from(event.clipboardData.items)
      .find((item) => item.kind === "file")
      ?.getAsFile() ?? event.clipboardData.files[0];
    if (!clipboardFile) return;
    event.preventDefault();
    setPickerOpen(false);
    void onPasteFile(clipboardFile);
  };

  return (
    <>
      <form className="composer" onSubmit={handleSubmit}>
        <ExpressionPicker
          open={pickerOpen && connected}
          onClose={() => setPickerOpen(false)}
          onInsertText={insertExpression}
          onSendSticker={onSendSticker}
        />
        <div className="composer-tools">
          <button
            type="button"
            className={`tool-button ${pickerOpen ? "active" : ""}`}
            onClick={() => setPickerOpen((current) => !current)}
            aria-label="选择表情、颜文字或表情包"
            aria-expanded={pickerOpen}
            aria-controls="expression-picker"
            title="表情与颜文字（Ctrl/⌘ + Shift + 空格）"
            disabled={!connected}
          >
            <span aria-hidden>☺</span><span className="tool-label">表情</span>
          </button>
          <label className={`tool-button ${connected ? "" : "disabled"}`} title="发送图片">
            <span aria-hidden>▧</span><span className="tool-label">图片</span>
            <input type="file" accept="image/*" onChange={onChooseImage} disabled={!connected} />
          </label>
          <label className={`tool-button ${connected ? "" : "disabled"}`} title="发送文件（Beta）">
            <span aria-hidden>⇧</span><span className="tool-label">文件 <span className="beta-badge">Beta</span></span>
            <input type="file" onChange={onChooseFile} disabled={!connected} />
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
          ref={inputRef}
          className="message-input"
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={handleInputKeyDown}
          onPaste={handlePaste}
          placeholder={connected ? "输入消息" : "连接后即可发送"}
          aria-label="消息内容"
          disabled={!connected}
        />
        <button className="send-button" type="submit" disabled={!connected || !draft.trim()}>发送</button>
      </form>
      <p className="composer-hint">
        {connected
          ? `支持文本复制粘贴和剪贴板图片/文件 · 图片 ${formatBytes(CHAT_POLICY.maxImageBytes)} · 文件 Beta ${formatBytes(CHAT_POLICY.maxFileBytes)} · 语音 ${formatBytes(CHAT_POLICY.maxAudioBytes)}`
          : "等待安全连接建立后即可发送"}
      </p>
    </>
  );
}
