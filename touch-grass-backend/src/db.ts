import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import path from 'path';
import { config } from './config.js';
import type {
  InjectedFile,
  RequestRecord,
  Session,
  SessionListEntry,
  SessionMessage,
} from './types.js';

let db: Database.Database | null = null;

function conn(): Database.Database {
  if (!db) {
    throw new Error('initDatabase() has not run');
  }
  return db;
}

/** Opens (or reopens) the database and brings its schema up to date. */
export function initDatabase(dbPath: string = config.dbPath): void {
  if (db?.open) {
    db.close();
  }
  if (dbPath !== ':memory:' && dbPath !== '') {
    mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  }
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  applySchema(db);
  console.debug('Database initialized:', dbPath);
}

/** The raw connection, for inspection in tests and one-off maintenance. */
export function getDatabase(): Database.Database {
  return conn();
}

export function closeDatabase(): void {
  if (db?.open) {
    db.close();
  }
  db = null;
}

/** Columns added to `requests` after v1 shipped, in the order they were introduced. */
const REQUEST_COLUMNS_SINCE_V2: ReadonlyArray<readonly [name: string, declaration: string]> = [
  ['expiresAt', 'TEXT'],
  ['expireReason', `TEXT CHECK(expireReason IN ('timeout', 'cancelled', 'superseded'))`],
  ['expiredAt', 'TEXT'],
];

export function applySchema(database: Database.Database): void {
  const upgrading =
    database
      .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'requests'`)
      .get() !== undefined;

  database.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      callerId TEXT NOT NULL,
      displayName TEXT,
      createdAt TEXT NOT NULL,
      lastActivityAt TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      sessionId TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('ai', 'human')),
      content TEXT NOT NULL,
      files TEXT,
      createdAt TEXT NOT NULL,
      FOREIGN KEY (sessionId) REFERENCES sessions(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(sessionId, createdAt);

    CREATE TABLE IF NOT EXISTS requests (
      id TEXT PRIMARY KEY,
      sessionId TEXT NOT NULL,
      messageId TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'answered', 'expired')),
      responseMessageId TEXT,
      createdAt TEXT NOT NULL,
      answeredAt TEXT,
      FOREIGN KEY (sessionId) REFERENCES sessions(id) ON DELETE CASCADE,
      FOREIGN KEY (messageId) REFERENCES messages(id) ON DELETE CASCADE
    );
  `);

  // Fresh databases get the v2 columns the same way old ones do, so each has one definition.
  const addedColumns = migrateRequestColumns(database);
  if (upgrading && addedColumns.length > 0) {
    console.debug('Upgraded requests table, added columns', addedColumns);
  }

  // idx_requests_message serves the messages -> requests cascade. Without it, deleting a session
  // scans all of requests once per deleted message, which makes the retention sweep quadratic.
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_requests_pending ON requests(status, sessionId);
    CREATE INDEX IF NOT EXISTS idx_requests_session ON requests(sessionId, createdAt);
    CREATE INDEX IF NOT EXISTS idx_requests_message ON requests(messageId);
  `);
}

/** Adds the v2 columns a table lacks and backfills its v1 rows. Returns the added column names. */
function migrateRequestColumns(database: Database.Database): string[] {
  const existing = new Set(
    (database.prepare('PRAGMA table_info(requests)').all() as Array<{ name: string }>).map(
      column => column.name
    )
  );
  const missing = REQUEST_COLUMNS_SINCE_V2.filter(([name]) => !existing.has(name));
  if (missing.length === 0) {
    return [];
  }

  database.transaction(() => {
    for (const [name, declaration] of missing) {
      database.exec(`ALTER TABLE requests ADD COLUMN ${name} ${declaration}`);
    }
    if (!existing.has('expiresAt')) {
      // v1 requests had no deadline and the v1 client never cancelled, so a pending v1 row is
      // almost always an orphan that would stay answerable and pin its session past retention.
      // An hour from creation outlasts v1's default 10-minute client wait; lazy expiry then
      // closes the rest as expired(timeout). The format matches toISOString for comparisons.
      database
        .prepare(
          `UPDATE requests SET expiresAt = strftime('%Y-%m-%dT%H:%M:%fZ', createdAt, '+1 hour')
           WHERE status = 'pending'`
        )
        .run();
    }
    if (!existing.has('expireReason')) {
      // v1 expired requests only by superseding them, and stamped that moment into answeredAt.
      database
        .prepare(
          `UPDATE requests SET expireReason = 'superseded', expiredAt = answeredAt, answeredAt = NULL
           WHERE status = 'expired'`
        )
        .run();
    }
  })();
  return missing.map(([name]) => name);
}

/**
 * Lazy expiry: a pending request whose deadline passed becomes expired(timeout) the next time
 * anything reads requests. Every read path calls this first so nobody sees a stale `pending`.
 */
function expireOverdueRequests(database: Database.Database, nowIso: string): void {
  database
    .prepare(
      `UPDATE requests SET status = 'expired', expireReason = 'timeout', expiredAt = expiresAt
       WHERE status = 'pending' AND expiresAt IS NOT NULL AND expiresAt <= ?`
    )
    .run(nowIso);
}

// ── Sessions ──

export function createSession(id: string, callerId: string, displayName: string | null): Session {
  const now = new Date().toISOString();
  const session: Session = { id, callerId, displayName, createdAt: now, lastActivityAt: now };
  conn()
    .prepare(
      `INSERT INTO sessions (id, callerId, displayName, createdAt, lastActivityAt)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(
      session.id,
      session.callerId,
      session.displayName,
      session.createdAt,
      session.lastActivityAt
    );
  return session;
}

