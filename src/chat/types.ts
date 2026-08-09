export type Role = "host" | "guest";

export type ConnectionState = "waiting" | "connecting" | "connected" | "disconnected";

export type MessageKind = "text" | "image" | "audio";

export type ChatMessage = {
  id: string;
  kind: MessageKind;
  content: string;
  author: Role;
  createdAt: number;
  fileName?: string;
};

export type EncryptedWire = {
  id: string;
  iv: string;
  data: string;
};
