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
  SessionScope,
  User,
  UserStats,
  UserStatsReport,
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

type ColumnList = ReadonlyArray<readonly [name: string, declaration: string]>;

/** Columns added to `requests` after v1 shipped, in the order they were introduced. */
const REQUEST_COLUMNS_SINCE_V2: ColumnList = [
  ['expiresAt', 'TEXT'],
  ['expireReason', `TEXT CHECK(expireReason IN ('timeout', 'cancelled', 'superseded'))`],
  ['expiredAt', 'TEXT'],
];

/** SET NULL hands a deleted user's sessions to the admin instead of deleting them. */
const SESSION_COLUMNS_SINCE_V2_2: ColumnList = [
  ['userToken', 'TEXT REFERENCES users(token) ON DELETE SET NULL'],
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

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      passwordHash TEXT NOT NULL,
      token TEXT NOT NULL UNIQUE,
      createdAt TEXT NOT NULL
    );
  `);

  // Fresh databases get the later columns the same way old ones do, so each has one definition.
  const addedRequestColumns = database.transaction(() => {
    const added = addMissingColumns(database, 'requests', REQUEST_COLUMNS_SINCE_V2);
    backfillV1Requests(database, new Set(added));
    return added;
  })();
  if (upgrading && addedRequestColumns.length > 0) {
    console.debug('Upgraded requests table, added columns', addedRequestColumns);
  }
  const addedSessionColumns = database.transaction(() =>
    addMissingColumns(database, 'sessions', SESSION_COLUMNS_SINCE_V2_2)
  )();
  if (upgrading && addedSessionColumns.length > 0) {
    console.debug('Upgraded sessions table, added columns', addedSessionColumns);
  }

  // idx_requests_message serves the messages -> requests cascade. Without it, deleting a session
  // scans all of requests once per deleted message, which makes the retention sweep quadratic.
  // idx_sessions_user serves a user's session list and the SET NULL a user delete runs.
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_requests_pending ON requests(status, sessionId);
    CREATE INDEX IF NOT EXISTS idx_requests_session ON requests(sessionId, createdAt);
    CREATE INDEX IF NOT EXISTS idx_requests_message ON requests(messageId);
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(userToken, lastActivityAt);
  `);
}

/** Adds the columns a table lacks, in list order. Returns the added column names. */
function addMissingColumns(
  database: Database.Database,
  table: 'requests' | 'sessions',
  columns: ColumnList
): string[] {
  const existing = new Set(
    (database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
      column => column.name
    )
  );
  const missing = columns.filter(([name]) => !existing.has(name));
  for (const [name, declaration] of missing) {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${declaration}`);
  }
  return missing.map(([name]) => name);
}

/** Fills the v2 request columns that `added` says were just created on a v1 table. */
function backfillV1Requests(database: Database.Database, added: ReadonlySet<string>): void {
  if (added.has('expiresAt')) {
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
  if (added.has('expireReason')) {
    // v1 expired requests only by superseding them, and stamped that moment into answeredAt.
    database
      .prepare(
        `UPDATE requests SET expireReason = 'superseded', expiredAt = answeredAt, answeredAt = NULL
         WHERE status = 'expired'`
      )
      .run();
  }
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

/**
 * A `userToken` that matches no user throws a foreign key error, so callers check it first with
 * `userTokenExists`.
 */
export function createSession(
  id: string,
  callerId: string,
  displayName: string | null,
  userToken: string | null = null
): Session {
  const now = new Date().toISOString();
  const session: Session = {
    id,
    callerId,
    displayName,
    userToken,
    createdAt: now,
    lastActivityAt: now,
  };
  conn()
    .prepare(
      `INSERT INTO sessions (id, callerId, displayName, userToken, createdAt, lastActivityAt)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      session.id,
      session.callerId,
      session.displayName,
      session.userToken,
      session.createdAt,
      session.lastActivityAt
    );
  return session;
}

export function getSession(id: string): Session | undefined {
  return conn().prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Session | undefined;
}

interface SessionListRow extends Session {
  ownerUsername: string | null;
  pendingRequestId: string | null;
  pendingExpiresAt: string | null;
  pendingSince: string | null;
}

const SESSION_LIST_SELECT = `
  SELECT s.*, u.username AS ownerUsername, r.id AS pendingRequestId,
         r.expiresAt AS pendingExpiresAt, r.createdAt AS pendingSince
  FROM sessions s
  LEFT JOIN users u ON u.token = s.userToken
  LEFT JOIN requests r ON r.sessionId = s.id AND r.status = 'pending'`;
const SESSION_LIST_ORDER = 'ORDER BY s.lastActivityAt DESC, s.rowid DESC';

/**
 * The sessions `scope` may see, most recently active first, each with its owner's name and its
 * pending request (if any). A user's scope is its own statement so idx_sessions_user applies.
 */
