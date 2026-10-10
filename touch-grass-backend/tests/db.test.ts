import Database from 'better-sqlite3';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as db from '../src/db.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

beforeEach(() => {
  db.initDatabase(':memory:');
});

afterEach(() => {
  vi.useRealTimers();
});

/** Freezes Date only; setTimeout stays real. */
function setNow(iso: string) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(iso));
}

let idCounter = 0;
function post(sessionId: string, content = 'question', timeoutMs: number | null = null) {
  idCounter++;
  const posted = db.postAiMessage({
    sessionId,
    messageId: `m${idCounter}`,
    requestId: `r${idCounter}`,
    content,
    files: [],
    timeoutMs,
  });
  if (!posted) throw new Error(`session ${sessionId} missing`);
  return posted;
}

function answer(sessionId: string, requestId: string, content = 'answer') {
  idCounter++;
  return db.answerRequest({ requestId, sessionId, messageId: `h${idCounter}`, content });
}

describe('sessions', () => {
  it('creates and retrieves a session', () => {
    const session = db.createSession('s1', 'caller1', 'Test Session');
    expect(session).toMatchObject({ id: 's1', callerId: 'caller1', displayName: 'Test Session' });
    expect(db.getSession('s1')).toEqual(session);
  });

  it('lists sessions by last activity with their pending request', () => {
    setNow('2026-01-01T00:00:00.000Z');
    db.createSession('s1', 'c1', null);
    db.createSession('s2', 'c1', 'Second');
    setNow('2026-01-01T00:01:00.000Z');
    const { request } = post('s1', 'hello', 60000);

    const sessions = db.listSessionsWithPending();
    expect(sessions.map(s => s.id)).toEqual(['s1', 's2']);
    expect(sessions[0].pending).toEqual({
      requestId: request.id,
      expiresAt: '2026-01-01T00:02:00.000Z',
      since: '2026-01-01T00:01:00.000Z',
    });
    expect(sessions[1].pending).toBeNull();
  });

  it('deletes a session and returns the request ids it removed', () => {
    db.createSession('s1', 'c1', null);
    const first = post('s1');
    const second = post('s1');

    expect(db.deleteSession('s1')).toEqual([first.request.id, second.request.id]);
    expect(db.getSession('s1')).toBeUndefined();
    expect(db.getMessages('s1')).toHaveLength(0);
    expect(db.getRequest(first.request.id)).toBeUndefined();
    expect(db.deleteSession('s1')).toBeNull();
  });
});

describe('messages', () => {
  it('keeps insertion order when timestamps tie', () => {
    setNow('2026-01-01T00:00:00.000Z');
    db.createSession('s1', 'c1', null);
    const { request } = post('s1', 'first');
    answer('s1', request.id, 'second');
    post('s1', 'third');

    expect(db.getMessages('s1').map(m => m.content)).toEqual(['first', 'second', 'third']);
    expect(db.getMessagesAfter('s1', 1).map(m => m.content)).toEqual(['second', 'third']);
    expect(db.getMessagesAfter('s1', 3)).toEqual([]);
  });

  it('stores files as JSON and returns them parsed', () => {
    db.createSession('s1', 'c1', null);
    const posted = db.postAiMessage({
      sessionId: 's1',
      messageId: 'm-files',
      requestId: 'r-files',
      content: 'Review this',
      files: [
        { path: '/src/main.ts', content: 'console.log("hi")', placement: 'after' },
        { path: '/notes.md', content: '     1\t# hi', placement: 'before', lineNumbers: true },
      ],
      timeoutMs: null,
    });
    expect(posted?.message.files).toHaveLength(2);

    const raw = db
      .getDatabase()
      .prepare('SELECT files FROM messages WHERE id = ?')
      .get('m-files') as { files: string };
    expect(typeof raw.files).toBe('string');
    expect(db.getMessage('m-files')?.files).toEqual([
      { path: '/src/main.ts', content: 'console.log("hi")', placement: 'after' },
      { path: '/notes.md', content: '     1\t# hi', placement: 'before', lineNumbers: true },
    ]);
  });

  it('defaults placement and skips bad entries in legacy rows', () => {
    db.createSession('s1', 'c1', null);
    const insert = db.getDatabase().prepare(
      `INSERT INTO messages (id, sessionId, role, content, files, createdAt)
         VALUES (?, 's1', 'ai', 'x', ?, '2026-01-01T00:00:00.000Z')`
    );
    insert.run('legacy', JSON.stringify([{ path: 'a', content: 'b' }, { path: 3 }]));
    insert.run('broken', '{not json');

    expect(db.getMessage('legacy')?.files).toEqual([
      { path: 'a', content: 'b', placement: 'before' },
    ]);
    expect(db.getMessage('broken')?.files).toBeNull();
    expect(db.getMessage('nope')).toBeUndefined();
  });
});

