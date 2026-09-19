import { useState, type FormEvent } from "react";

import type { ChatProfile, ConnectionState, ConversationSummary } from "@/src/chat/types";
import type { NotificationStatus } from "@/src/chat/messageNotifications";
import { AvatarContent } from "@/src/ui/AvatarContent";
import { AvatarUploader } from "@/src/ui/AvatarUploader";

type ChatHeaderProps = {
  profile: ChatProfile;
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
  onEditRoom: (roomId: string) => void;
  onProfileChange: (profile: ChatProfile) => void;
  notificationStatus: NotificationStatus;
  onToggleNotifications: () => void;
};

function ProfileEditor({
  profile,
  onProfileChange,
}: Pick<ChatHeaderProps, "profile" | "onProfileChange">) {
  const [avatar, setAvatar] = useState(profile.avatar);

  const saveProfile = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const nickname = String(values.get("nickname")).trim();
    if (!nickname || !avatar) return;
    event.currentTarget.closest("details")?.removeAttribute("open");
    onProfileChange({ nickname, avatar });
  };

  return (
    <form className="profile-editor" onSubmit={saveProfile}>
      <strong>本机资料</strong>
      <label className="profile-name">
        <span>昵称</span>
        <input name="nickname" defaultValue={profile.nickname} maxLength={16} required />
      </label>
      <fieldset>
        <legend>头像</legend>
        <AvatarUploader value={avatar} fallback="🙂" title="裁切个人头像" onChange={setAvatar} />
      </fieldset>
      <small>头像会裁成 200 × 200 并保存在本机；修改后会加密同步，双方历史消息里的头像和昵称也会一起更新。</small>
      <button type="submit">保存</button>
    </form>
  );
}

export function ChatHeader({
  profile,
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
  onEditRoom,
  onProfileChange,
  notificationStatus,
  onToggleNotifications,
}: ChatHeaderProps) {
  const activeConversation = conversations.find((room) => room.roomId === activeRoomId);
  const notificationLabel = notificationStatus === "on" ? "关闭消息通知"
    : notificationStatus === "blocked" ? "通知被阻止，查看开启方法"
    : notificationStatus === "unsupported" ? "当前浏览器不支持系统通知"
    : notificationStatus === "requesting" ? "等待通知授权" : "开启消息通知";

  return (
    <header className="chat-header">
      <div>
        <h2>{activeConversation?.title ?? "双人聊天"} <span className="member-count">2</span></h2>
        <p><span className={`status-dot ${connection}`} /> {connectionMode}</p>
      </div>
      <div className="header-actions">
        <button
          type="button"
          className="notification-button"
          onClick={onToggleNotifications}
          aria-label={notificationLabel}
          aria-pressed={notificationStatus === "on"}
          title={`${notificationLabel}；需要保持网页打开，不显示消息正文`}
          disabled={notificationStatus === "unsupported" || notificationStatus === "requesting"}
        >
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
            <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" />
            {notificationStatus !== "on" ? <path d="m3 3 18 18" /> : null}
          </svg>
        </button>
        <details className="profile-menu">
          <summary className="profile-avatar" aria-label="设置昵称和头像" title={profile.nickname}>
            <AvatarContent value={profile.avatar} fallback="🙂" alt={`${profile.nickname}的头像`} />
          </summary>
          <ProfileEditor
            key={`${profile.nickname}:${profile.avatar}`}
            profile={profile}
            onProfileChange={onProfileChange}
          />
        </details>
        <select
          className="mobile-room-select"
          value={activeRoomId}
          onChange={(event) => onOpenRoom(event.target.value)}
          aria-label="切换以前的聊天"
        >
          {conversations.map((room) => (
            <option value={room.roomId} key={room.roomId}>
              {room.title} · {room.connection === "connected" ? "已连接" : "连接中"}
              {room.unreadCount > 0 ? ` · ${room.unreadCount} 条未读` : ""}
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
        <button className="mobile-room-settings-button" onClick={() => onEditRoom(activeRoomId)}>设置</button>
        <button className="mobile-new-button" onClick={onCreateRoom}>新聊天</button>
      </div>
    </header>
  );
}
