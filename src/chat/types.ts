export type ConnectionState = "waiting" | "connecting" | "connected" | "disconnected";

export type MessageKind = "text" | "image" | "audio";

export type MessageAuthor = "self" | "peer";

export type LegacyRole = "host" | "guest";

export type ChatMessage = {
  id: string;
  kind: MessageKind;
  content: string;
  author: MessageAuthor;
  createdAt: number;
  fileName?: string;
};

export type DecryptedChatMessage = Omit<ChatMessage, "author"> & {
  author: MessageAuthor | LegacyRole;
};

export type EncryptedWire = {
  id: string;
  iv: string;
  data: string;
};
