import type { ChatMessage, ConnectionState, Role } from "@/src/chat/types";
import { ChatHeader } from "@/src/ui/ChatHeader";
import { ChatSidebar } from "@/src/ui/ChatSidebar";
import { MessageComposer } from "@/src/ui/MessageComposer";
import { MessageList } from "@/src/ui/MessageList";

type ChatScreenProps = {
  role: Role;
  connection: ConnectionState;
  connectionMode: string;
  messages: ChatMessage[];
  draft: string;
  notice: string;
  copied: boolean;
  isRecording: boolean;
  safetyCode: string;
  setDraft: (draft: string) => void;
  clearNotice: () => void;
  createFreshRoom: () => void;
  submitText: React.FormEventHandler<HTMLFormElement>;
  chooseImage: React.ChangeEventHandler<HTMLInputElement>;
  startRecording: () => void;
  stopRecording: () => void;
  copyInvite: () => void;
  clearLocalHistory: () => void;
  reconnect: () => void;
};

export function ChatScreen(props: ChatScreenProps) {
  return (
    <main className="chat-shell">
      <ChatSidebar
        messages={props.messages}
        connection={props.connection}
        onCreateRoom={props.createFreshRoom}
        onClearHistory={props.clearLocalHistory}
      />
      <section className="chat-main">
        <ChatHeader
          role={props.role}
          connection={props.connection}
          connectionMode={props.connectionMode}
          safetyCode={props.safetyCode}
          copied={props.copied}
          onCopyInvite={props.copyInvite}
          onReconnect={props.reconnect}
          onCreateRoom={props.createFreshRoom}
        />
        <MessageList
          role={props.role}
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