export function getSession(id: string): Session | undefined {
  return conn().prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Session | undefined;
}

interface SessionListRow extends Session {
  pendingRequestId: string | null;
  pendingExpiresAt: string | null;
  pendingSince: string | null;
}

/** Every session, most recently active first, with its pending request (if any) in one query. */
export function listSessionsWithPending(): SessionListEntry[] {
  const database = conn();
  expireOverdueRequests(database, new Date().toISOString());
  const rows = database
    .prepare(
      `SELECT s.*, r.id AS pendingRequestId, r.expiresAt AS pendingExpiresAt,
              r.createdAt AS pendingSince
       FROM sessions s
       LEFT JOIN requests r ON r.sessionId = s.id AND r.status = 'pending'
       ORDER BY s.lastActivityAt DESC, s.rowid DESC`
    )
    .all() as SessionListRow[];

  return rows.map(({ pendingRequestId, pendingExpiresAt, pendingSince, ...session }) => ({
    ...session,
    pending:
      pendingRequestId !== null && pendingSince !== null
        ? { requestId: pendingRequestId, expiresAt: pendingExpiresAt, since: pendingSince }
        : null,
  }));
}

/**
 * Deletes a session with its messages and requests. Returns the ids of the removed requests so
 * their long-polls can be told the request is gone, or null when the session does not exist.
 */
export function deleteSession(id: string): string[] | null {
  const database = conn();
  return database.transaction((): string[] | null => {
    const requestIds = (
      database.prepare('SELECT id FROM requests WHERE sessionId = ?').all(id) as Array<{
        id: string;
      }>
    ).map(row => row.id);
    const { changes } = database.prepare('DELETE FROM sessions WHERE id = ?').run(id);
    return changes > 0 ? requestIds : null;
  })();
}

/**
 * Retention: deletes sessions idle for more than `days` days. A session with a pending request
 * is kept no matter how old, since someone may still be waiting on it. Returns the count removed.
 */
export function sweepOldSessions(days: number): number {
  const database = conn();
  const nowMs = Date.now();
  const cutoff = new Date(nowMs - days * 24 * 60 * 60 * 1000).toISOString();
  return database.transaction(() => {
    expireOverdueRequests(database, new Date(nowMs).toISOString());
    return database
      .prepare(
        `DELETE FROM sessions
         WHERE lastActivityAt < ?
           AND NOT EXISTS (
             SELECT 1 FROM requests r WHERE r.sessionId = sessions.id AND r.status = 'pending'
           )`
      )
      .run(cutoff).changes;
  })();
}

// ── Messages ──

interface MessageRow extends Omit<SessionMessage, 'files' | 'awaitsReply'> {
  files: string | null;
  awaitsReply: 0 | 1;
}

/**
 * Message columns plus the derived `awaitsReply`. Derived rather than stored: a request is only
 * ever deleted together with its message, so an AI message without one is an async note.
 */
const MESSAGE_COLUMNS =
  'm.*, EXISTS(SELECT 1 FROM requests r WHERE r.messageId = m.id) AS awaitsReply';

function parseStoredFiles(json: string | null, messageId: string): InjectedFile[] | null {
  if (json === null) {
    return null;
  }
  let stored: unknown;
  try {
    stored = JSON.parse(json);
  } catch {
    console.debug('Ignoring malformed files JSON on message', messageId);
    return null;
  }
  if (!Array.isArray(stored)) {
    return null;
  }
  // Input is validated on the way in; this only guards rows written before validation existed.
  const files = stored.flatMap((entry): InjectedFile[] => {
    if (typeof entry?.path !== 'string' || typeof entry?.content !== 'string') {
      return [];
    }
    return [
      {
        path: entry.path,
        content: entry.content,
        placement: entry.placement === 'after' ? 'after' : 'before',
        ...(entry.lineNumbers === true && { lineNumbers: true }),
      },
    ];
  });
  return files.length > 0 ? files : null;
}

