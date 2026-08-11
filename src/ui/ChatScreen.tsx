import type { TwoOnlyChatController } from "@/src/chat/useTwoOnlyChat";
import { ChatHeader } from "@/src/ui/ChatHeader";
import { ChatSidebar } from "@/src/ui/ChatSidebar";
import { ConnectionDiagnosticsPanel } from "@/src/ui/ConnectionDiagnosticsPanel";
import { MessageComposer } from "@/src/ui/MessageComposer";
import { MessageList } from "@/src/ui/MessageList";

export function ChatScreen(props: TwoOnlyChatController) {
  return (
    <main className="chat-shell">
      <ChatSidebar
        conversations={props.conversations}
        activeRoomId={props.activeRoomId}
        messages={props.messages}
        connection={props.connection}
        onCreateRoom={props.createFreshRoom}
        onClearHistory={props.clearLocalHistory}
        onOpenRoom={props.openStoredRoom}
      />
      <section className="chat-main">
        <ChatHeader
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
        />
        <ConnectionDiagnosticsPanel diagnostics={props.diagnostics} />
        <MessageList
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
          onStartRecording={props.startRecording}
          onStopRecording={props.stopRecording}
        />
      </section>
    </main>
  );
}
