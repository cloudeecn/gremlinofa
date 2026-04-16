export interface Session {
  id: string;
  callerId: string;
  displayName: string | null;
  createdAt: string;
  lastActivityAt: string;
}

export interface SessionMessage {
  id: string;
  sessionId: string;
  role: 'ai' | 'human';
  content: string;
  /** JSON-encoded Array<{ path: string; content: string }> */
  files: string | null;
  createdAt: string;
}

export interface PendingRequest {
  id: string;
  sessionId: string;
  messageId: string;
  status: 'pending' | 'answered' | 'expired';
  responseMessageId: string | null;
  createdAt: string;
  answeredAt: string | null;
}

export interface InjectedFile {
  path: string;
  content: string;
}
