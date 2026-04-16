import Database from 'better-sqlite3';
import { config } from './config.js';
import type { Session, SessionMessage, PendingRequest } from './types.js';

let db: Database.Database;

export function initDatabase(): void {
  db = new Database(config.dbPath);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      callerId TEXT NOT NULL,
      displayName TEXT,
      createdAt TEXT NOT NULL,
      lastActivityAt TEXT NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      sessionId TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('ai', 'human')),
      content TEXT NOT NULL,
      files TEXT,
      createdAt TEXT NOT NULL,
      FOREIGN KEY (sessionId) REFERENCES sessions(id) ON DELETE CASCADE
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_messages_session
    ON messages(sessionId, createdAt)
  `);

  db.exec(`
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
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_requests_pending
    ON requests(status, sessionId)
  `);

  // Enable foreign key enforcement
  db.pragma('foreign_keys = ON');

  console.debug('Database initialized:', config.dbPath);
}

export function getDatabase(): Database.Database {
  return db;
}

export function closeDatabase(): void {
  if (db) {
    db.close();
  }
}

// ── Sessions ──

export function createSession(id: string, callerId: string, displayName: string | null): Session {
  const now = new Date().toISOString();
  const session: Session = { id, callerId, displayName, createdAt: now, lastActivityAt: now };
  db.prepare(
    `INSERT INTO sessions (id, callerId, displayName, createdAt, lastActivityAt)
     VALUES (?, ?, ?, ?, ?)`
  ).run(
    session.id,
    session.callerId,
    session.displayName,
    session.createdAt,
    session.lastActivityAt
  );
  return session;
}

export function getSession(id: string): Session | undefined {
  return db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Session | undefined;
}

export function listSessions(): Session[] {
  return db.prepare('SELECT * FROM sessions ORDER BY lastActivityAt DESC').all() as Session[];
}

export function touchSession(id: string): void {
  db.prepare('UPDATE sessions SET lastActivityAt = ? WHERE id = ?').run(
    new Date().toISOString(),
    id
  );
}

export function deleteSession(id: string): void {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
}

// ── Messages ──

export function addMessage(
  id: string,
  sessionId: string,
  role: 'ai' | 'human',
  content: string,
  files: string | null
): SessionMessage {
  const now = new Date().toISOString();
  const msg: SessionMessage = { id, sessionId, role, content, files, createdAt: now };
  db.prepare(
    `INSERT INTO messages (id, sessionId, role, content, files, createdAt)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(msg.id, msg.sessionId, msg.role, msg.content, msg.files, msg.createdAt);
  touchSession(sessionId);
  return msg;
}

export function getMessages(sessionId: string): SessionMessage[] {
  return db
    .prepare('SELECT * FROM messages WHERE sessionId = ? ORDER BY createdAt ASC')
    .all(sessionId) as SessionMessage[];
}

// ── Requests ──

export function createRequest(id: string, sessionId: string, messageId: string): PendingRequest {
  // Auto-expire any existing pending request for this session
  db.prepare(
    `UPDATE requests SET status = 'expired', answeredAt = ? WHERE sessionId = ? AND status = 'pending'`
  ).run(new Date().toISOString(), sessionId);

  const now = new Date().toISOString();
  const req: PendingRequest = {
    id,
    sessionId,
    messageId,
    status: 'pending',
    responseMessageId: null,
    createdAt: now,
    answeredAt: null,
  };
  db.prepare(
    `INSERT INTO requests (id, sessionId, messageId, status, createdAt)
     VALUES (?, ?, ?, ?, ?)`
  ).run(req.id, req.sessionId, req.messageId, req.status, req.createdAt);
  return req;
}

export function getRequest(id: string): PendingRequest | undefined {
  return db.prepare('SELECT * FROM requests WHERE id = ?').get(id) as PendingRequest | undefined;
}

export function getPendingRequestForSession(sessionId: string): PendingRequest | undefined {
  return db
    .prepare(`SELECT * FROM requests WHERE sessionId = ? AND status = 'pending' LIMIT 1`)
    .get(sessionId) as PendingRequest | undefined;
}

export function answerRequest(requestId: string, responseMessageId: string): void {
  db.prepare(
    `UPDATE requests SET status = 'answered', responseMessageId = ?, answeredAt = ? WHERE id = ?`
  ).run(responseMessageId, new Date().toISOString(), requestId);
}
