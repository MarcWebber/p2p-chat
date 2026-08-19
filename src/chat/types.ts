export type ConnectionState = "waiting" | "connecting" | "connected" | "disconnected";

export type MessageKind = "text" | "image" | "audio" | "file";

export type AttachmentMessageKind = Extract<MessageKind, "image" | "file">;

export type MessageAuthor = "self" | "peer";

export type ChatProfile = {
  nickname: string;
  avatar: string;
};

export type RoomMetadata = {
  title?: string;
  icon?: string;
  revision: number;
  versionId: string;
};

export type ChatMessage = {
  id: string;
  kind: MessageKind;
  content: string;
  author: MessageAuthor;
  createdAt: number;
  fileName?: string;
  fileSize?: number;
  mimeType?: string;
  transferState?: "sending" | "receiving" | "ready" | "failed";
  transferProgress?: number;
  transient?: boolean;
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
