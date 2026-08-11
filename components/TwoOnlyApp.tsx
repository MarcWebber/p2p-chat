"use client";

import { useTwoOnlyChat } from "@/src/chat/useTwoOnlyChat";
import { ChatScreen } from "@/src/ui/ChatScreen";
import { LandingScreen } from "@/src/ui/LandingScreen";

export function TwoOnlyApp() {
  const chat = useTwoOnlyChat();
  if (chat.view === "loading") return <main className="app-shell" />;
  if (chat.view === "landing") return <LandingScreen onCreateRoom={chat.createRoom} />;
  return <ChatScreen {...chat} />;
}
