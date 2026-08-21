import { useState } from "react";

import type { TwoOnlyChatController } from "@/src/chat/useTwoOnlyChat";
import { ChatHeader } from "@/src/ui/ChatHeader";
import { ChatSidebar } from "@/src/ui/ChatSidebar";
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
        <MessageList
          profile={props.profile}
          peerProfile={props.peerProfile}
          connection={props.connection}
          messages={props.messages}
          copied={props.copied}
          onCopyInvite={props.copyInvite}
          onReconnect={props.reconnect}
          onDeleteMessage={props.deleteLocalMessage}
          onReplyMessage={props.replyToMessage}
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
          replyingTo={props.replyingTo}
          isRecording={props.isRecording}
          onDraftChange={props.setDraft}
          onCancelReply={props.cancelReply}
          onSubmit={props.submitText}
          onChooseImage={props.chooseImage}
          onChooseFile={props.chooseFile}
          onPasteFile={props.pasteFile}
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
          onDelete={(roomId) => {
            if (props.deleteLocalRoom(roomId)) setEditingRoomId("");
          }}
          onSave={(roomId, patch) => {
            props.updateStoredRoom(roomId, patch);
            setEditingRoomId("");
          }}
        />
      ) : null}
    </main>
  );
}
