import { useEffect, useRef } from "react";

import type { ChatMessage, ConnectionState, Role } from "@/src/chat/types";
import { formatTime } from "@/src/ui/formatters";

type MessageListProps = {
  role: Role;
  connection: ConnectionState;
  messages: ChatMessage[];
  copied: boolean;
  onCopyInvite: () => void;
  onReconnect: () => void;
};

export function MessageList({
  role,
  connection,
  messages,
  copied,
  onCopyInvite,
  onReconnect,
}: MessageListProps) {
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [messages.length]);

  return (
    <div className="message-list" ref={listRef}>
      {messages.length === 0 ? (
        <div className="empty-state">
          <div className="empty-symbol">💬</div>
          <h3>暂无消息</h3>
          <p>{connection === "connected" ? "发送一条消息开始聊天" : role === "host" ? "邀请对方加入后即可开始聊天" : "正在连接…"}</p>
          {role === "host" && connection !== "connected" ? (
            <button className="secondary-button" onClick={onCopyInvite}>{copied ? "链接已复制" : "复制邀请链接"}</button>
          ) : null}
          {connection === "disconnected" ? (
            <button className="retry-button" onClick={onReconnect}>立即重连</button>
          ) : null}
        </div>
      ) : messages.map((message) => {
        const mine = message.author === role;
        return (
          <article className={`message-row ${mine ? "mine" : "theirs"}`} key={message.id}>
            <div className="message-avatar">{mine ? "我" : "Ta"}</div>
            <div className="message-content">
              <div className="message-meta"><span>{mine ? "我" : "对方"}</span><time>{formatTime(message.createdAt)}</time></div>
              <div className={`message-bubble ${message.kind}`}>
                {message.kind === "text" ? <p>{message.content}</p> : null}
                {message.kind === "image" ? <img src={message.content} alt={message.fileName || "聊天图片"} /> : null}
                {message.kind === "audio" ? <audio src={message.content} controls preload="metadata" /> : null}
              </div>
            </div>
          </article>
        );
      })}
    </div>
  );
}
