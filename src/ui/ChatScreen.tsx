import { useState } from "react";

import type { TwoOnlyChatController } from "@/src/chat/useTwoOnlyChat";
import { ChatHeader } from "@/src/ui/ChatHeader";
import { ChatSidebar } from "@/src/ui/ChatSidebar";
import { ConnectionDiagnosticsPanel } from "@/src/ui/ConnectionDiagnosticsPanel";
import { MessageComposer } from "@/src/ui/MessageComposer";
import { MessageList } from "@/src/ui/MessageList";
import { RoomSettingsDialog } from "@/src/ui/RoomSettingsDialog";

export function ChatScreen(props: TwoOnlyChatController) {
  const [editingRoomId, setEditingRoomId] = useState("");
  const editingRoom = props.conversations.find((room) => room.roomId === editingRoomId);

  return (
    <main className="chat-shell">
      <ChatSidebar
        conversations={props.conversations}
        activeRoomId={props.activeRoomId}
        onCreateRoom={props.createFreshRoom}
        onClearHistory={props.clearLocalHistory}
        onOpenRoom={props.openStoredRoom}
        onMoveRoom={props.moveStoredRoom}
        onEditRoom={setEditingRoomId}
      />
      <section className="chat-main">
        <ChatHeader
          profile={props.profile}
          connection={props.connection}
          connectionMode={props.connectionMode}
          safetyCode={props.safetyCode}
          copied={props.copied}
          onCopyInvite={props.copyInvite}
          onReconnect={props.reconnect}
          onCreateRoom={props.createFreshRoom}
          conversations={props.conversations}
          activeRoomId={props.activeRoomId}
          onOpenRoom={props.openStoredRoom}
          onEditRoom={setEditingRoomId}
          onProfileChange={props.updateProfile}
        />
        <ConnectionDiagnosticsPanel diagnostics={props.diagnostics} />
        <MessageList
          profile={props.profile}
          connection={props.connection}
          messages={props.messages}
          copied={props.copied}
          onCopyInvite={props.copyInvite}
          onReconnect={props.reconnect}
        />
        {props.notice ? (
          <div className="notice" role="status">
            {props.notice}
            <button onClick={props.clearNotice} aria-label="关闭提示">×</button>
          </div>
        ) : null}
        <MessageComposer
          connection={props.connection}
          draft={props.draft}
          isRecording={props.isRecording}
          onDraftChange={props.setDraft}
          onSubmit={props.submitText}
          onChooseImage={props.chooseImage}
          onChooseVideo={props.chooseVideo}
          onSendSticker={props.sendSticker}
          onStartRecording={props.startRecording}
          onStopRecording={props.stopRecording}
        />
      </section>
      {editingRoom ? (
        <RoomSettingsDialog
          key={editingRoom.roomId}
          room={editingRoom}
          onCancel={() => setEditingRoomId("")}
          onSave={(roomId, patch) => {
            props.updateStoredRoom(roomId, patch);
            setEditingRoomId("");
          }}
        />
      ) : null}
    </main>
  );
}
