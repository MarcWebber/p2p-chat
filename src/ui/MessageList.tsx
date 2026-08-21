import { useEffect, useMemo, useRef, useState } from "react";

import type { ChatMessage, ChatProfile, ConnectionState } from "@/src/chat/types";
import { AvatarContent, isImageAvatar } from "@/src/ui/AvatarContent";
import { ImageViewerDialog } from "@/src/ui/ImageViewerDialog";
import { copyText } from "@/src/utils/browser";
import { formatBytes, formatMinuteTime } from "@/src/utils/format";

type MessageListProps = {
  profile: ChatProfile;
  peerProfile?: ChatProfile;
  connection: ConnectionState;
  messages: ChatMessage[];
  copied: boolean;
  onCopyInvite: () => void;
  onReconnect: () => void;
  onDeleteMessage: (messageId: string) => void;
  onReplyMessage: (messageId: string) => void;
};

type ImagePreview = {
  source: string;
  title: string;
  alt: string;
  messageId: string;
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
  peerProfile,
  connection,
  messages,
  copied,
  onCopyInvite,
  onReconnect,
  onDeleteMessage,
  onReplyMessage,
}: MessageListProps) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const copyTimerRef = useRef<number | undefined>(undefined);
  const highlightTimerRef = useRef<number | undefined>(undefined);
  const [copiedMessageId, setCopiedMessageId] = useState("");
  const [highlightedMessageId, setHighlightedMessageId] = useState("");
  const [imagePreview, setImagePreview] = useState<ImagePreview | null>(null);
  const messageIds = useMemo(() => new Set(messages.map((message) => message.id)), [messages]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [messages.length]);

  useEffect(() => {
    setImagePreview((current) => current && !messageIds.has(current.messageId) ? null : current);
  }, [messageIds]);

  useEffect(() => () => {
    if (copyTimerRef.current !== undefined) window.clearTimeout(copyTimerRef.current);
    if (highlightTimerRef.current !== undefined) window.clearTimeout(highlightTimerRef.current);
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

  const jumpToMessage = (messageId: string) => {
    const element = document.getElementById(`message-${messageId}`);
    if (!element) return;
    element.scrollIntoView({ behavior: "smooth", block: "center" });
    setHighlightedMessageId(messageId);
    if (highlightTimerRef.current !== undefined) window.clearTimeout(highlightTimerRef.current);
    highlightTimerRef.current = window.setTimeout(() => {
      highlightTimerRef.current = undefined;
      setHighlightedMessageId("");
    }, 1_600);
  };

  return (
    <>
      <div className="message-list" ref={listRef}>
        {messages.length === 0 ? (
          <div className="empty-state">
            <div className="empty-symbol">💬</div>
            <h3>暂无消息</h3>
            <p>{connection === "connected" ? "发条消息，和对方聊聊吧" : "保持页面打开，等待对方加入"}</p>
            {connection !== "connected" ? (
              <button className="secondary-button" onClick={onCopyInvite}>{copied ? "链接已复制" : "复制邀请链接"}</button>
            ) : null}
            {connection === "disconnected" ? (
              <button className="retry-button" onClick={onReconnect}>立即重连</button>
            ) : null}
          </div>
        ) : messages.map((message) => {
          const mine = message.author === "self";
          const messageProfile = mine ? profile : peerProfile ?? message.profile;
          const source = safeAttachmentSource(message);
          const messageAvatarSource = isImageAvatar(messageProfile?.avatar)
            ? messageProfile?.avatar ?? ""
            : "";
          const nickname = messageProfile?.nickname ?? "对方";
          const replyTo = message.replyTo;
          const transferActive = message.transferState === "sending" || message.transferState === "receiving";
          const progress = Math.round((message.transferProgress ?? 0) * 100);
          const replyTargetAvailable = Boolean(replyTo && messageIds.has(replyTo.messageId));
          return (
            <article
              id={`message-${message.id}`}
              className={`message-row ${mine ? "mine" : "theirs"}${highlightedMessageId === message.id ? " highlighted" : ""}`}
              key={message.id}
            >
              {messageAvatarSource ? (
                <button
                  type="button"
                  className="message-avatar avatar-viewable"
                  onClick={() => setImagePreview({
                    source: messageAvatarSource,
                    title: `${nickname}的头像`,
                    alt: `${nickname}的头像`,
                    messageId: message.id,
                  })}
                  aria-label={`查看${nickname}的头像`}
                  title="查看头像"
                >
                  <AvatarContent value={messageAvatarSource} fallback="Ta" alt={`${nickname}的头像`} />
                </button>
              ) : (
                <div className="message-avatar">
                  <AvatarContent
                    value={messageProfile?.avatar}
                    fallback="Ta"
                    alt={`${nickname}的头像`}
                  />
                </div>
              )}
              <div className="message-content">
                <div className="message-meta">
                  <span>{nickname}</span>
                  <time>{formatMinuteTime(message.createdAt)}</time>
                  {message.kind === "text" ? (
                    <button type="button" onClick={() => void copyMessage(message)}>
                      {copiedMessageId === message.id ? "已复制" : "复制"}
                    </button>
                  ) : null}
                  <button type="button" onClick={() => onReplyMessage(message.id)}>回复</button>
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
                  {replyTo ? (
                    <button
                      type="button"
                      className="message-reply-quote"
                      onClick={() => jumpToMessage(replyTo.messageId)}
                      disabled={!replyTargetAvailable}
                      title={replyTargetAvailable ? "查看原消息" : "原消息不在这台设备上"}
                    >
                      <strong>回复 {replyTo.nickname}</strong>
                      <span>{replyTo.preview}</span>
                    </button>
                  ) : null}
                  {message.kind === "text" ? <p>{message.content}</p> : null}
                  {message.kind === "image" && source ? (
                    <button
                      type="button"
                      className="message-image-button"
                      onClick={() => setImagePreview({
                        source,
                        title: message.fileName || "聊天图片",
                        alt: message.fileName || "聊天图片",
                        messageId: message.id,
                      })}
                      aria-label={`查看图片${message.fileName ? `：${message.fileName}` : ""}`}
                    >
                      <img src={source} alt={message.fileName || "聊天图片"} />
                    </button>
                  ) : null}
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
      {imagePreview ? (
        <ImageViewerDialog
          source={imagePreview.source}
          title={imagePreview.title}
          alt={imagePreview.alt}
          onClose={() => setImagePreview(null)}
        />
      ) : null}
    </>
  );
}
