import type { ConnectionState, ConversationSummary } from "@/src/chat/types";

type ChatHeaderProps = {
  connection: ConnectionState;
  connectionMode: string;
  safetyCode: string;
  copied: boolean;
  onCopyInvite: () => void;
  onReconnect: () => void;
  onCreateRoom: () => void;
  conversations: ConversationSummary[];
  activeRoomId: string;
  onOpenRoom: (roomId: string) => void;
};

export function ChatHeader({
  connection,
  connectionMode,
  safetyCode,
  copied,
  onCopyInvite,
  onReconnect,
  onCreateRoom,
  conversations,
  activeRoomId,
  onOpenRoom,
}: ChatHeaderProps) {
  return (
    <header className="chat-header">
      <div>
        <h2>双人聊天 <span className="member-count">2</span></h2>
        <p><span className={`status-dot ${connection}`} /> {connectionMode}</p>
      </div>
      <div className="header-actions">
        <select
          className="mobile-room-select"
          value={activeRoomId}
          onChange={(event) => onOpenRoom(event.target.value)}
          aria-label="切换以前的聊天"
        >
          {conversations.map((room) => (
            <option value={room.roomId} key={room.roomId}>
              聊天 {room.roomId.slice(0, 5)}
            </option>
          ))}
        </select>
        <span className="safety-code" title="请与对方核对安全码">安全码 {safetyCode}</span>
        {connection !== "connected" ? (
          <button className="invite-button" onClick={onCopyInvite}>{copied ? "已复制" : "邀请对方"}</button>
        ) : null}
        {connection === "disconnected" ? (
          <button className="retry-button header-retry" onClick={onReconnect}>立即重连</button>
        ) : null}
        <button className="mobile-new-button" onClick={onCreateRoom}>新聊天</button>
      </div>
    </header>
  );
}
