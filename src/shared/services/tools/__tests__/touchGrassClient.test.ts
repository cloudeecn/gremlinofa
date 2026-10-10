import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ENDPOINT_HINT,
  MAX_POLL_WAIT_MS,
  TOUCH_GRASS_CALLER_ID,
  TouchGrassClient,
  TouchGrassError,
  basicAuthHeader,
  normalizeTouchGrassEndpoint,
  postMessageWithRetry,
  retryCancelInBackground,
  sleep,
  validateTouchGrassEndpoint,
  waitForAnswer,
  withRetry,
} from '../touchGrassClient';

const ENDPOINT = 'http://tg.test:3004';

interface FakeResponseInit {
  status?: number;
  body?: unknown;
  redirected?: boolean;
  url?: string;
}

/** Plain object rather than `Response`: `redirected` / `url` are read-only on the real one. */
function fakeResponse({ status = 200, body = {}, redirected = false, url = '' }: FakeResponseInit) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    redirected,
    url,
    text: () => Promise.resolve(text),
  } as unknown as Response;
}

type FetchHandler = (url: string, init: RequestInit) => Promise<Response>;

function stubFetch(handler: FetchHandler) {
  const fetchMock = vi.fn(handler);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** A fetch that never settles on its own, only rejects when its signal fires. */
function hangUntilAborted(_url: string, init: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    init.signal?.addEventListener('abort', () =>
      reject(new DOMException('The operation was aborted.', 'AbortError'))
    );
  });
}

function client(runtime: 'browser' | 'node' = 'node') {
  return new TouchGrassClient({ endpoint: ENDPOINT, password: 'pw', runtime });
}