describe('postAiMessage', () => {
  it('returns null for a missing session', () => {
    expect(
      db.postAiMessage({
        sessionId: 'missing',
        messageId: 'm',
        requestId: 'r',
        content: 'x',
        files: [],
        timeoutMs: null,
      })
    ).toBeNull();
  });

  it('supersedes the previous pending request and reports it', () => {
    db.createSession('s1', 'c1', null);
    const first = post('s1', 'first');
    const second = post('s1', 'second');

    expect(first.supersededRequestIds).toEqual([]);
    expect(second.supersededRequestIds).toEqual([first.request.id]);
    expect(db.getRequest(first.request.id)).toMatchObject({
      status: 'expired',
      expireReason: 'superseded',
    });
    expect(db.getRequest(first.request.id)?.expiredAt).toBeTruthy();
    expect(db.getPendingRequestForSession('s1')?.id).toBe(second.request.id);
  });

  it('expires an overdue request as timeout, not superseded', () => {
    setNow('2026-01-01T00:00:00.000Z');
    db.createSession('s1', 'c1', null);
    const first = post('s1', 'first', 1000);
    setNow('2026-01-01T00:00:05.000Z');
    const second = post('s1', 'second');

    expect(second.supersededRequestIds).toEqual([]);
    expect(db.getRequest(first.request.id)).toMatchObject({
      status: 'expired',
      expireReason: 'timeout',
      expiredAt: '2026-01-01T00:00:01.000Z',
    });
  });

  it('touches the session', () => {
    setNow('2026-01-01T00:00:00.000Z');
    db.createSession('s1', 'c1', null);
    setNow('2026-01-02T00:00:00.000Z');
    post('s1');
    expect(db.getSession('s1')?.lastActivityAt).toBe('2026-01-02T00:00:00.000Z');
  });

  it('posts an async note: no request, but the pending one is superseded', () => {
    setNow('2026-01-01T00:00:00.000Z');
    db.createSession('s1', 'c1', null);
    const question = post('s1', 'question');
    setNow('2026-01-01T00:01:00.000Z');
    const note = db.postAiMessage({
      sessionId: 's1',
      messageId: 'm-note',
      requestId: null,
      content: 'FYI',
      files: [],
      timeoutMs: null,
    });

    expect(note?.request).toBeNull();
    expect(note?.message.awaitsReply).toBe(false);
    expect(note?.supersededRequestIds).toEqual([question.request.id]);
    expect(db.getPendingRequestForSession('s1')).toBeUndefined();
    expect(db.getSession('s1')?.lastActivityAt).toBe('2026-01-01T00:01:00.000Z');
    expect(db.getMessages('s1').map(m => [m.content, m.awaitsReply])).toEqual([
      ['question', true],
      ['FYI', false],
    ]);
  });
});

describe('getLatestMessageForSession', () => {
  it('returns the newest message with awaitsReply', () => {
    setNow('2026-01-01T00:00:00.000Z');
    db.createSession('s1', 'c1', null);
    expect(db.getLatestMessageForSession('s1')).toBeUndefined();

    const { request } = post('s1', 'question');
    expect(db.getLatestMessageForSession('s1')).toMatchObject({
      content: 'question',
      awaitsReply: true,
    });
    answer('s1', request.id, 'reply');
    expect(db.getLatestMessageForSession('s1')).toMatchObject({
      role: 'human',
      content: 'reply',
      awaitsReply: false,
    });
  });
});

describe('lazy expiry', () => {
  it('marks a pending request past expiresAt as expired(timeout) on read', () => {
    setNow('2026-01-01T00:00:00.000Z');
    db.createSession('s1', 'c1', null);
    const { request } = post('s1', 'q', 2000);

    setNow('2026-01-01T00:00:01.999Z');
    expect(db.getRequest(request.id)?.status).toBe('pending');
    expect(db.getPendingRequestForSession('s1')?.id).toBe(request.id);

    setNow('2026-01-01T00:00:02.000Z');
    expect(db.getPendingRequestForSession('s1')).toBeUndefined();
    expect(db.getRequest(request.id)).toMatchObject({
      status: 'expired',
      expireReason: 'timeout',
      expiredAt: '2026-01-01T00:00:02.000Z',
    });
    expect(db.listSessionsWithPending()[0].pending).toBeNull();
    expect(db.getLatestRequestForSession('s1')?.id).toBe(request.id);
  });
});

