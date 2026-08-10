import type { TwoOnlyChatController } from "@/src/chat/useTwoOnlyChat";
import { ChatScreen } from "@/src/ui/ChatScreen";
import { LandingScreen } from "@/src/ui/LandingScreen";

type TwoOnlyViewProps = {
  chat: TwoOnlyChatController;
};

export function TwoOnlyView({ chat }: TwoOnlyViewProps) {
  if (!chat.ready) return <main className="app-shell" />;

  if (!chat.inRoom) {
    return (
      <LandingScreen
        remoteSignalingEnabled={chat.hasRemoteSignaling}
        onCreateRoom={chat.createRoom}
      />
    );
  }

  return <ChatScreen {...chat} />;
}
