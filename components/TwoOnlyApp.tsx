"use client";

import { useTwoOnlyChat } from "@/src/chat/useTwoOnlyChat";
import { ChatScreen } from "@/src/ui/ChatScreen";
import { LandingScreen } from "@/src/ui/LandingScreen";

export function TwoOnlyApp() {
  const chat = useTwoOnlyChat();
  if (!chat.ready) return <main className="app-shell" />;
  if (!chat.inRoom) {
    return <LandingScreen remoteSignalingEnabled={chat.hasRemoteSignaling} onCreateRoom={chat.createRoom} />;
  }
  return <ChatScreen {...chat} />;
}
