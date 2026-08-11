"use client";

import { useTwoOnlyChat } from "@/src/chat/useTwoOnlyChat";
import { REMOTE_SIGNALING_ENABLED } from "@/src/signal/signalTransport";
import { ChatScreen } from "@/src/ui/ChatScreen";
import { LandingScreen } from "@/src/ui/LandingScreen";

export function TwoOnlyApp() {
  const chat = useTwoOnlyChat();
  if (chat.view === "loading") return <main className="app-shell" />;
  if (chat.view === "landing") {
    return <LandingScreen remoteSignalingEnabled={REMOTE_SIGNALING_ENABLED} onCreateRoom={chat.createRoom} />;
  }
  return <ChatScreen {...chat} />;
}
