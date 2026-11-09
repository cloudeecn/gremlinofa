export interface Session {
  id: string;
  callerId: string;
  displayName: string | null;
  /**
   * Token of the user whose inbox shows this session; null = admin only (created without a token,
   * or its user was deleted). Internal: the API never echoes it back.
   */
  userToken: string | null;
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
  /** Username of the session's owner; null when the session has no token. */
  ownerUsername: string | null;
}

/** Which sessions a web viewer may see: the admin sees all, a user only those with their token. */
export type SessionScope = { kind: 'all' } | { kind: 'user'; token: string };

export interface User {
  /** 32 hex characters. */
  id: string;
  /** Unique regardless of letter case. */
  username: string;
  /** `scrypt$N$r$p$<salt>$<hash>`, see passwords.ts. */
  passwordHash: string;
  /** Routes sessions to this user (`userToken` on session creation); authenticates nothing. */
  token: string;
  createdAt: string;
}

/** Live counts over retained sessions, so they drop when retention deletes sessions. */
export interface UserStats {
  sessions: number;
  aiMessages: number;
  humanReplies: number;
  /** Questions still waiting for an answer. */
  pending: number;
  /** Newest activity across the sessions; null without any. */
  lastActivityAt: string | null;
}

export interface UserStatsReport {
  /** Every user, ordered by username regardless of case; a user without sessions has zeros. */
  users: Array<{ user: User; stats: UserStats }>;
  /** Sessions without an owner, which only the admin sees. */
  noToken: UserStats;
}
