import { useState, type FormEvent } from "react";

import type { ConversationSummary } from "@/src/chat/types";
import { AvatarUploader } from "@/src/ui/AvatarUploader";

type RoomSettingsDialogProps = {
  room: ConversationSummary;
  onCancel: () => void;
  onSave: (roomId: string, patch: { title: string; icon: string }) => void;
};

export function RoomSettingsDialog({ room, onCancel, onSave }: RoomSettingsDialogProps) {
  const [title, setTitle] = useState(room.title);
  const [icon, setIcon] = useState(room.icon);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextTitle = title.trim();
    if (!nextTitle) return;
    onSave(room.roomId, { title: nextTitle, icon });
  };

  return (
    <div
      className="dialog-backdrop room-settings-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) onCancel();
      }}
    >
      <form className="room-settings-dialog" onSubmit={submit} role="dialog" aria-modal="true" aria-labelledby="room-settings-title">
        <div className="dialog-title-row">
          <div><strong id="room-settings-title">聊天设置</strong><small>名称和图标只保存在本机</small></div>
          <button type="button" onClick={onCancel} aria-label="关闭聊天设置">×</button>
        </div>
        <label className="room-title-field">
          <span>聊天名称</span>
          <input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={24} autoFocus required />
        </label>
        <div className="room-icon-field">
          <span>聊天图标</span>
          <AvatarUploader value={icon} fallback="2" title="裁切聊天图标" onChange={setIcon} />
        </div>
        <div className="dialog-actions">
          <button type="button" className="secondary-dialog-button" onClick={onCancel}>取消</button>
          <button type="submit" className="primary-dialog-button">保存</button>
        </div>
      </form>
    </div>
  );
}
