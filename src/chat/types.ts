export type ConnectionState = "waiting" | "connecting" | "connected" | "disconnected";

export type MessageKind = "text" | "image" | "audio";

export type MessageAuthor = "self" | "peer";

export type ChatProfile = {
  nickname: string;
  avatar: string;
};

export type ChatMessage = {
  id: string;
  kind: MessageKind;
  content: string;
  author: MessageAuthor;
  createdAt: number;
  fileName?: string;
  profile?: ChatProfile;
};

export type EncryptedWire = {
  id: string;
  iv: string;
  data: string;
};

export type ConversationSummary = {
  roomId: string;
  lastOpenedAt: number;
  title: string;
  icon: string;
  connection: ConnectionState;
  preview: string;
};