describe('answerRequest', () => {
  it('records the answer and the message', () => {
    db.createSession('s1', 'c1', null);
    const { request } = post('s1');

    const result = answer('s1', request.id, '4');
    expect(result.answered).toBe(true);
    const stored = db.getRequest(request.id);
    expect(stored).toMatchObject({ status: 'answered' });
    expect(db.getMessage(stored!.responseMessageId!)?.content).toBe('4');
  });

  it('refuses a second answer and reports the state', () => {
    db.createSession('s1', 'c1', null);
    const { request } = post('s1');
    answer('s1', request.id, 'first');

    const second = answer('s1', request.id, 'second');
    expect(second).toEqual({
      answered: false,
      request: expect.objectContaining({ status: 'answered' }),
    });
    expect(db.getMessages('s1').map(m => m.content)).toEqual(['question', 'first']);
  });

  it('refuses an overdue request', () => {
    setNow('2026-01-01T00:00:00.000Z');
    db.createSession('s1', 'c1', null);
    const { request } = post('s1', 'q', 1000);
    setNow('2026-01-01T00:00:01.000Z');

    expect(answer('s1', request.id)).toEqual({
      answered: false,
      request: expect.objectContaining({ status: 'expired', expireReason: 'timeout' }),
    });
  });

  it('refuses a request from another session', () => {
    db.createSession('s1', 'c1', null);
    db.createSession('s2', 'c1', null);
    const { request } = post('s1');

    expect(answer('s2', request.id)).toEqual({ answered: false, request: undefined });
    expect(db.getRequest(request.id)?.status).toBe('pending');
  });
});

describe('cancelRequest', () => {
  it('cancels a pending request once', () => {
    db.createSession('s1', 'c1', null);
    const { request } = post('s1');

    expect(db.cancelRequest(request.id)).toMatchObject({
      cancelled: true,
      request: { status: 'expired', expireReason: 'cancelled' },
    });
    expect(db.cancelRequest(request.id)?.cancelled).toBe(false);
    expect(db.cancelRequest('missing')).toBeNull();
  });

  it('leaves an answered request answered', () => {
    db.createSession('s1', 'c1', null);
    const { request } = post('s1');
    answer('s1', request.id);

    expect(db.cancelRequest(request.id)).toMatchObject({
      cancelled: false,
      request: { status: 'answered' },
    });
  });
});

describe('getLatestRequestForSession', () => {
  it('returns the newest request in any state', () => {
    db.createSession('s1', 'c1', null);
    post('s1');
    const latest = post('s1');
    db.cancelRequest(latest.request.id);

    expect(db.getLatestRequestForSession('s1')).toMatchObject({
      id: latest.request.id,
      expireReason: 'cancelled',
    });
    expect(db.getLatestRequestForSession('nope')).toBeUndefined();
  });
});

describe('sweepOldSessions', () => {
  it('deletes idle sessions but keeps ones with a pending request', () => {
    setNow('2026-01-01T00:00:00.000Z');
    db.createSession('idle', 'c1', null);
    db.createSession('waiting', 'c1', null);
    post('waiting');
    db.createSession('expired-wait', 'c1', null);
    post('expired-wait', 'q', 1000);

    setNow('2026-01-20T00:00:00.000Z');
    db.createSession('recent', 'c1', null);

    setNow(new Date(Date.parse('2026-01-01T00:00:00.000Z') + 31 * DAY_MS).toISOString());
    expect(db.sweepOldSessions(30)).toBe(2);
    expect(db.listSessionsWithPending().map(s => s.id)).toEqual(['recent', 'waiting']);
  });
});

