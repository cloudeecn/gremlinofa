import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../src/config.js';
import * as db from '../src/db.js';
import { AUTH_FAILURE_LIMIT } from '../src/middleware.js';
import {
  answerAsHuman,
  basicAuth,
  makeCaller,
  startTestServer,
  type CallOptions,
  type TestServer,
} from './helpers.js';

const ALLOWED_ORIGIN = 'https://allowed.example';

let server: TestServer;
let call: (path: string, options?: CallOptions) => Promise<Response>;

async function start(overrides: Parameters<typeof startTestServer>[0] = {}) {
  await server?.close();
  server = await startTestServer({
    pollTimeoutMs: 2000,
    corsOrigins: [ALLOWED_ORIGIN],
    ...overrides,
  });
  call = makeCaller(server.baseUrl);
}

beforeEach(async () => {
  db.initDatabase(':memory:');
  await start();
});

afterEach(async () => {
  await server.close();
});

async function createSession(displayName?: unknown): Promise<string> {
  const res = await call('/api/sessions', {
    method: 'POST',
    body: displayName === undefined ? {} : { displayName },
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { sessionId: string }).sessionId;
}

interface SessionBody {
  messages: Array<{ content: string }>;
  pendingRequest: { requestId: string; expiresAt: string | null } | null;
}

interface PostedMessage {
  requestId: string;
  messageId: string;
  expiresAt: string | null;
}

async function postMessage(sessionId: string, body: Record<string, unknown> = {}) {
  const res = await call(`/api/sessions/${sessionId}/message`, {
    method: 'POST',
    body: { content: 'What now?', ...body },
  });
  expect(res.status).toBe(201);
  return (await res.json()) as PostedMessage;
}

/** An async note: `awaitReply: false`, so no request comes back. */
async function postNote(sessionId: string, content: string) {
  const res = await call(`/api/sessions/${sessionId}/message`, {
    method: 'POST',
    body: { content, awaitReply: false },
  });
  expect(res.status).toBe(201);
  return res.json();
}

function poll(requestId: string, waitMs?: number, signal?: AbortSignal) {
  const query = waitMs === undefined ? '' : `?waitMs=${waitMs}`;
  return call(`/api/requests/${requestId}/poll${query}`, { signal });
}

async function waitUntilHeld(requestId: string, count = 1) {
  await vi.waitFor(() => expect(server.polls.countWaiters(requestId)).toBe(count), {
    timeout: 2000,
  });
}

describe('health', () => {
  it('needs no credentials', async () => {
    const res = await call('/health', { auth: null });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });
});

describe('auth', () => {
  it.each([
    ['missing header', null],
    ['wrong password', basicAuth('caller', 'nope')],
    ['empty caller id', basicAuth('', config.apiPassword)],
    ['no colon', 'Basic ' + Buffer.from('justtext').toString('base64')],
    ['bearer scheme', 'Bearer abc'],
  ])('rejects %s with a JSON 401', async (_label, auth) => {
    const res = await call('/api/sessions', { method: 'POST', body: {}, auth });
    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    expect(await res.json()).toHaveProperty('error');
  });

  it('decodes UTF-8 passwords', async () => {
    const password = 'pässwörd-✓-草';
    await start({ apiPassword: password });
    const res = await call('/api/sessions', {
      method: 'POST',
      body: {},
      auth: basicAuth('caller', password),
    });
    expect(res.status).toBe(201);
  });

  it('accepts a lowercase scheme and records the caller id', async () => {
    const auth = basicAuth('my-gremlin', config.apiPassword).replace('Basic', 'basic');
    const res = await call('/api/sessions', { method: 'POST', body: {}, auth });
    expect(res.status).toBe(201);
    const { sessionId } = (await res.json()) as { sessionId: string };
    expect(db.getSession(sessionId)?.callerId).toBe('my-gremlin');
  });

  it('checks credentials before reading the body', async () => {
    const res = await call('/api/sessions', { method: 'POST', body: '{not json', auth: null });
    expect(res.status).toBe(401);
  });

  it('refuses a client that sent too many wrong passwords, even with the right one', async () => {
    const wrong = basicAuth('caller', 'nope');
    for (let attempt = 0; attempt < AUTH_FAILURE_LIMIT; attempt++) {
      expect((await call('/api/sessions', { method: 'POST', body: {}, auth: wrong })).status).toBe(
        401
      );
    }
    const locked = await call('/api/sessions', {
      method: 'POST',
      body: {},
      headers: { Origin: ALLOWED_ORIGIN },
    });
    expect(locked.status).toBe(429);
    expect(Number(locked.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(locked.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN);
    expect(((await locked.json()) as { error: string }).error).toMatch(/wrong API passwords/);
  });

  it('counts only 401s toward the cap', async () => {
    for (let attempt = 0; attempt <= AUTH_FAILURE_LIMIT; attempt++) {
      expect((await call('/api/sessions/00ff')).status).toBe(404);
    }
    const wrong = await call('/api/sessions', {
      method: 'POST',
      body: {},
      auth: basicAuth('caller', 'nope'),
    });
    expect(wrong.status).toBe(401);
  });
});

describe('CORS', () => {
  it('answers an allowed preflight with 204 and CORS headers, without credentials', async () => {
    const res = await call('/api/sessions', {
      method: 'OPTIONS',
      auth: null,
      headers: {
        Origin: ALLOWED_ORIGIN,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization, content-type',
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN);
    expect(res.headers.get('access-control-allow-methods')).toContain('POST');
    expect(res.headers.get('access-control-allow-headers')).toMatch(/authorization/i);
    expect(res.headers.get('access-control-max-age')).toBe('600');
    expect(res.headers.get('access-control-allow-credentials')).toBeNull();
    expect(res.headers.get('vary')).toMatch(/origin/i);
  });

  it('answers a disallowed preflight with a bare 204', async () => {
    const res = await call('/api/sessions', {
      method: 'OPTIONS',
      auth: null,
      headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(res.headers.get('vary')).toMatch(/origin/i);
  });

  it('answers preflights with a bare 204 when CORS_ORIGIN is empty', async () => {
    await start({ corsOrigins: null });
    const res = await call('/api/requests/abc/poll', {
      method: 'OPTIONS',
      auth: null,
      headers: { Origin: ALLOWED_ORIGIN, 'Access-Control-Request-Method': 'GET' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('allows any origin with *', async () => {
    await start({ corsOrigins: '*' });
    const res = await call('/api/sessions', {
      method: 'OPTIONS',
      auth: null,
      headers: { Origin: 'https://anywhere.example', 'Access-Control-Request-Method': 'POST' },
    });
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('lets an allowed origin read a 401', async () => {
    const res = await call('/api/sessions', {
      method: 'POST',
      body: {},
      auth: null,
      headers: { Origin: ALLOWED_ORIGIN },
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN);
  });
});

describe('error responses', () => {
  it('returns 400 JSON for malformed JSON', async () => {
    const res = await call('/api/sessions', { method: 'POST', body: '{"displayName": ' });
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/JSON/);
    expect(JSON.stringify(body)).not.toMatch(/at .*\.js/);
  });

  it('returns 413 JSON for a body over 10 MB', async () => {
    const sessionId = await createSession();
    const res = await call(`/api/sessions/${sessionId}/message`, {
      method: 'POST',
      body: { content: 'x'.repeat(10 * 1024 * 1024 + 1) },
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: expect.stringMatching(/10 MB/) });
  });

  it('returns 400 for a JSON array body', async () => {
    const res = await call('/api/sessions', { method: 'POST', body: [] });
    expect(res.status).toBe(400);
  });

  it.each(['/api/sessions/%E0%A4%A', '/api/requests/%ZZ/poll'])(
    'returns 400 JSON for a malformed escape in %s without logging a server fault',
    async path => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const res = await call(path);
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: 'Bad Request' });
        expect(consoleError).not.toHaveBeenCalled();
      } finally {
        consoleError.mockRestore();
      }
    }
  );

  it('returns 404 JSON for unknown /api paths', async () => {
    const res = await call('/api/nope');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });
});

describe('POST /sessions displayName', () => {
  it.each([
    ['omitted', undefined, null],
    ['null', null, null],
    ['trimmed', '  Approver  ', 'Approver'],
    ['whitespace-only', '   ', null],
    ['exactly 200 chars', 'a'.repeat(200), 'a'.repeat(200)],
  ])('accepts %s', async (_label, displayName, stored) => {
    const sessionId = await createSession(displayName);
    const res = await call(`/api/sessions/${sessionId}`);
    const body = (await res.json()) as { session: { displayName: string | null } };
    expect(body.session.displayName).toBe(stored);
  });

  it.each([
    ['a number', 42],
    ['an object', { name: 'x' }],
    ['201 chars', 'a'.repeat(201)],
  ])('rejects %s', async (_label, displayName) => {
    const res = await call('/api/sessions', { method: 'POST', body: { displayName } });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: expect.stringContaining('displayName') });
  });
});

describe('POST /sessions/:id/message validation', () => {
  let sessionId: string;
  beforeEach(async () => {
    sessionId = await createSession();
  });

  it.each([
    ['missing content', {}],
    ['non-string content', { content: 5 }],
    ['whitespace content without files', { content: '  \n' }],
    ['empty content with empty files', { content: '', files: [] }],
    ['files not an array', { content: 'x', files: { path: 'a', content: 'b' } }],
    ['files null', { content: 'x', files: null }],
    ['a file that is not an object', { content: 'x', files: ['a.txt'] }],
    ['a file without path', { content: 'x', files: [{ content: 'b' }] }],
    ['a file with an empty path', { content: 'x', files: [{ path: ' ', content: 'b' }] }],
    ['a file with non-string content', { content: 'x', files: [{ path: 'a', content: 1 }] }],
    [
      'a file with an unknown placement',
      { content: 'x', files: [{ path: 'a', content: 'b', placement: 'middle' }] },
    ],
    [
      'more than 200 files',
      {
        content: 'x',
        files: Array.from({ length: 201 }, (_, i) => ({ path: `${i}`, content: '' })),
      },
    ],
    ['timeoutMs below 1000', { content: 'x', timeoutMs: 999 }],
    ['fractional timeoutMs', { content: 'x', timeoutMs: 1500.5 }],
    ['string timeoutMs', { content: 'x', timeoutMs: '5000' }],
    ['timeoutMs above 7 days', { content: 'x', timeoutMs: 604800001 }],
    [
      'a file with non-boolean lineNumbers',
      { content: 'x', files: [{ path: 'a', content: 'b', lineNumbers: 'yes' }] },
    ],
    ['non-boolean awaitReply', { content: 'x', awaitReply: 'false' }],
    ['timeoutMs with awaitReply false', { content: 'x', awaitReply: false, timeoutMs: 5000 }],
  ])('rejects %s', async (_label, body) => {
    const res = await call(`/api/sessions/${sessionId}/message`, { method: 'POST', body });
    expect(res.status).toBe(400);
    expect(await res.json()).toHaveProperty('error');
  });

  it('accepts empty content when files are attached and returns files parsed', async () => {
    await postMessage(sessionId, {
      content: '',
      files: [
        { path: 'notes.md', content: '# hi' },
        { path: 'tail.md', content: '     1\tbye', placement: 'after', lineNumbers: true },
        { path: 'plain.md', content: 'x', lineNumbers: false },
      ],
    });
    const res = await call(`/api/sessions/${sessionId}`);
    const body = (await res.json()) as { messages: Array<{ content: string; files: unknown }> };
    expect(body.messages[0].content).toBe('');
    expect(body.messages[0].files).toEqual([
      { path: 'notes.md', content: '# hi', placement: 'before' },
      { path: 'tail.md', content: '     1\tbye', placement: 'after', lineNumbers: true },
      { path: 'plain.md', content: 'x', placement: 'before' },
    ]);
  });

  it('sets expiresAt from timeoutMs, or null without one', async () => {
    const before = Date.now();
    const timed = await postMessage(sessionId, { timeoutMs: 60000 });
    const expiresMs = Date.parse(timed.expiresAt!);
    expect(expiresMs).toBeGreaterThanOrEqual(before + 60000);
    expect(expiresMs).toBeLessThan(Date.now() + 60000 + 1000);

    const untimed = await postMessage(sessionId);
    expect(untimed.expiresAt).toBeNull();
  });

  it('returns 404 for an unknown session', async () => {
    const res = await call('/api/sessions/missing/message', {
      method: 'POST',
      body: { content: 'hello?' },
    });
    expect(res.status).toBe(404);
  });
});

describe('GET /sessions/:id', () => {
  it('returns session, messages and the pending request', async () => {
    const sessionId = await createSession('Reviewer');
    const { requestId, expiresAt } = await postMessage(sessionId, { timeoutMs: 60000 });

    const res = await call(`/api/sessions/${sessionId}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      session: expect.objectContaining({ id: sessionId, displayName: 'Reviewer' }),
      messages: [
        expect.objectContaining({
          role: 'ai',
          content: 'What now?',
          files: null,
          awaitsReply: true,
        }),
      ],
      pendingRequest: { requestId, expiresAt },
    });

    answerAsHuman(server.polls, sessionId, requestId, 'Ship it');
    const after = (await (await call(`/api/sessions/${sessionId}`)).json()) as SessionBody;
    expect(after.pendingRequest).toBeNull();
    expect(after.messages.map(m => m.content)).toEqual(['What now?', 'Ship it']);
  });

  it('returns 404 for an unknown session', async () => {
    expect((await call('/api/sessions/missing')).status).toBe(404);
  });
});

describe('async notes (awaitReply: false)', () => {
  it('stores the message without opening a request', async () => {
    const sessionId = await createSession();
    const posted = await postNote(sessionId, 'FYI: halfway');
    expect(posted).toEqual({ requestId: null, messageId: expect.any(String), expiresAt: null });

    const body = (await (await call(`/api/sessions/${sessionId}`)).json()) as {
      messages: Array<{ content: string; awaitsReply: boolean }>;
      pendingRequest: unknown;
    };
    expect(body.pendingRequest).toBeNull();
    expect(body.messages).toEqual([
      expect.objectContaining({ content: 'FYI: halfway', awaitsReply: false }),
    ]);
  });

  it('supersedes a pending question and wakes its poll', async () => {
    const sessionId = await createSession();
    const { requestId } = await postMessage(sessionId);
    const held = poll(requestId, 5000);
    await waitUntilHeld(requestId);

    await postNote(sessionId, 'Never mind, sorted it');
    expect(await (await held).json()).toEqual({ status: 'expired', reason: 'superseded' });
  });

  it('accepts an explicit awaitReply: true as a normal question', async () => {
    const sessionId = await createSession();
    const { requestId } = await postMessage(sessionId, { awaitReply: true });
    expect(typeof requestId).toBe('string');
  });
});

describe('long-poll', () => {
  it('returns 404 for an unknown request', async () => {
    expect((await poll('missing')).status).toBe(404);
  });

  it.each(['-1', 'abc', '1.5'])('rejects waitMs=%s', async waitMs => {
    const sessionId = await createSession();
    const { requestId } = await postMessage(sessionId);
    const res = await call(`/api/requests/${requestId}/poll?waitMs=${waitMs}`);
    expect(res.status).toBe(400);
  });

  it('wakes when the human answers', async () => {
    const sessionId = await createSession();
    const { requestId } = await postMessage(sessionId);

    const pending = poll(requestId, 5000);
    await waitUntilHeld(requestId);
    expect(answerAsHuman(server.polls, sessionId, requestId, 'Done').answered).toBe(true);

    const res = await pending;
    expect(await res.json()).toEqual({ status: 'answered', response: { content: 'Done' } });
    expect(server.polls.countWaiters(requestId)).toBe(0);
  });

  it('answers immediately once the request is answered', async () => {
    const sessionId = await createSession();
    const { requestId } = await postMessage(sessionId);
    answerAsHuman(server.polls, sessionId, requestId, 'Already done');

    const res = await poll(requestId, 5000);
    expect(await res.json()).toEqual({ status: 'answered', response: { content: 'Already done' } });
  });

  it('wakes every concurrent poll on the same request', async () => {
    const sessionId = await createSession();
    const { requestId } = await postMessage(sessionId);

    const first = poll(requestId, 5000);
    const second = poll(requestId, 5000);
    await waitUntilHeld(requestId, 2);
    answerAsHuman(server.polls, sessionId, requestId, 'Both of you');

    for (const res of await Promise.all([first, second])) {
      expect(await res.json()).toEqual({
        status: 'answered',
        response: { content: 'Both of you' },
      });
    }
  });

  it('wakes the old poll as expired/superseded when a new message arrives', async () => {
    const sessionId = await createSession();
    const { requestId: oldRequestId } = await postMessage(sessionId);

    const oldPoll = poll(oldRequestId, 5000);
    await waitUntilHeld(oldRequestId);
    const { requestId: newRequestId } = await postMessage(sessionId, { content: 'Never mind' });

    expect(await (await oldPoll).json()).toEqual({ status: 'expired', reason: 'superseded' });
    expect(newRequestId).not.toBe(oldRequestId);
    expect(answerAsHuman(server.polls, sessionId, oldRequestId, 'late').answered).toBe(false);
  });

  it('expires at expiresAt and reports expired/timeout', async () => {
    await start({ pollTimeoutMs: 5000 });
    const sessionId = await createSession();
    const { requestId } = await postMessage(sessionId, { timeoutMs: 1000 });

    const startedAt = Date.now();
    const res = await poll(requestId, 5000);
    const elapsed = Date.now() - startedAt;

    expect(await res.json()).toEqual({ status: 'expired', reason: 'timeout' });
    expect(elapsed).toBeGreaterThanOrEqual(800);
    expect(elapsed).toBeLessThan(2500);

    const session = (await (await call(`/api/sessions/${sessionId}`)).json()) as SessionBody;
    expect(session.pendingRequest).toBeNull();
    const late = answerAsHuman(server.polls, sessionId, requestId, 'too late');
    expect(late).toEqual({
      answered: false,
      request: expect.objectContaining({ status: 'expired', expireReason: 'timeout' }),
    });
  });

  it('clamps waitMs to POLL_TIMEOUT_MS and reports pending', async () => {
    await start({ pollTimeoutMs: 1000 });
    const sessionId = await createSession();
    const { requestId } = await postMessage(sessionId);

    const startedAt = Date.now();
    const res = await poll(requestId, 60000);
    const elapsed = Date.now() - startedAt;

    expect(await res.json()).toEqual({ status: 'pending', expiresAt: null });
    expect(elapsed).toBeGreaterThanOrEqual(900);
    expect(elapsed).toBeLessThan(2500);
  });

  it('honors a shorter waitMs and returns at once for waitMs=0', async () => {
    const sessionId = await createSession();
    const { requestId, expiresAt } = await postMessage(sessionId, { timeoutMs: 60000 });

    let startedAt = Date.now();
    expect(await (await poll(requestId, 0)).json()).toEqual({ status: 'pending', expiresAt });
    expect(Date.now() - startedAt).toBeLessThan(500);

    startedAt = Date.now();
    expect(await (await poll(requestId, 300)).json()).toEqual({ status: 'pending', expiresAt });
    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeGreaterThanOrEqual(250);
    expect(elapsed).toBeLessThan(1500);
  });

  it('returns 404 when the session is deleted mid-wait', async () => {
    const sessionId = await createSession();
    const { requestId } = await postMessage(sessionId);

    const pending = poll(requestId, 5000);
    await waitUntilHeld(requestId);
    const del = await call(`/api/sessions/${sessionId}`, { method: 'DELETE' });
    expect(await del.json()).toEqual({ deleted: true });

    const res = await pending;
    expect(res.status).toBe(404);
    expect(await res.json()).toHaveProperty('error');
  });

  it('drops the waiter when the client disconnects', async () => {
    const sessionId = await createSession();
    const { requestId } = await postMessage(sessionId);

    const controller = new AbortController();
    const pending = poll(requestId, 5000, controller.signal).catch((err: Error) => err);
    await waitUntilHeld(requestId);
    controller.abort();

    expect(await pending).toBeInstanceOf(Error);
    await waitUntilHeld(requestId, 0);
    // The request itself is untouched and still answerable.
    expect(answerAsHuman(server.polls, sessionId, requestId, 'still here').answered).toBe(true);
  });
});

describe('POST /requests/:id/cancel', () => {
  it('expires the request, wakes polls and returns the final state', async () => {
    const sessionId = await createSession();
    const { requestId } = await postMessage(sessionId);

    const pending = poll(requestId, 5000);
    await waitUntilHeld(requestId);
    const res = await call(`/api/requests/${requestId}/cancel`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'expired', reason: 'cancelled' });
    expect(await (await pending).json()).toEqual({ status: 'expired', reason: 'cancelled' });

    expect(answerAsHuman(server.polls, sessionId, requestId, 'late').answered).toBe(false);
  });

  it('is idempotent', async () => {
    const sessionId = await createSession();
    const { requestId } = await postMessage(sessionId);
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await call(`/api/requests/${requestId}/cancel`, { method: 'POST' });
      expect(await res.json()).toEqual({ status: 'expired', reason: 'cancelled' });
    }
  });

  it('returns the answer when the human answered first', async () => {
    const sessionId = await createSession();
    const { requestId } = await postMessage(sessionId);
    answerAsHuman(server.polls, sessionId, requestId, 'Got it in just in time');

    const res = await call(`/api/requests/${requestId}/cancel`, { method: 'POST' });
    expect(await res.json()).toEqual({
      status: 'answered',
      response: { content: 'Got it in just in time' },
    });
  });

  it('keeps a superseded reason instead of overwriting it', async () => {
    const sessionId = await createSession();
    const { requestId } = await postMessage(sessionId);
    await postMessage(sessionId, { content: 'replacement' });

    const res = await call(`/api/requests/${requestId}/cancel`, { method: 'POST' });
    expect(await res.json()).toEqual({ status: 'expired', reason: 'superseded' });
  });

  it('returns 404 for an unknown request', async () => {
    expect((await call('/api/requests/missing/cancel', { method: 'POST' })).status).toBe(404);
  });
});

describe('DELETE /sessions/:id', () => {
  it('deletes and then 404s', async () => {
    const sessionId = await createSession();
    expect((await call(`/api/sessions/${sessionId}`, { method: 'DELETE' })).status).toBe(200);
    expect((await call(`/api/sessions/${sessionId}`, { method: 'DELETE' })).status).toBe(404);
    expect((await call(`/api/sessions/${sessionId}`)).status).toBe(404);
  });
});