export function listSessionsWithPending(scope: SessionScope): SessionListEntry[] {
  const database = conn();
  expireOverdueRequests(database, new Date().toISOString());
  const rows = (
    scope.kind === 'all'
      ? database.prepare(`${SESSION_LIST_SELECT} ${SESSION_LIST_ORDER}`).all()
      : database
          .prepare(`${SESSION_LIST_SELECT} WHERE s.userToken = ? ${SESSION_LIST_ORDER}`)
          .all(scope.token)
  ) as SessionListRow[];

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

// ── Users ──

export interface CreateUserInput {
  id: string;
  username: string;
  passwordHash: string;
  token: string;
}

/** Returns null when the username is taken in any letter case. */
export function createUser(input: CreateUserInput): User | null {
  const database = conn();
  return database.transaction((): User | null => {
    if (getUserByUsername(input.username)) {
      return null;
    }
    const user: User = {
      id: input.id,
      username: input.username,
      passwordHash: input.passwordHash,
      token: input.token,
      createdAt: new Date().toISOString(),
    };
    database
      .prepare(
        `INSERT INTO users (id, username, passwordHash, token, createdAt)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(user.id, user.username, user.passwordHash, user.token, user.createdAt);
    return user;
  })();
}

export function getUserById(id: string): User | undefined {
  return conn().prepare('SELECT * FROM users WHERE id = ?').get(id) as User | undefined;
}

/** Case-insensitive, through the column's NOCASE collation. */
export function getUserByUsername(username: string): User | undefined {
  return conn().prepare('SELECT * FROM users WHERE username = ?').get(username) as User | undefined;
}

export function getUserByToken(token: string): User | undefined {
  return conn().prepare('SELECT * FROM users WHERE token = ?').get(token) as User | undefined;
}

export function userTokenExists(token: string): boolean {
  return conn().prepare('SELECT 1 FROM users WHERE token = ?').get(token) !== undefined;
}

/** Every user, ordered by username regardless of case. */
export function listUsers(): User[] {
  return conn().prepare('SELECT * FROM users ORDER BY username COLLATE NOCASE').all() as User[];
}

/** 'taken' when another user has the name in any letter case; a user may change its own case. */
export function renameUser(id: string, username: string): 'ok' | 'taken' | 'missing' {
  const database = conn();
  return database.transaction((): 'ok' | 'taken' | 'missing' => {
    if (!getUserById(id)) {
      return 'missing';
    }
    const holder = getUserByUsername(username);
    if (holder && holder.id !== id) {
      return 'taken';
    }
    database.prepare('UPDATE users SET username = ? WHERE id = ?').run(username, id);
    return 'ok';
  })();
}

/** Returns false when the user does not exist. */
export function setUserPassword(id: string, passwordHash: string): boolean {
  const { changes } = conn()
    .prepare('UPDATE users SET passwordHash = ? WHERE id = ?')
    .run(passwordHash, id);
  return changes > 0;
}

/**
 * Sets the password only while the stored hash is still `expectedHash`. Returns false when the
 * user is gone or its password changed since the caller read it.
 */
export function setUserPasswordIfUnchanged(
  id: string,
  expectedHash: string,
  passwordHash: string
): boolean {
  const { changes } = conn()
    .prepare('UPDATE users SET passwordHash = ? WHERE id = ? AND passwordHash = ?')
    .run(passwordHash, id, expectedHash);
  return changes > 0;
}

/**
 * Deletes a user. Their sessions stay: the foreign key's SET NULL makes them admin-only, and any
 * long-poll on them keeps waiting, since the requests are untouched.
 */
export function deleteUser(id: string): boolean {
  const { changes } = conn().prepare('DELETE FROM users WHERE id = ?').run(id);
  return changes > 0;
}

interface UserStatsRow extends UserStats {
  token: string | null;
}

const NO_STATS: UserStats = {
  sessions: 0,
  aiMessages: 0,
  humanReplies: 0,
  pending: 0,
  lastActivityAt: null,
};

/** Per-user counts over retained sessions, plus the sessions without a token. */
export function listUserStats(): UserStatsReport {
  const database = conn();
  expireOverdueRequests(database, new Date().toISOString());
  // The messages and requests are aggregated per session before the join, so a session with
  // several of each still counts once.
  const rows = database
    .prepare(
      `SELECT s.userToken AS token, COUNT(*) AS sessions,
              MAX(s.lastActivityAt) AS lastActivityAt,
              COALESCE(SUM(m.ai), 0) AS aiMessages, COALESCE(SUM(m.human), 0) AS humanReplies,
              COALESCE(SUM(p.open), 0) AS pending
       FROM sessions s
       LEFT JOIN (SELECT sessionId, SUM(role = 'ai') AS ai, SUM(role = 'human') AS human
                  FROM messages GROUP BY sessionId) m ON m.sessionId = s.id
       LEFT JOIN (SELECT sessionId, COUNT(*) AS open FROM requests WHERE status = 'pending'
                  GROUP BY sessionId) p ON p.sessionId = s.id
       GROUP BY s.userToken`
    )
    .all() as UserStatsRow[];

  const statsByToken = new Map<string | null, UserStats>(
    rows.map(({ token, ...stats }) => [token, stats])
  );
  return {
    users: listUsers().map(user => ({
      user,
      stats: statsByToken.get(user.token) ?? { ...NO_STATS },
    })),
    noToken: statsByToken.get(null) ?? { ...NO_STATS },
  };
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
    MessageRow | undefined;
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
    RequestRecord | undefined;
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
      RequestRecord | undefined;
    return request ? { request, cancelled: changes > 0 } : null;
  })();
}