describe('schema', () => {
  const V1_SCHEMA = `
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, callerId TEXT NOT NULL, displayName TEXT,
      createdAt TEXT NOT NULL, lastActivityAt TEXT NOT NULL
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY, sessionId TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('ai', 'human')), content TEXT NOT NULL, files TEXT,
      createdAt TEXT NOT NULL,
      FOREIGN KEY (sessionId) REFERENCES sessions(id) ON DELETE CASCADE
    );
    CREATE TABLE requests (
      id TEXT PRIMARY KEY, sessionId TEXT NOT NULL, messageId TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'answered', 'expired')),
      responseMessageId TEXT, createdAt TEXT NOT NULL, answeredAt TEXT,
      FOREIGN KEY (sessionId) REFERENCES sessions(id) ON DELETE CASCADE,
      FOREIGN KEY (messageId) REFERENCES messages(id) ON DELETE CASCADE
    );
    INSERT INTO sessions VALUES ('s1', 'c1', 'Old', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    INSERT INTO messages VALUES ('m1', 's1', 'ai', 'old q', NULL, '2026-01-01T00:00:00.000Z');
    INSERT INTO messages VALUES ('m2', 's1', 'ai', 'new q', NULL, '2026-01-01T00:01:00.000Z');
    INSERT INTO requests VALUES ('r1', 's1', 'm1', 'expired', NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:01:00.000Z');
    INSERT INTO requests VALUES ('r2', 's1', 'm2', 'pending', NULL, '2026-01-01T00:01:00.000Z', NULL);
  `;

  function requestColumns(database: Database.Database): string[] {
    return (database.prepare('PRAGMA table_info(requests)').all() as Array<{ name: string }>).map(
      column => column.name
    );
  }

  it('indexes every foreign key that a session delete cascades through', () => {
    const plan = (sql: string) =>
      (db.getDatabase().prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>)
        .map(row => row.detail)
        .join('\n');
    // A SCAN here makes the retention sweep cost (deleted messages x all requests).
    expect(plan(`DELETE FROM messages WHERE id = 'x'`)).not.toMatch(/SCAN/);
    expect(plan(`DELETE FROM sessions WHERE id = 'x'`)).not.toMatch(/SCAN/);
  });

  it('reports a migration only when upgrading an existing table', () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const upgradeLogs = () =>
      debug.mock.calls.filter(([message]) => String(message).startsWith('Upgraded requests'));

    const fresh = new Database(':memory:');
    db.applySchema(fresh);
    expect(upgradeLogs()).toHaveLength(0);

    const legacy = new Database(':memory:');
    legacy.exec(V1_SCHEMA);
    db.applySchema(legacy);
    expect(upgradeLogs()).toEqual([
      ['Upgraded requests table, added columns', ['expiresAt', 'expireReason', 'expiredAt']],
    ]);
    debug.mockRestore();
    fresh.close();
    legacy.close();
  });

  it('migrates a v1 requests table in place', () => {
    const legacy = new Database(':memory:');
    legacy.exec(V1_SCHEMA);

    db.applySchema(legacy);

    expect(requestColumns(legacy)).toEqual(
      expect.arrayContaining(['expiresAt', 'expireReason', 'expiredAt'])
    );
    expect(legacy.prepare('SELECT * FROM requests ORDER BY id').all()).toEqual([
      expect.objectContaining({
        id: 'r1',
        status: 'expired',
        expireReason: 'superseded',
        expiredAt: '2026-01-01T00:01:00.000Z',
        answeredAt: null,
      }),
      // v1 had no deadlines; pending rows get an hour from creation.
      expect.objectContaining({
        id: 'r2',
        status: 'pending',
        expiresAt: '2026-01-01T01:01:00.000Z',
        expireReason: null,
      }),
    ]);

    // Running it again is a no-op.
    db.applySchema(legacy);
    expect(requestColumns(legacy).filter(name => name === 'expiresAt')).toHaveLength(1);
    legacy.close();
  });

  describe('on disk', () => {
    let tempDir: string;
    beforeEach(() => {
      tempDir = mkdtempSync(path.join(os.tmpdir(), 'touch-grass-db-'));
    });
    afterEach(() => {
      db.closeDatabase();
      rmSync(tempDir, { recursive: true, force: true });
    });

    it("creates the database's parent directory", () => {
      const dbPath = path.join(tempDir, 'nested', 'data', 'touch-grass.db');
      db.initDatabase(dbPath);
      expect(existsSync(dbPath)).toBe(true);
    });

    function openLegacyFile(): void {
      const dbPath = path.join(tempDir, 'legacy.db');
      const legacy = new Database(dbPath);
      legacy.exec(V1_SCHEMA);
      legacy.close();
      db.initDatabase(dbPath);
    }

    it('migrates an existing v1 file and keeps its data usable', () => {
      openLegacyFile();
      expect(db.getRequest('r1')).toMatchObject({ status: 'expired', expireReason: 'superseded' });
      const next = post('s1');
      expect(answer('s1', next.request.id, 'finally').answered).toBe(true);
    });

    it('closes an orphaned v1 pending request instead of keeping it answerable forever', () => {
      openLegacyFile();
      expect(db.getPendingRequestForSession('s1')).toBeUndefined();
      expect(db.getRequest('r2')).toMatchObject({
        status: 'expired',
        expireReason: 'timeout',
        expiredAt: '2026-01-01T01:01:00.000Z',
      });
      expect(answer('s1', 'r2', 'too late').answered).toBe(false);
      // No longer pinned against retention.
      expect(db.sweepOldSessions(30)).toBe(1);
    });

    it('still lets a v1 client that is waiting across the upgrade get its answer', () => {
      setNow('2026-01-01T00:30:00.000Z');
      openLegacyFile();
      expect(answer('s1', 'r2', 'just in time').answered).toBe(true);
    });
  });
});
