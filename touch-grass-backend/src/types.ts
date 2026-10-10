export interface Session {
  id: string;
  callerId: string;
  displayName: string | null;
  createdAt: string;
  lastActivityAt: string;
}

export type FilePlacement = 'before' | 'after';

export interface InjectedFile {
  path: string;
  content: string;
  placement: FilePlacement;
  /** Content lines carry `%6d\t` line-number prefixes; the rendered markdown view strips them. */
  lineNumbers?: boolean;
}

export interface SessionMessage {
  id: string;
  sessionId: string;
  role: 'ai' | 'human';
  content: string;
  /** Stored as JSON text; parsed (and placement defaulted) on every read. */
  files: InjectedFile[] | null;
  createdAt: string;
  /** True for an AI message that opened a request; false for async notes and human messages. */
  awaitsReply: boolean;
}

export type RequestStatus = 'pending' | 'answered' | 'expired';

export type ExpireReason = 'timeout' | 'cancelled' | 'superseded';

export interface RequestRecord {
  id: string;
  sessionId: string;
  messageId: string;
  status: RequestStatus;
  responseMessageId: string | null;
  createdAt: string;
  answeredAt: string | null;
  /** Deadline the AI asked for (`timeoutMs`); null = waits forever. */
  expiresAt: string | null;
  expireReason: ExpireReason | null;
  /** When the request stopped being answerable. Equals `expiresAt` for timeouts. */
  expiredAt: string | null;
}

export interface PendingSummary {
  requestId: string;
  expiresAt: string | null;
  /** When the AI started waiting (the request's createdAt). */
  since: string;
}

export interface SessionListEntry extends Session {
  pending: PendingSummary | null;
}
