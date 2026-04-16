import { describe, it, expect, beforeEach } from 'vitest';
import * as db from '../src/db.js';
import { notifyResponse } from '../src/pollManager.js';

// Test the API logic through the database and poll manager directly,
// rather than spinning up an HTTP server.

beforeEach(() => {
  db.initDatabase();
});

describe('session lifecycle', () => {
  it('creates a session, sends a message, and receives a response', () => {
    // 1. Create session
    const session = db.createSession('s1', 'test-caller', 'Test');
    expect(session.id).toBe('s1');

    // 2. Send AI message
    const msg = db.addMessage('m1', 's1', 'ai', 'What is 2+2?', null);
    expect(msg.role).toBe('ai');

    // 3. Create pending request
    const req = db.createRequest('r1', 's1', 'm1');
    expect(req.status).toBe('pending');

    // 4. Human responds
    const humanMsg = db.addMessage('m2', 's1', 'human', '4', null);
    db.answerRequest('r1', humanMsg.id);

    // 5. Verify
    const answered = db.getRequest('r1');
    expect(answered!.status).toBe('answered');
    expect(answered!.responseMessageId).toBe('m2');

    const messages = db.getMessages('s1');
    expect(messages).toHaveLength(2);
    expect(messages[0].content).toBe('What is 2+2?');
    expect(messages[1].content).toBe('4');
  });

  it('sends files with AI message', () => {
    db.createSession('s1', 'test-caller', null);

    const files = JSON.stringify([{ path: '/src/main.ts', content: 'console.log("hi")' }]);
    db.addMessage('m1', 's1', 'ai', 'Review this file', files);

    const messages = db.getMessages('s1');
    expect(messages[0].files).toBe(files);

    const parsed = JSON.parse(messages[0].files!);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].path).toBe('/src/main.ts');
  });
});

describe('poll manager', () => {
  it('notifyResponse returns false when no waiter', () => {
    const notified = notifyResponse('nonexistent', 'hello');
    expect(notified).toBe(false);
  });
});

describe('multiple sessions', () => {
  it('handles independent sessions', () => {
    db.createSession('s1', 'caller1', 'Session A');
    db.createSession('s2', 'caller1', 'Session B');

    db.addMessage('m1', 's1', 'ai', 'Q1', null);
    db.addMessage('m2', 's2', 'ai', 'Q2', null);

    db.createRequest('r1', 's1', 'm1');
    db.createRequest('r2', 's2', 'm2');

    // Answer only s1
    db.addMessage('m3', 's1', 'human', 'A1', null);
    db.answerRequest('r1', 'm3');

    // s1 is answered, s2 still pending
    expect(db.getRequest('r1')!.status).toBe('answered');
    expect(db.getRequest('r2')!.status).toBe('pending');

    expect(db.getPendingRequestForSession('s1')).toBeUndefined();
    expect(db.getPendingRequestForSession('s2')).toBeDefined();
  });
});
