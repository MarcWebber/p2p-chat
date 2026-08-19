import { useEffect, useRef, useState } from "react";

import type { ChatMessage, ChatProfile, ConnectionState } from "@/src/chat/types";
import { AvatarContent } from "@/src/ui/AvatarContent";
import { copyText } from "@/src/utils/browser";
import { formatBytes, formatMinuteTime } from "@/src/utils/format";

type MessageListProps = {
  profile: ChatProfile;
  connection: ConnectionState;
  messages: ChatMessage[];
  copied: boolean;
  onCopyInvite: () => void;
  onReconnect: () => void;
  onDeleteMessage: (messageId: string) => void;
};

function safeAttachmentSource(message: ChatMessage) {
  if (message.content.startsWith("blob:")) return message.content;
  if (message.kind === "image" && message.content.startsWith("data:image/")) return message.content;
  if (message.kind === "audio" && message.content.startsWith("data:audio/")) return message.content;
  if (message.kind === "file" && message.content.startsWith("data:")) return message.content;
  return "";
}

export function MessageList({
  profile,
  connection,
  messages,
  copied,
  onCopyInvite,
  onReconnect,
  onDeleteMessage,
}: MessageListProps) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const copyTimerRef = useRef<number | undefined>(undefined);
  const [copiedMessageId, setCopiedMessageId] = useState("");

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [messages.length]);

  useEffect(() => () => {
    if (copyTimerRef.current !== undefined) window.clearTimeout(copyTimerRef.current);
  }, []);

  const copyMessage = async (message: ChatMessage) => {
    if (!await copyText(message.content)) return;
    setCopiedMessageId(message.id);
    if (copyTimerRef.current !== undefined) window.clearTimeout(copyTimerRef.current);
    copyTimerRef.current = window.setTimeout(() => {
      copyTimerRef.current = undefined;
      setCopiedMessageId("");
    }, 1_500);
  };

  return (
    <div className="message-list" ref={listRef}>
      {messages.length === 0 ? (
        <div className="empty-state">
          <div className="empty-symbol">💬</div>
          <h3>暂无消息</h3>
          <p>{connection === "connected" ? "发送一条消息开始聊天" : "保持页面打开，等待另一位参与者"}</p>
          {connection !== "connected" ? (
            <button className="secondary-button" onClick={onCopyInvite}>{copied ? "链接已复制" : "复制邀请链接"}</button>
          ) : null}
          {connection === "disconnected" ? (
            <button className="retry-button" onClick={onReconnect}>立即重连</button>
          ) : null}
        </div>
      ) : messages.map((message) => {
        const mine = message.author === "self";
        const messageProfile = mine ? profile : message.profile;
        const source = safeAttachmentSource(message);
        const transferActive = message.transferState === "sending" || message.transferState === "receiving";
        const progress = Math.round((message.transferProgress ?? 0) * 100);
        return (
          <article className={`message-row ${mine ? "mine" : "theirs"}`} key={message.id}>
            <div className="message-avatar">
              <AvatarContent
                value={messageProfile?.avatar}
                fallback="Ta"
                alt={`${messageProfile?.nickname ?? "对方"}的头像`}
              />
            </div>
            <div className="message-content">
              <div className="message-meta">
                <span>{messageProfile?.nickname ?? "对方"}</span>
                <time>{formatMinuteTime(message.createdAt)}</time>
                {message.kind === "text" ? (
                  <button type="button" onClick={() => void copyMessage(message)}>
                    {copiedMessageId === message.id ? "已复制" : "复制"}
                  </button>
                ) : null}
                <button
                  type="button"
                  className="message-delete-button"
                  onClick={() => onDeleteMessage(message.id)}
                  disabled={transferActive}
                  title={transferActive ? "附件传输完成或中断后才能删除" : "仅从本机删除"}
                  aria-label={`删除${mine ? "自己" : "对方"}的这条消息`}
                >删除</button>
              </div>
              <div className={`message-bubble ${message.kind}`}>
                {message.kind === "text" ? <p>{message.content}</p> : null}
                {message.kind === "image" && source ? <img src={source} alt={message.fileName || "聊天图片"} /> : null}
                {message.kind === "audio" && source ? <audio src={source} controls preload="metadata" /> : null}
                {message.kind === "file" ? (
                  <div className="file-card">
                    <span className="file-symbol" aria-hidden>DOC</span>
                    <span className="file-details">
                      <strong title={message.fileName}>{message.fileName || "未命名文件"}</strong>
                      <small>{message.fileSize === undefined ? "加密文件" : formatBytes(message.fileSize)} <i>Beta</i></small>
                    </span>
                    {source && !transferActive && message.transferState !== "failed" ? (
                      <a href={source} download={message.fileName || "download"} rel="noopener noreferrer">下载</a>
                    ) : null}
                  </div>
                ) : null}
                {transferActive ? (
                  <div className="attachment-status" role="status">
                    {message.transferState === "sending" ? "发送中" : "接收中"} {progress}%
                  </div>
                ) : null}
                {message.transferState === "failed" ? (
                  <div className="attachment-status failed">传输已中断，请重新发送</div>
                ) : null}
                {message.transient && message.transferState === "ready" ? (
                  <div className="attachment-status transient">仅保留在当前页面</div>
                ) : null}
              </div>
            </div>
          </article>
        );
      })}
    </div>
  );
}
