import type { FormEvent } from "react";

import type { ChatProfile, ConnectionState, ConversationSummary } from "@/src/chat/types";

const AVATAR_OPTIONS = ["🙂", "😎", "🐱", "🐶", "🦊", "🐼", "👾", "🌙"];

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
  onProfileChange: (profile: ChatProfile) => void;
};

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
  onProfileChange,
}: ChatHeaderProps) {
  const saveProfile = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const nickname = String(values.get("nickname")).trim();
    const avatar = String(values.get("avatar"));
    if (!nickname || !avatar) return;
    event.currentTarget.closest("details")?.removeAttribute("open");
    onProfileChange({ nickname, avatar });
  };

  return (
    <header className="chat-header">
      <div>
        <h2>双人聊天 <span className="member-count">2</span></h2>
        <p><span className={`status-dot ${connection}`} /> {connectionMode}</p>
      </div>
      <div className="header-actions">
        <details className="profile-menu">
          <summary className="profile-avatar" aria-label="设置昵称和头像" title={profile.nickname}>
            {profile.avatar}
          </summary>
          <form className="profile-editor" key={`${profile.nickname}:${profile.avatar}`} onSubmit={saveProfile}>
            <strong>本机资料</strong>
            <label className="profile-name">
              <span>昵称</span>
              <input name="nickname" defaultValue={profile.nickname} maxLength={16} required />
            </label>
            <fieldset>
              <legend>头像</legend>
              <div className="profile-avatars">
                {AVATAR_OPTIONS.map((avatar) => (
                  <label key={avatar}>
                    <input
                      type="radio"
                      name="avatar"
                      value={avatar}
                      defaultChecked={avatar === profile.avatar}
                    />
                    <span>{avatar}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <small>资料只保存在本机；发消息时会加密展示给对方。</small>
            <button type="submit">保存</button>
          </form>
        </details>
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
