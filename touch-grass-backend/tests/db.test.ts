import { describe, it, expect, beforeEach } from 'vitest';
import * as db from '../src/db.js';

beforeEach(() => {
  // Re-initialize with in-memory DB for each test
  db.initDatabase();
});

describe('sessions', () => {
  it('creates and retrieves a session', () => {
    const session = db.createSession('s1', 'caller1', 'Test Session');
    expect(session.id).toBe('s1');
    expect(session.callerId).toBe('caller1');
    expect(session.displayName).toBe('Test Session');

    const retrieved = db.getSession('s1');
    expect(retrieved).toBeDefined();
    expect(retrieved!.id).toBe('s1');
  });

  it('lists sessions ordered by last activity', () => {
    db.createSession('s1', 'c1', null);
    db.createSession('s2', 'c1', 'Second');

    // Touch s1 via a message so it becomes most recent
    db.addMessage('m1', 's1', 'ai', 'hello', null);

    const sessions = db.listSessions();
    expect(sessions).toHaveLength(2);
    expect(sessions[0].id).toBe('s1');
  });

  it('deletes a session', () => {
    db.createSession('s1', 'c1', null);
    db.deleteSession('s1');
    expect(db.getSession('s1')).toBeUndefined();
  });

  it('cascades deletion to messages and requests', () => {
    db.createSession('s1', 'c1', null);
    db.addMessage('m1', 's1', 'ai', 'hello', null);
    db.createRequest('r1', 's1', 'm1');

    db.deleteSession('s1');

    expect(db.getMessages('s1')).toHaveLength(0);
    expect(db.getRequest('r1')).toBeUndefined();
  });
});

describe('messages', () => {
  it('adds and retrieves messages in order', () => {
    db.createSession('s1', 'c1', null);
    db.addMessage('m1', 's1', 'ai', 'Hi human', '[]');
    db.addMessage('m2', 's1', 'human', 'Hi AI', null);

    const messages = db.getMessages('s1');
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('ai');
    expect(messages[0].content).toBe('Hi human');
    expect(messages[1].role).toBe('human');
    expect(messages[1].content).toBe('Hi AI');
  });

  it('updates session lastActivityAt on message add', () => {
    db.createSession('s1', 'c1', null);
    const before = db.getSession('s1')!.lastActivityAt;

    // Small delay to ensure different timestamp
    db.addMessage('m1', 's1', 'ai', 'hello', null);
    const after = db.getSession('s1')!.lastActivityAt;

    expect(after >= before).toBe(true);
  });
});

describe('requests', () => {
  it('creates a pending request', () => {
    db.createSession('s1', 'c1', null);
    db.addMessage('m1', 's1', 'ai', 'question', null);
    const req = db.createRequest('r1', 's1', 'm1');

    expect(req.status).toBe('pending');
    expect(req.responseMessageId).toBeNull();
  });

  it('finds pending request for session', () => {
    db.createSession('s1', 'c1', null);
    db.addMessage('m1', 's1', 'ai', 'question', null);
    db.createRequest('r1', 's1', 'm1');

    const pending = db.getPendingRequestForSession('s1');
    expect(pending).toBeDefined();
    expect(pending!.id).toBe('r1');
  });

  it('answers a request', () => {
    db.createSession('s1', 'c1', null);
    db.addMessage('m1', 's1', 'ai', 'question', null);
    db.createRequest('r1', 's1', 'm1');

    db.addMessage('m2', 's1', 'human', 'answer', null);
    db.answerRequest('r1', 'm2');

    const req = db.getRequest('r1');
    expect(req!.status).toBe('answered');
    expect(req!.responseMessageId).toBe('m2');
    expect(req!.answeredAt).toBeTruthy();
  });

  it('auto-expires old pending requests when creating new one', () => {
    db.createSession('s1', 'c1', null);
    db.addMessage('m1', 's1', 'ai', 'first', null);
    db.createRequest('r1', 's1', 'm1');

    db.addMessage('m2', 's1', 'ai', 'second', null);
    db.createRequest('r2', 's1', 'm2');

    const old = db.getRequest('r1');
    expect(old!.status).toBe('expired');

    const current = db.getPendingRequestForSession('s1');
    expect(current!.id).toBe('r2');
  });
});
