import type {
  ChatMessage,
  ConnectionState,
  ConversationSummary,
} from "@/src/chat/types";
import { formatMinuteTime } from "@/src/utils/format";

type ChatSidebarProps = {
  conversations: ConversationSummary[];
  activeRoomId: string;
  messages: ChatMessage[];
  connection: ConnectionState;
  onCreateRoom: () => void;
  onClearHistory: () => void;
  onOpenRoom: (roomId: string) => void;
};

export function ChatSidebar({
  conversations,
  activeRoomId,
  messages,
  connection,
  onCreateRoom,
  onClearHistory,
  onOpenRoom,
}: ChatSidebarProps) {
  const lastMessage = messages.at(-1);
  const activePreview = lastMessage?.kind === "text"
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
      </aside>
      <aside className="chat-sidebar">
        <div className="sidebar-top">
          <div><strong>双人聊天</strong><small>{conversations.length} 个本机会话</small></div>
          <button onClick={onCreateRoom} aria-label="新建聊天">＋ 新建</button>
        </div>
        <div className="conversation-list">
          {conversations.map((room) => {
            const active = room.roomId === activeRoomId;
            const preview = active
              ? activePreview
              : "已保存在本机，点击继续";
            return (
              <div className={`conversation-card ${active ? "active" : ""}`} key={room.roomId}>
                <button
                  className="conversation-open"
                  onClick={() => onOpenRoom(room.roomId)}
                  aria-current={active ? "page" : undefined}
                >
                  <span className="conversation-avatar">2</span>
                  <span className="conversation-copy">
                    <span><strong>双人聊天 · {room.roomId.slice(0, 5)}</strong><time>{formatMinuteTime(room.lastOpenedAt)}</time></span>
                    <small>{preview}</small>
                  </span>
                </button>
              </div>
            );
          })}
        </div>
        <div className="sidebar-bottom">
          <span>🔒 本地加密</span>
          <button className="text-button danger" onClick={onClearHistory}>清空当前记录</button>
        </div>
      </aside>
    </>
  );
}
