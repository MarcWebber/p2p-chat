"use client";

import { useTwoOnlyChat } from "@/src/chat/useTwoOnlyChat";
import { TwoOnlyView } from "@/src/ui/TwoOnlyView";

export function TwoOnlyApp() {
  const chat = useTwoOnlyChat();
  return <TwoOnlyView chat={chat} />;
}