function toMessage(row: MessageRow): SessionMessage {
  return {
    ...row,
    files: parseStoredFiles(row.files, row.id),
    awaitsReply: row.awaitsReply === 1,
  };
}

export function getMessage(id: string): SessionMessage | undefined {
  const row = conn().prepare(`SELECT ${MESSAGE_COLUMNS} FROM messages m WHERE m.id = ?`).get(id) as
    | MessageRow
    | undefined;
  return row ? toMessage(row) : undefined;
}

export function getMessages(sessionId: string): SessionMessage[] {
  return getMessagesAfter(sessionId, 0);
}

/**
 * Messages after the first `offset` ones, in display order. A UI that already shows `offset`
 * messages asks for the rest; messages are never edited or reordered, so the offset is stable.
 */
export function getMessagesAfter(sessionId: string, offset: number): SessionMessage[] {
  const rows = conn()
    .prepare(
      `SELECT ${MESSAGE_COLUMNS} FROM messages m WHERE m.sessionId = ?
       ORDER BY m.createdAt ASC, m.rowid ASC
       LIMIT -1 OFFSET ?`
    )
    .all(sessionId, offset) as MessageRow[];
  return rows.map(toMessage);
}

/** The newest message of a session, e.g. to tell an async note from an open question. */
export function getLatestMessageForSession(sessionId: string): SessionMessage | undefined {
  const row = conn()
    .prepare(
      `SELECT ${MESSAGE_COLUMNS} FROM messages m WHERE m.sessionId = ?
       ORDER BY m.createdAt DESC, m.rowid DESC
       LIMIT 1`
    )
    .get(sessionId) as MessageRow | undefined;
  return row ? toMessage(row) : undefined;
}

// ── Requests ──

export interface PostAiMessageInput {
  sessionId: string;
  messageId: string;
  /** null posts an async note: the message is stored, but no request is opened. */
  requestId: string | null;
  content: string;
  files: InjectedFile[];
  /** How long the AI will wait; null = no deadline. Ignored for an async note. */
  timeoutMs: number | null;
}

export interface PostAiMessageResult {
  message: SessionMessage;
  /** null for an async note. */
  request: RequestRecord | null;
  /** Requests that were pending on this session and are now expired(superseded). */
  supersededRequestIds: string[];
}

/**
 * Records an AI message and, unless it is an async note, opens a request for it. Either way it
 * supersedes whatever was pending on the session: the AI has moved on from that question.
 * Returns null when the session does not exist.
 */