function decodeBasic(header: string): string {
  const binary = atob(header.replace(/^Basic /, ''));
  return new TextDecoder().decode(Uint8Array.from(binary, c => c.charCodeAt(0)));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('normalizeTouchGrassEndpoint', () => {
  it.each([
    ['http://h:3004', 'http://h:3004'],
    ['http://h:3004/', 'http://h:3004'],
    ['  http://h:3004///  ', 'http://h:3004'],
    ['http://h:3004/web', 'http://h:3004'],
    ['http://h:3004/web/', 'http://h:3004'],
    ['http://h:3004/api', 'http://h:3004'],
    ['https://h/touch-grass/web/', 'https://h/touch-grass'],
    ['', ''],
  ])('%s -> %s', (raw, expected) => {
    expect(normalizeTouchGrassEndpoint(raw)).toBe(expected);
  });
});

describe('validateTouchGrassEndpoint', () => {
  it('accepts http and https URLs', () => {
    expect(validateTouchGrassEndpoint('http://h:3004')).toBeUndefined();
    expect(validateTouchGrassEndpoint('https://h/prefix')).toBeUndefined();
  });

  it('rejects a host without a scheme and non-URLs', () => {
    expect(validateTouchGrassEndpoint('localhost:3004')).toContain('http://');
    expect(validateTouchGrassEndpoint('not a url')).toContain('not a valid URL');
  });
});

describe('basicAuthHeader', () => {
  it('encodes credentials as UTF-8, which plain btoa cannot', () => {
    const password = 'pässwörd-🔑-密码';
    expect(() => btoa(`u:${password}`)).toThrow();
    const header = basicAuthHeader('gremlinofa', password);
    expect(decodeBasic(header)).toBe(`gremlinofa:${password}`);
  });

  it('sends Latin-1 characters as their UTF-8 bytes', () => {
    const header = basicAuthHeader('u', 'é');
    // "u:" + 0xC3 0xA9 — the bytes the backend's UTF-8 decode expects.
    expect(atob(header.slice('Basic '.length))).toBe('u:\u00c3\u00a9');
  });
});

describe('TouchGrassClient requests', () => {
  it('sends the UTF-8 Basic auth header and a JSON body', async () => {
    const fetchMock = stubFetch(async () =>
      fakeResponse({ status: 201, body: { sessionId: 's1' } })
    );
    const tg = new TouchGrassClient({ endpoint: ENDPOINT, password: 'clé', runtime: 'node' });
    await expect(tg.createSession('Project · minion')).resolves.toBe('s1');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${ENDPOINT}/api/sessions`);
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(decodeBasic(headers.Authorization)).toBe(`${TOUCH_GRASS_CALLER_ID}:clé`);
    expect(headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual({ displayName: 'Project · minion' });
  });

  it('rejects a 2xx body that does not match the contract', async () => {
    stubFetch(async () => fakeResponse({ status: 201, body: {} }));
    const err = await client()
      .createSession(null)
      .catch(e => e);
    expect(err).toBeInstanceOf(TouchGrassError);
    expect(err.kind).toBe('protocol');
    expect(err.message).toContain(ENDPOINT_HINT);
  });

  it('turns a non-JSON 2xx (the /web/ page) into a setup hint', async () => {
    stubFetch(async () => fakeResponse({ status: 200, body: '<!doctype html><html></html>' }));
    const err = await client()
      .createSession(null)
      .catch(e => e);
    expect(err.kind).toBe('protocol');
    expect(err.retryable).toBe(false);
    expect(err.message).toContain("isn't JSON");
    expect(err.message).toContain(ENDPOINT_HINT);
  });

  it('names the redirect target when a redirected request fails', async () => {
    stubFetch(async () =>
      fakeResponse({
        status: 401,
        body: { error: 'Not authenticated' },
        redirected: true,
        url: 'https://tg.test/login',
      })
    );
    const err = await client()
      .createSession(null)
      .catch(e => e);
    expect(err.status).toBe(401);
    expect(err.message).toContain('redirected to https://tg.test/login');
    expect(err.message).toContain('final URL');
  });

  it('points a plain 401 at the password', async () => {
    stubFetch(async () => fakeResponse({ status: 401, body: { error: 'Unauthorized' } }));
    const err = await client()
      .createSession(null)
      .catch(e => e);
    expect(err.message).toContain('HTTP 401 Unauthorized');
    expect(err.message).toContain('Remote Minion Password');
  });

  it.each([
    [502, 'could not reach the Touch Grass backend'],
    [503, 'could not reach the Touch Grass backend'],
    [504, 'could not reach the Touch Grass backend'],
    [413, 'client_max_body_size 10m'],
    [404, ENDPOINT_HINT],
    [405, ENDPOINT_HINT],
  ])('picks the hint for an HTML %s by status', async (status, hint) => {
    stubFetch(async () =>
      fakeResponse({ status, body: '<html><head><title>nginx</title></head></html>' })
    );
    const err = await client()
      .postMessage('s1', { content: 'Q' })
      .catch(e => e);
    expect(err.kind).toBe('http');
    expect(err.message).toContain('(HTML page)');
    expect(err.message).toContain(hint);
    if (hint !== ENDPOINT_HINT) expect(err.message).not.toContain(ENDPOINT_HINT);
  });

  it("leaves the proxy hint off the backend's own 413", async () => {
    stubFetch(async () =>
      fakeResponse({ status: 413, body: { error: 'Request body exceeds 10 MB' } })
    );
    const err = await client()
      .postMessage('s1', { content: 'Q' })
      .catch(e => e);
    expect(err.message).toBe('Sending the message failed: HTTP 413 Request body exceeds 10 MB.');
  });

  it('marks gateway errors retryable and others not', async () => {
    for (const [status, retryable] of [
      [502, true],
      [503, true],
      [504, true],
      [500, false],
      [404, false],
    ] as const) {
      stubFetch(async () => fakeResponse({ status, body: { error: 'x' } }));
      const err = await client()
        .createSession(null)
        .catch(e => e);
      expect(err.status).toBe(status);
      expect(err.retryable).toBe(retryable);
    }
  });

  it('adds the CORS hint to a browser fetch TypeError', async () => {
    stubFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    const err = await client('browser')
      .createSession(null)
      .catch(e => e);
    expect(err.kind).toBe('network');
    expect(err.retryable).toBe(true);
    expect(err.message).toContain('Failed to fetch');
    expect(err.message).toContain(`CORS_ORIGIN=${globalThis.location.origin}`);
  });

  it('calls out mixed content when an HTTPS app targets an http:// endpoint', async () => {
    vi.stubGlobal('location', { protocol: 'https:', origin: 'https://app.test' });
    stubFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    const err = await client('browser')
      .createSession(null)
      .catch(e => e);
    expect(err.message).toContain('mixed content');
  });

  it('appends the Node cause code instead of a browser hint', async () => {
    stubFetch(() =>
      Promise.reject(
        new TypeError('fetch failed', {
          cause: Object.assign(new Error('x'), { code: 'ECONNREFUSED' }),
        })
      )
    );
    const err = await client('node')
      .createSession(null)
      .catch(e => e);
    expect(err.message).toBe('Creating the remote session failed: fetch failed (ECONNREFUSED).');
    expect(err.retryable).toBe(true);
  });

  it('reads the cause code out of a happy-eyeballs AggregateError', async () => {
    const aggregate = new AggregateError([Object.assign(new Error('a'), { code: 'ECONNRESET' })]);
    stubFetch(() => Promise.reject(new TypeError('fetch failed', { cause: aggregate })));
    const err = await client('node')
      .createSession(null)
      .catch(e => e);
    expect(err.message).toContain('(ECONNRESET)');
  });

  it.each([
    'ERR_SSL_WRONG_VERSION_NUMBER',
    'ERR_SSL_PACKET_LENGTH_TOO_LONG',
    'ERR_TLS_CERT_ALTNAME_INVALID',
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'SELF_SIGNED_CERT_IN_CHAIN',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'CERT_HAS_EXPIRED',
  ])('gives the TLS hint for %s and does not retry it', async code => {
    stubFetch(() =>
      Promise.reject(
        new TypeError('fetch failed', { cause: Object.assign(new Error('x'), { code }) })
      )
    );
    const err = await client('node')
      .createSession(null)
      .catch(e => e);
    expect(err.message).toBe(
      `Creating the remote session failed: fetch failed (${code}). TLS handshake failed: if the backend serves plain HTTP, use http://; otherwise check its certificate.`
    );
    expect(err.kind).toBe('network');
    expect(err.retryable).toBe(false);
  });

  it('keeps a TLS failure out of withRetry', async () => {
    const fetchMock = stubFetch(() =>
      Promise.reject(
        new TypeError('fetch failed', {
          cause: Object.assign(new Error('x'), { code: 'ERR_SSL_WRONG_VERSION_NUMBER' }),
        })
      )
    );
    await expect(
      withRetry(() => client('node').createSession(null), {
        maxRetries: 2,
        deadline: Date.now() + 60_000,
      })
    ).rejects.toThrow('TLS handshake failed');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('asks for waitMs and times a hung poll out after waitMs plus grace', async () => {
    vi.useFakeTimers();
    const fetchMock = stubFetch(hangUntilAborted);
    const pending = client()
      .poll('r1', 20_000)
      .catch(e => e);
    expect(fetchMock.mock.calls[0][0]).toBe(`${ENDPOINT}/api/requests/r1/poll?waitMs=20000`);

    await vi.advanceTimersByTimeAsync(29_999);
    await vi.advanceTimersByTimeAsync(1);
    const err = await pending;
    expect(err.kind).toBe('timeout');
    expect(err.retryable).toBe(true);
  });

  it('reports a caller abort as aborted, not as a timeout or network error', async () => {
    stubFetch(hangUntilAborted);
    const controller = new AbortController();
    const pending = client()
      .poll('r1', 30_000, controller.signal)
      .catch(e => e);
    controller.abort();
    const err = await pending;
    expect(err.kind).toBe('aborted');
  });

  it('validates the poll state union', async () => {
    stubFetch(async () =>
      fakeResponse({ body: { status: 'answered', response: { content: 'hi' } } })
    );
    await expect(client().poll('r1', 0)).resolves.toEqual({
      status: 'answered',
      response: { content: 'hi' },
    });

    stubFetch(async () => fakeResponse({ body: { status: 'answered' } }));
    await expect(client().poll('r1', 0)).rejects.toMatchObject({ kind: 'protocol' });

    stubFetch(async () => fakeResponse({ body: { status: 'weird' } }));
    await expect(client().poll('r1', 0)).rejects.toMatchObject({ kind: 'protocol' });
  });
});

describe('which failures provably never reached the backend', () => {
  function nodeFailure(code: string) {
    return () =>
      Promise.reject(
        new TypeError('fetch failed', { cause: Object.assign(new Error('x'), { code }) })
      );
  }

  it.each([
    ['ECONNREFUSED', true],
    ['ENOTFOUND', true],
    ['EAI_AGAIN', true],
    // The connection was up: the backend may have committed before it dropped.
    ['ECONNRESET', false],
    ['UND_ERR_SOCKET', false],
  ])('Node cause %s → unsent=%s', async (code, unsent) => {
    stubFetch(nodeFailure(code));
    const err = await client('node')
      .createSession(null)
      .catch(e => e);
    expect(err.retryable).toBe(true);
    expect(err.unsent).toBe(unsent);
  });

  it('treats a browser "Failed to fetch" as possibly sent', async () => {
    stubFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    const err = await client('browser')
      .createSession(null)
      .catch(e => e);
    expect(err.unsent).toBe(false);
  });

  it.each([
    // nginx also answers 502 when the backend died after reading the request.
    [502, false],
    [503, true],
    [504, false],
  ])('gateway HTTP %s → unsent=%s', async (status, unsent) => {
    stubFetch(async () => fakeResponse({ status, body: 'gateway' }));
    const err = await client()
      .createSession(null)
      .catch(e => e);
    expect(err.unsent).toBe(unsent);
  });

  it('treats a timeout as possibly sent', async () => {
    vi.useFakeTimers();
    stubFetch(hangUntilAborted);
    const pending = client()
      .createSession(null)
      .catch(e => e);
    await vi.advanceTimersByTimeAsync(30_000);
    const err = await pending;
    expect(err.kind).toBe('timeout');
    expect(err.unsent).toBe(false);
  });
});

describe('TouchGrassClient.postMessage', () => {
  it('adds an upload allowance for large bodies to the base 60s timeout', async () => {
    vi.useFakeTimers();
    stubFetch(hangUntilAborted);
    // Just over 10 × 64 KB of JSON: 11 allowance steps on top of 60s.
    const files = [
      { path: '/big', content: 'x'.repeat(10 * 65_536), placement: 'before' as const },
    ];
    let settled = false;
    const pending = client()
      .postMessage('s1', { content: 'Q', files })
      .catch(e => e)
      .finally(() => (settled = true));
    await vi.advanceTimersByTimeAsync(70_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const err = await pending;
    expect(err.kind).toBe('timeout');
    expect(err.message).toContain('71s');
  });

  it('accepts a missing request only for an async note', async () => {
    stubFetch(async () =>
      fakeResponse({ status: 201, body: { requestId: null, messageId: 'm', expiresAt: null } })
    );
    await expect(
      client().postMessage('s1', { content: 'FYI', awaitReply: false })
    ).resolves.toEqual({ requestId: null, expiresAt: null });
    await expect(client().postMessage('s1', { content: 'Q' })).rejects.toMatchObject({
      kind: 'protocol',
    });
  });

  it('returns the request a 2.0 backend opens for a note, so the caller can withdraw it', async () => {
    stubFetch(async () =>
      fakeResponse({ status: 201, body: { requestId: 'r1', messageId: 'm', expiresAt: null } })
    );
    await expect(
      client().postMessage('s1', { content: 'FYI', awaitReply: false })
    ).resolves.toEqual({ requestId: 'r1', expiresAt: null });
  });
});

describe('TouchGrassClient.getSessionTail', () => {
  it('returns the pending request and the newest message', async () => {
    const fetchMock = stubFetch(async () =>
      fakeResponse({
        body: {
          session: { id: 's1' },
          messages: [
            { role: 'ai', content: 'old', files: null },
            { role: 'ai', content: 'Q', files: [{ path: '/a', content: 'a' }], awaitsReply: true },
          ],
          pendingRequest: { requestId: 'r1', expiresAt: '2026-01-01T00:00:00.000Z' },
        },
      })
    );
    await expect(client().getSessionTail('s1')).resolves.toEqual({
      pendingRequest: { requestId: 'r1', expiresAt: '2026-01-01T00:00:00.000Z' },
      lastMessage: { role: 'ai', content: 'Q', fileCount: 1, awaitsReply: true },
    });
    expect(fetchMock.mock.calls[0][0]).toBe(`${ENDPOINT}/api/sessions/s1`);
    expect(fetchMock.mock.calls[0][1].method).toBe('GET');
  });

  it('rejects a body that does not match the contract', async () => {
    stubFetch(async () => fakeResponse({ body: { messages: [] } }));
    await expect(client().getSessionTail('s1')).rejects.toMatchObject({ kind: 'protocol' });
    stubFetch(async () => fakeResponse({ body: { messages: [], pendingRequest: {} } }));
    await expect(client().getSessionTail('s1')).rejects.toMatchObject({ kind: 'protocol' });
  });
});

describe('postMessageWithRetry', () => {
  beforeEach(() => vi.useFakeTimers());

  const QUESTION = {
    content: 'Q',
    files: [{ path: '/a', content: 'a', placement: 'before' as const }],
  };

  function sessionBody(
    messages: Array<{ role: string; content: string; files: unknown; awaitsReply?: boolean }>,
    pendingRequestId: string | null
  ) {
    return {
      session: { id: 's1' },
      messages,
      pendingRequest: pendingRequestId && { requestId: pendingRequestId, expiresAt: null },
    };
  }

  /** Scripted backend: each POST / GET pops the next handler for its method. */
  function script(
    posts: Array<() => Promise<Response>>,
    gets: Array<() => Promise<Response>> = []
  ) {
    return stubFetch(async (_url, init) => {
      const next = (init.method === 'POST' ? posts : gets).shift();
      if (!next) throw new Error(`unexpected ${init.method}`);
      return next();
    });
  }

  const created = (requestId: string) => () =>
    Promise.resolve(
      fakeResponse({ status: 201, body: { requestId, messageId: 'm', expiresAt: null } })
    );
  const dropped = () => Promise.reject(new TypeError('fetch failed'));
  const refused = () =>
    Promise.reject(
      new TypeError('fetch failed', {
        cause: Object.assign(new Error('x'), { code: 'ECONNREFUSED' }),
      })
    );

  function methods(fetchMock: ReturnType<typeof stubFetch>) {
    return fetchMock.mock.calls.map(([, init]) => init.method);
  }

  it('adopts a post that landed although its response was lost', async () => {
    const fetchMock = script(
      [dropped],
      [
        () =>
          Promise.resolve(
            fakeResponse({
              body: sessionBody([{ role: 'ai', content: 'Q', files: QUESTION.files }], 'r1'),
            })
          ),
      ]
    );
    const pending = postMessageWithRetry(client(), 's1', QUESTION, {
      maxRetries: 2,
      deadline: Date.now() + 60_000,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pending).resolves.toEqual({ requestId: 'r1', expiresAt: null });
    expect(methods(fetchMock)).toEqual(['POST', 'GET']);
  });

  describe('for an async note', () => {
    const NOTE = { ...QUESTION, awaitReply: false as const };
    const noteCreated = () =>
      Promise.resolve(
        fakeResponse({ status: 201, body: { requestId: null, messageId: 'm', expiresAt: null } })
      );

    it('sends no timeoutMs', async () => {
      const fetchMock = script([noteCreated]);
      await expect(
        postMessageWithRetry(client(), 's1', NOTE, { maxRetries: 0, deadline: Date.now() + 60_000 })
      ).resolves.toEqual({ requestId: null, expiresAt: null });
      expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toEqual({
        content: 'Q',
        files: QUESTION.files,
        awaitReply: false,
      });
    });

    it('adopts a note that landed although its response was lost', async () => {
      const fetchMock = script(
        [dropped],
        [
          () =>
            Promise.resolve(
              fakeResponse({
                body: sessionBody(
                  [{ role: 'ai', content: 'Q', files: QUESTION.files, awaitsReply: false }],
                  null
                ),
              })
            ),
        ]
      );
      const pending = postMessageWithRetry(client(), 's1', NOTE, {
        maxRetries: 2,
        deadline: Date.now() + 60_000,
      });
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(pending).resolves.toEqual({ requestId: null, expiresAt: null });
      expect(methods(fetchMock)).toEqual(['POST', 'GET']);
    });

    it('posts again when the identical newest message is a closed question', async () => {
      const fetchMock = script(
        [dropped, noteCreated],
        [
          () =>
            Promise.resolve(
              fakeResponse({
                body: sessionBody(
                  [{ role: 'ai', content: 'Q', files: QUESTION.files, awaitsReply: true }],
                  null
                ),
              })
            ),
        ]
      );
      const pending = postMessageWithRetry(client(), 's1', NOTE, {
        maxRetries: 2,
        deadline: Date.now() + 60_000,
      });
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(pending).resolves.toEqual({ requestId: null, expiresAt: null });
      expect(methods(fetchMock)).toEqual(['POST', 'GET', 'POST']);
    });
  });

  it('posts again when the read-back shows only an older question', async () => {
    const fetchMock = script(
      [dropped, created('r2')],
      [
        () =>
          Promise.resolve(
            fakeResponse({
              body: sessionBody([{ role: 'ai', content: 'Earlier', files: null }], 'r0'),
            })
          ),
      ]
    );
    const pending = postMessageWithRetry(client(), 's1', QUESTION, {
      maxRetries: 2,
      deadline: Date.now() + 60_000,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pending).resolves.toMatchObject({ requestId: 'r2' });
    expect(methods(fetchMock)).toEqual(['POST', 'GET', 'POST']);
  });

  it('posts again when the identical newest question is closed: a retry after Stop', async () => {
    const fetchMock = script(
      [dropped, created('r2')],
      [
        () =>
          Promise.resolve(
            fakeResponse({
              body: sessionBody([{ role: 'ai', content: 'Q', files: QUESTION.files }], null),
            })
          ),
      ]
    );
    const pending = postMessageWithRetry(client(), 's1', QUESTION, {
      maxRetries: 2,
      deadline: Date.now() + 60_000,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pending).resolves.toMatchObject({ requestId: 'r2' });
    expect(methods(fetchMock)).toEqual(['POST', 'GET', 'POST']);
  });

  it('never posts again past the deadline when the closed newest question may be ours', async () => {
    const fetchMock = script(
      [dropped],
      [
        () =>
          Promise.resolve(
            fakeResponse({
              body: sessionBody([{ role: 'ai', content: 'Q', files: QUESTION.files }], null),
            })
          ),
      ]
    );
    // The backoff ends exactly at the deadline, so the read-back runs past it.
    const pending = postMessageWithRetry(client(), 's1', QUESTION, {
      maxRetries: 2,
      deadline: Date.now() + 1_000,
    }).catch(e => e);
    await vi.advanceTimersByTimeAsync(1_000);
    const err = await pending;
    expect(err).toBeInstanceOf(TouchGrassError);
    expect(err.retryable).toBe(false);
    expect(err.message).toContain('deadline passed');
    expect(methods(fetchMock)).toEqual(['POST', 'GET']);
  });

  it('throws a read-back 404 at once, for the caller to open a new session', async () => {
    const fetchMock = script(
      [dropped],
      [() => Promise.resolve(fakeResponse({ status: 404, body: { error: 'Session not found' } }))]
    );
    const pending = postMessageWithRetry(client(), 's1', QUESTION, {
      maxRetries: 2,
      deadline: Date.now() + 60_000,
    }).catch(e => e);
    await vi.advanceTimersByTimeAsync(1_000);
    const err = await pending;
    expect(err.status).toBe(404);
    expect(methods(fetchMock)).toEqual(['POST', 'GET']);
  });

  it('reads back after a 502, which may have reached the backend', async () => {
    const fetchMock = script(
      [() => Promise.resolve(fakeResponse({ status: 502, body: '<html>502</html>' }))],
      [
        () =>
          Promise.resolve(
            fakeResponse({
              body: sessionBody([{ role: 'ai', content: 'Q', files: QUESTION.files }], 'r1'),
            })
          ),
      ]
    );
    const pending = postMessageWithRetry(client(), 's1', QUESTION, {
      maxRetries: 2,
      deadline: Date.now() + 60_000,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pending).resolves.toMatchObject({ requestId: 'r1' });
    expect(methods(fetchMock)).toEqual(['POST', 'GET']);
  });

  it('posts again without reading back after a failure that never left', async () => {
    const fetchMock = script([refused, created('r2')]);
    const pending = postMessageWithRetry(client(), 's1', QUESTION, {
      maxRetries: 2,
      deadline: Date.now() + 60_000,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pending).resolves.toMatchObject({ requestId: 'r2' });
    expect(methods(fetchMock)).toEqual(['POST', 'POST']);
  });

  it('keeps reading back while the backend is unreachable, never posting blind', async () => {
    const fetchMock = script(
      [dropped],
      [
        refused,
        () =>
          Promise.resolve(
            fakeResponse({
              body: sessionBody([{ role: 'ai', content: 'Q', files: QUESTION.files }], 'r1'),
            })
          ),
      ]
    );
    const pending = postMessageWithRetry(client(), 's1', QUESTION, {
      maxRetries: 2,
      deadline: Date.now() + 60_000,
    });
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(pending).resolves.toMatchObject({ requestId: 'r1' });
    expect(methods(fetchMock)).toEqual(['POST', 'GET', 'GET']);
  });

  it('asks each attempt to close the question at the deadline', async () => {
    const fetchMock = script([
      () => Promise.resolve(fakeResponse({ status: 503, body: 'down' })),
      created('r2'),
    ]);
    const pending = postMessageWithRetry(client(), 's1', QUESTION, {
      maxRetries: 2,
      deadline: Date.now() + 60_000,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await pending;
    const timeouts = fetchMock.mock.calls.map(
      ([, init]) => JSON.parse(init.body as string).timeoutMs
    );
    expect(timeouts).toEqual([60_000, 59_000]);
  });
});

describe('TouchGrassClient.cancel', () => {
  it('returns the final state, including a human answer that won the race', async () => {
    const fetchMock = stubFetch(async () =>
      fakeResponse({ body: { status: 'answered', response: { content: 'late' } } })
    );
    await expect(client().cancel('r1')).resolves.toEqual({
      reached: true,
      state: { status: 'answered', response: { content: 'late' } },
    });
    expect(fetchMock.mock.calls[0][0]).toBe(`${ENDPOINT}/api/requests/r1/cancel`);
    expect(fetchMock.mock.calls[0][1].method).toBe('POST');
  });

  it('reports a 404 as reached: the request is gone with its session', async () => {
    stubFetch(async () => fakeResponse({ status: 404, body: { error: 'Request not found' } }));
    await expect(client().cancel('r1')).resolves.toEqual({ reached: true, gone: true });
  });

  it.each([
    ['an unreachable backend', () => Promise.reject(new TypeError('fetch failed')), true],
    ['a gateway 502', async () => fakeResponse({ status: 502, body: 'Bad Gateway' }), true],
    ['a 401', async () => fakeResponse({ status: 401, body: { error: 'Unauthorized' } }), false],
    [
      'a body without a final state',
      async () => fakeResponse({ body: { status: 'pending', expiresAt: null } }),
      false,
    ],
  ])('never throws: %s is not reached, retryable=%s', async (_label, handler, retryable) => {
    stubFetch(handler);
    await expect(client().cancel('r1')).resolves.toEqual({ reached: false, retryable });
  });

  it('gives up after its own short timeout, retryably', async () => {
    vi.useFakeTimers();
    stubFetch(hangUntilAborted);
    const pending = client().cancel('r1');
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(pending).resolves.toEqual({ reached: false, retryable: true });
  });
});

describe('retryCancelInBackground', () => {
  beforeEach(() => vi.useFakeTimers());

  const expiredCancelled = () =>
    Promise.resolve(fakeResponse({ body: { status: 'expired', reason: 'cancelled' } }));
  const unreachable = () => Promise.reject(new TypeError('fetch failed'));

  /** A fetch that fails like a down backend for the first `failures` calls, then cancels. */
  function backendBackAfter(failures: number) {
    let calls = 0;
    return stubFetch(() => (++calls <= failures ? unreachable() : expiredCancelled()));
  }

  it('retries an unreachable cancel with backoff until the backend hears it', async () => {
    const fetchMock = backendBackAfter(3);
    const tg = client();
    let done = false;
    void retryCancelInBackground(tg, 'r1', tg.cancel('r1'), Date.now() + 600_000).then(
      () => (done = true)
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(done).toBe(true);
    expect(
      fetchMock.mock.calls.every(([url]) => url === `${ENDPOINT}/api/requests/r1/cancel`)
    ).toBe(true);

    await vi.advanceTimersByTimeAsync(600_000);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('counts a 404 as heard and stops', async () => {
    let calls = 0;
    const fetchMock = stubFetch(() =>
      ++calls === 1
        ? unreachable()
        : Promise.resolve(fakeResponse({ status: 404, body: { error: 'Request not found' } }))
    );
    const tg = client();
    const finished = retryCancelInBackground(tg, 'r1', tg.cancel('r1'), Date.now() + 600_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await finished;
    await vi.advanceTimersByTimeAsync(600_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('stops once the next attempt would land at or past the deadline', async () => {
    const fetchMock = stubFetch(unreachable);
    const tg = client();
    let done = false;
    void retryCancelInBackground(tg, 'r1', tg.cancel('r1'), Date.now() + 10_000).then(
      () => (done = true)
    );
    // Attempts at 0, 1s, 3s and 8s; the next would be at 18s.
    await vi.advanceTimersByTimeAsync(8_000);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(done).toBe(true);
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('sends nothing more when the first attempt got through or cannot be fixed by retrying', async () => {
    const fetchMock = stubFetch(expiredCancelled);
    const tg = client();
    await retryCancelInBackground(tg, 'r1', tg.cancel('r1'), Date.now() + 600_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const unauthorized = stubFetch(async () =>
      fakeResponse({ status: 401, body: { error: 'Unauthorized' } })
    );
    await retryCancelInBackground(tg, 'r1', tg.cancel('r1'), Date.now() + 600_000);
    expect(unauthorized).toHaveBeenCalledTimes(1);
  });

  it("unrefs its backoff timers so they don't hold a Node process open", async () => {
    backendBackAfter(2);
    const unrefDelays: Array<number | undefined> = [];
    const fakeSetTimeout = globalThis.setTimeout;
    const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      handler: () => void,
      ms?: number
    ) => {
      const timer = fakeSetTimeout(handler, ms) as unknown as { unref: () => unknown };
      const unref = timer.unref.bind(timer);
      timer.unref = () => {
        unrefDelays.push(ms);
        return unref();
      };
      return timer;
    }) as unknown as typeof setTimeout);
    try {
      const tg = client();
      const finished = retryCancelInBackground(tg, 'r1', tg.cancel('r1'), Date.now() + 600_000);
      await vi.advanceTimersByTimeAsync(3_000);
      await finished;
      expect(unrefDelays).toEqual([1_000, 2_000]);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('withRetry', () => {
  beforeEach(() => vi.useFakeTimers());

  it('retries transient failures with 1s then 2s backoff, up to maxRetries', async () => {
    const operation = vi.fn(() =>
      Promise.reject(new TouchGrassError('down', 'http', { status: 503, retryable: true }))
    );
    const pending = withRetry(operation, { maxRetries: 2, deadline: Date.now() + 60_000 }).catch(
      e => e
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(operation).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(operation).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(operation).toHaveBeenCalledTimes(3);
    expect((await pending).status).toBe(503);
  });

  it('throws a non-retryable failure at once', async () => {
    const operation = vi.fn(() => Promise.reject(new TouchGrassError('nope', 'http')));
    await expect(
      withRetry(operation, { maxRetries: 5, deadline: Date.now() + 60_000 })
    ).rejects.toThrow('nope');
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('stops retrying when the deadline leaves no room for a backoff', async () => {
    const operation = vi.fn(() =>
      Promise.reject(new TouchGrassError('down', 'network', { retryable: true }))
    );
    await expect(withRetry(operation, { maxRetries: 5, deadline: Date.now() })).rejects.toThrow(
      'down'
    );
    expect(operation).toHaveBeenCalledTimes(1);
  });
});

describe('sleep', () => {
  it('rejects as aborted the moment the signal fires', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const pending = sleep(10_000, controller.signal).catch(e => e);
    controller.abort();
    const err = await pending;
    expect(err).toBeInstanceOf(TouchGrassError);
    expect(err.kind).toBe('aborted');
  });
});

describe('waitForAnswer', () => {
  beforeEach(() => vi.useFakeTimers());

  it('returns the answer', async () => {
    stubFetch(async () =>
      fakeResponse({ body: { status: 'answered', response: { content: 'yes' } } })
    );
    await expect(waitForAnswer(client(), 'r1', { deadline: Date.now() + 60_000 })).resolves.toEqual(
      { status: 'answered', content: 'yes' }
    );
  });

  it('caps each hold at the remaining budget', async () => {
    const holds: number[] = [];
    stubFetch(async url => {
      const waitMs = Number(new URL(url).searchParams.get('waitMs'));
      holds.push(waitMs);
      await new Promise(resolve => setTimeout(resolve, waitMs));
      return fakeResponse({ body: { status: 'pending', expiresAt: null } });
    });
    const pending = waitForAnswer(client(), 'r1', { deadline: Date.now() + 45_000 });
    await vi.advanceTimersByTimeAsync(45_000);
    await expect(pending).resolves.toEqual({ status: 'timeout', lastError: undefined });
    expect(holds).toEqual([MAX_POLL_WAIT_MS, 15_000]);
  });

  it('keeps at least 1s between polls when pending comes back at once', async () => {
    const pollTimes: number[] = [];
    const start = Date.now();
    let polls = 0;
    stubFetch(async () => {
      pollTimes.push(Date.now() - start);
      polls++;
      return fakeResponse({
        body:
          polls < 3
            ? { status: 'pending', expiresAt: null }
            : { status: 'answered', response: { content: 'ok' } },
      });
    });
    const pending = waitForAnswer(client(), 'r1', { deadline: start + 60_000 });
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(pending).resolves.toEqual({ status: 'answered', content: 'ok' });
    expect(pollTimes).toEqual([0, 1_000, 2_000]);
  });

  it('retries transient poll failures with 1s → 2s → 5s backoff', async () => {
    const pollTimes: number[] = [];
    const start = Date.now();
    stubFetch(async () => {
      pollTimes.push(Date.now() - start);
      if (pollTimes.length <= 3) return fakeResponse({ status: 502, body: 'Bad Gateway' });
      return fakeResponse({ body: { status: 'answered', response: { content: 'back' } } });
    });
    const pending = waitForAnswer(client(), 'r1', { deadline: start + 60_000 });
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(pending).resolves.toEqual({ status: 'answered', content: 'back' });
    expect(pollTimes).toEqual([0, 1_000, 3_000, 8_000]);
  });

  it('reports the last failure when the budget runs out mid-outage', async () => {
    stubFetch(() =>
      Promise.reject(
        new TypeError('fetch failed', {
          cause: Object.assign(new Error('x'), { code: 'ECONNREFUSED' }),
        })
      )
    );
    const pending = waitForAnswer(client(), 'r1', { deadline: Date.now() + 12_000 });
    await vi.advanceTimersByTimeAsync(12_000);
    const outcome = await pending;
    expect(outcome.status).toBe('timeout');
    expect(outcome).toMatchObject({ lastError: expect.stringContaining('ECONNREFUSED') });
  });

  it('throws a non-retryable failure', async () => {
    stubFetch(async () => fakeResponse({ status: 404, body: { error: 'Request not found' } }));
    await expect(
      waitForAnswer(client(), 'r1', { deadline: Date.now() + 60_000 })
    ).rejects.toMatchObject({ status: 404 });
  });

  it('passes expiry reasons through', async () => {
    stubFetch(async () => fakeResponse({ body: { status: 'expired', reason: 'superseded' } }));
    await expect(waitForAnswer(client(), 'r1', { deadline: Date.now() + 60_000 })).resolves.toEqual(
      { status: 'expired', reason: 'superseded' }
    );
  });

  it('stops promptly when aborted mid-poll', async () => {
    stubFetch(hangUntilAborted);
    const controller = new AbortController();
    const pending = waitForAnswer(client(), 'r1', {
      deadline: Date.now() + 600_000,
      signal: controller.signal,
    }).catch(e => e);
    await vi.advanceTimersByTimeAsync(5_000);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    const err = await pending;
    expect(err.kind).toBe('aborted');
  });

  it('stops promptly when aborted during a retry backoff', async () => {
    stubFetch(async () => fakeResponse({ status: 503, body: 'down' }));
    const controller = new AbortController();
    const pending = waitForAnswer(client(), 'r1', {
      deadline: Date.now() + 600_000,
      signal: controller.signal,
    }).catch(e => e);
    await vi.advanceTimersByTimeAsync(500);
    controller.abort();
    const err = await pending;
    expect(err.kind).toBe('aborted');
  });
});
