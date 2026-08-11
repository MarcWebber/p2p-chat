import type { ChatMessage, ConnectionState } from "@/src/chat/types";
import { formatMinuteTime } from "@/src/utils/format";

type ChatSidebarProps = {
  messages: ChatMessage[];
  connection: ConnectionState;
  onCreateRoom: () => void;
  onClearHistory: () => void;
};

export function ChatSidebar({ messages, connection, onCreateRoom, onClearHistory }: ChatSidebarProps) {
  const lastMessage = messages.at(-1);
  const preview = lastMessage?.kind === "text"
    ? lastMessage.content
    : lastMessage
      ? "[文件消息]"
      : connection === "connected"
        ? "已连接"
        : "等待对方加入";

  return (
    <>
      <aside className="app-rail" aria-label="TwoOnly">
        <div className="rail-logo">2</div>
        <span className="rail-caption">私聊</span>
        <div className="rail-spacer" />
        <div className="rail-avatar">我</div>
      </aside>
      <aside className="chat-sidebar">
        <div className="sidebar-top">
          <div><strong>双人聊天</strong><small>仅显示当前会话</small></div>
          <button onClick={onCreateRoom} aria-label="新建聊天">＋ 新建</button>
        </div>
        <div className="conversation-card active">
          <div className="conversation-avatar">2</div>
          <div className="conversation-copy">
            <div><strong>双人聊天</strong><time>{lastMessage ? formatMinuteTime(lastMessage.createdAt) : ""}</time></div>
            <small>{preview}</small>
          </div>
        </div>
        <div className="sidebar-bottom">
          <span>🔒 本地加密</span>
          <button className="text-button danger" onClick={onClearHistory}>清空记录</button>
        </div>
      </aside>
    </>
  );
}