export function postAiMessage(
  input: PostAiMessageInput & { requestId: string }
): (PostAiMessageResult & { request: RequestRecord }) | null;
export function postAiMessage(input: PostAiMessageInput): PostAiMessageResult | null;
export function postAiMessage(input: PostAiMessageInput): PostAiMessageResult | null {
  const database = conn();
  return database.transaction((): PostAiMessageResult | null => {
    if (!getSession(input.sessionId)) {
      return null;
    }
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    // Runs first so an overdue request ends as timeout, not superseded.
    expireOverdueRequests(database, now);

    const supersededRequestIds = (
      database
        .prepare(`SELECT id FROM requests WHERE sessionId = ? AND status = 'pending'`)
        .all(input.sessionId) as Array<{ id: string }>
    ).map(row => row.id);
    database
      .prepare(
        `UPDATE requests SET status = 'expired', expireReason = 'superseded', expiredAt = ?
         WHERE sessionId = ? AND status = 'pending'`
      )
      .run(now, input.sessionId);

    const message: SessionMessage = {
      id: input.messageId,
      sessionId: input.sessionId,
      role: 'ai',
      content: input.content,
      files: input.files.length > 0 ? input.files : null,
      createdAt: now,
      awaitsReply: input.requestId !== null,
    };
    database
      .prepare(
        `INSERT INTO messages (id, sessionId, role, content, files, createdAt)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        message.id,
        message.sessionId,
        message.role,
        message.content,
        message.files ? JSON.stringify(message.files) : null,
        message.createdAt
      );

    let request: RequestRecord | null = null;
    if (input.requestId !== null) {
      request = {
        id: input.requestId,
        sessionId: input.sessionId,
        messageId: message.id,
        status: 'pending',
        responseMessageId: null,
        createdAt: now,
        answeredAt: null,
        expiresAt:
          input.timeoutMs === null ? null : new Date(nowMs + input.timeoutMs).toISOString(),
        expireReason: null,
        expiredAt: null,
      };
      database
        .prepare(
          `INSERT INTO requests (id, sessionId, messageId, status, createdAt, expiresAt)
           VALUES (?, ?, ?, 'pending', ?, ?)`
        )
        .run(
          request.id,
          request.sessionId,
          request.messageId,
          request.createdAt,
          request.expiresAt
        );
    }

    database
      .prepare('UPDATE sessions SET lastActivityAt = ? WHERE id = ?')
      .run(now, input.sessionId);

    return { message, request, supersededRequestIds };
  })();
}

export function getRequest(id: string): RequestRecord | undefined {
  const database = conn();
  expireOverdueRequests(database, new Date().toISOString());
  return database.prepare('SELECT * FROM requests WHERE id = ?').get(id) as
    | RequestRecord
    | undefined;
}

export function getPendingRequestForSession(sessionId: string): RequestRecord | undefined {
  const database = conn();
  expireOverdueRequests(database, new Date().toISOString());
  return database
    .prepare(`SELECT * FROM requests WHERE sessionId = ? AND status = 'pending' LIMIT 1`)
    .get(sessionId) as RequestRecord | undefined;
}

/** The newest request on a session in any state, e.g. to say when the AI stopped waiting. */
export function getLatestRequestForSession(sessionId: string): RequestRecord | undefined {
  const database = conn();
  expireOverdueRequests(database, new Date().toISOString());
  return database
    .prepare(
      `SELECT * FROM requests WHERE sessionId = ?
       ORDER BY createdAt DESC, rowid DESC
       LIMIT 1`
    )
    .get(sessionId) as RequestRecord | undefined;
}

export interface AnswerRequestInput {
  requestId: string;
  /** The session the answer was typed into; a request from another session is not found. */
  sessionId: string;
  messageId: string;
  content: string;
}

export type AnswerRequestResult =
  | { answered: true; message: SessionMessage; request: RequestRecord }
  /** `request` is the state that blocked the answer, or undefined when it does not exist. */
  | { answered: false; request: RequestRecord | undefined };

/** Records the human's answer, but only while the request is still pending and not overdue. */
export function answerRequest(input: AnswerRequestInput): AnswerRequestResult {
  const database = conn();
  return database.transaction((): AnswerRequestResult => {
    const now = new Date().toISOString();
    expireOverdueRequests(database, now);
    const current = database
      .prepare('SELECT * FROM requests WHERE id = ? AND sessionId = ?')
      .get(input.requestId, input.sessionId) as RequestRecord | undefined;
    if (current?.status !== 'pending') {
      return { answered: false, request: current };
    }

    const message: SessionMessage = {
      id: input.messageId,
      sessionId: input.sessionId,
      role: 'human',
      content: input.content,
      files: null,
      createdAt: now,
      awaitsReply: false,
    };
    database
      .prepare(
        `INSERT INTO messages (id, sessionId, role, content, files, createdAt)
         VALUES (?, ?, 'human', ?, NULL, ?)`
      )
      .run(message.id, message.sessionId, message.content, message.createdAt);
    database
      .prepare(
        `UPDATE requests SET status = 'answered', responseMessageId = ?, answeredAt = ?
         WHERE id = ? AND status = 'pending'`
      )
      .run(message.id, now, input.requestId);
    database
      .prepare('UPDATE sessions SET lastActivityAt = ? WHERE id = ?')
      .run(now, input.sessionId);

    return {
      answered: true,
      message,
      request: { ...current, status: 'answered', responseMessageId: message.id, answeredAt: now },
    };
  })();
}

export interface CancelRequestResult {
  /** Final state: answered (the human won the race) or expired. */
  request: RequestRecord;
  /** True when this call moved the request from pending to expired(cancelled). */
  cancelled: boolean;
}

/** Idempotent. Returns null when the request does not exist. */
export function cancelRequest(requestId: string): CancelRequestResult | null {
  const database = conn();
  return database.transaction((): CancelRequestResult | null => {
    const now = new Date().toISOString();
    expireOverdueRequests(database, now);
    const { changes } = database
      .prepare(
        `UPDATE requests SET status = 'expired', expireReason = 'cancelled', expiredAt = ?
         WHERE id = ? AND status = 'pending'`
      )
      .run(now, requestId);
    const request = database.prepare('SELECT * FROM requests WHERE id = ?').get(requestId) as
      | RequestRecord
      | undefined;
    return request ? { request, cancelled: changes > 0 } : null;
  })();
}
