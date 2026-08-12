import { useState, type KeyboardEvent, type PointerEvent } from "react";

import type { ConversationSummary } from "@/src/chat/types";
import { AvatarContent } from "@/src/ui/AvatarContent";
import { formatMinuteTime } from "@/src/utils/format";

type ChatSidebarProps = {
  conversations: ConversationSummary[];
  activeRoomId: string;
  onCreateRoom: () => void;
  onClearHistory: () => void;
  onOpenRoom: (roomId: string) => void;
  onMoveRoom: (sourceRoomId: string, targetRoomId: string) => void;
  onEditRoom: (roomId: string) => void;
};

export function ChatSidebar({
  conversations,
  activeRoomId,
  onCreateRoom,
  onClearHistory,
  onOpenRoom,
  onMoveRoom,
  onEditRoom,
}: ChatSidebarProps) {
  const [draggedRoomId, setDraggedRoomId] = useState("");
  const [dropRoomId, setDropRoomId] = useState("");
  const connectedRooms = conversations.filter((room) => room.connection === "connected").length;

  const roomAtPoint = (x: number, y: number) => (
    document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-room-id]")?.dataset.roomId ?? ""
  );

  const beginDrag = (event: PointerEvent<HTMLButtonElement>, roomId: string) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setDraggedRoomId(roomId);
  };

  const moveDrag = (event: PointerEvent<HTMLButtonElement>) => {
    if (!draggedRoomId) return;
    const targetRoomId = roomAtPoint(event.clientX, event.clientY);
    if (targetRoomId) setDropRoomId(targetRoomId);
  };

  const dropRoom = (event: PointerEvent<HTMLButtonElement>) => {
    const targetRoomId = roomAtPoint(event.clientX, event.clientY) || dropRoomId;
    if (draggedRoomId && targetRoomId && draggedRoomId !== targetRoomId) {
      onMoveRoom(draggedRoomId, targetRoomId);
    }
    setDraggedRoomId("");
    setDropRoomId("");
  };

  const moveWithKeyboard = (event: KeyboardEvent<HTMLButtonElement>, roomId: string) => {
    const index = conversations.findIndex((room) => room.roomId === roomId);
    const direction = event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0;
    const target = conversations[index + direction];
    if (!direction || !target) return;
    event.preventDefault();
    onMoveRoom(roomId, target.roomId);
  };

  return (
    <>
      <aside className="app-rail" aria-label="TwoOnly">
        <div className="rail-logo">2</div>
        <span className="rail-caption">私聊</span>
      </aside>
      <aside className="chat-sidebar">
        <div className="sidebar-top">
          <div>
            <strong>双人聊天</strong>
            <small>{conversations.length} 个聊天 · {connectedRooms} 个已连接</small>
          </div>
          <button onClick={onCreateRoom} aria-label="新建聊天">＋ 新建</button>
        </div>
        <div className="conversation-list">
          {conversations.map((room) => {
            const active = room.roomId === activeRoomId;
            return (
              <div
                className={`conversation-card ${active ? "active" : ""} ${dropRoomId === room.roomId ? "drop-target" : ""}`}
                key={room.roomId}
                data-room-id={room.roomId}
              >
                <button
                  type="button"
                  className="conversation-drag"
                  title="拖动调整顺序，也可用上下方向键"
                  aria-label={`调整${room.title}顺序`}
                  onPointerDown={(event) => beginDrag(event, room.roomId)}
                  onPointerMove={moveDrag}
                  onPointerUp={dropRoom}
                  onPointerCancel={() => {
                    setDraggedRoomId("");
                    setDropRoomId("");
                  }}
                  onKeyDown={(event) => moveWithKeyboard(event, room.roomId)}
                >⠿</button>
                <button
                  className="conversation-open"
                  onClick={() => onOpenRoom(room.roomId)}
                  aria-current={active ? "page" : undefined}
                >
                  <span className="conversation-avatar">
                    <AvatarContent value={room.icon} fallback="2" alt={`${room.title}图标`} />
                  </span>
                  <span className="conversation-copy">
                    <span><strong>{room.title}</strong><time>{formatMinuteTime(room.lastOpenedAt)}</time></span>
                    <small><i className={`status-dot ${room.connection}`} /> {room.preview}</small>
                  </span>
                </button>
                <button
                  className="conversation-settings"
                  type="button"
                  onClick={() => onEditRoom(room.roomId)}
                  aria-label={`设置${room.title}`}
                  title="重命名或更换图标"
                >⋯</button>
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
