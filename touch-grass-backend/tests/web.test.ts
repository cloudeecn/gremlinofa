import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../src/config.js';
import * as db from '../src/db.js';
import { AUTH_FAILURE_LIMIT } from '../src/middleware.js';
import { deriveCookieKey, signWebCookie, WEB_COOKIE_NAME } from '../src/webAuth.js';
import { makeCaller, startTestServer, type TestServer } from './helpers.js';

const EXPECTED_CSP =
  "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; " +
  "frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

/** Where a reverse proxy mounts the backend in the URL-resolution checks. */
const PROXIED_BASE = 'https://proxy.example/grass';

let server: TestServer;
let api: ReturnType<typeof makeCaller>;

async function start(overrides: Parameters<typeof startTestServer>[0] = {}) {
  await server?.close();
  server = await startTestServer({ pollTimeoutMs: 2000, ...overrides });
  api = makeCaller(server.baseUrl);
}

beforeEach(async () => {
  db.initDatabase(':memory:');
  await start();
});

afterEach(async () => {
  await server.close();
});

interface WebRequest {
  method?: string;
  form?: Record<string, string>;
  cookie?: string;
  headers?: Record<string, string>;
}

function web(path: string, { method, form, cookie, headers = {} }: WebRequest = {}) {
  const requestHeaders: Record<string, string> = { ...headers };
  if (cookie) requestHeaders.Cookie = cookie;
  if (form) requestHeaders['Content-Type'] = 'application/x-www-form-urlencoded';
  return fetch(`${server.baseUrl}${path}`, {
    method: method ?? (form ? 'POST' : 'GET'),
    headers: requestHeaders,
    body: form ? new URLSearchParams(form).toString() : undefined,
    redirect: 'manual',
  });
}

/** The `name=value` part of the auth Set-Cookie header. */
function cookiePair(res: Response): string {
  const header = res.headers.getSetCookie().find(line => line.startsWith(`${WEB_COOKIE_NAME}=`));
  expect(header).toBeDefined();
  return header!.split(';')[0];
}

async function login(): Promise<string> {
  const res = await web('/web/login', { form: { password: config.webPassword } });
  expect(res.status).toBe(303);
  return cookiePair(res);
}

/**
 * Asserts the Location header is relative, then resolves it the way a browser would for a
 * page served through a proxy that mounts the backend under /grass.
 */
function proxiedLocation(res: Response, requestPath: string): string {
  const location = res.headers.get('location');
  expect(location).toBeTruthy();
  expect(location).not.toMatch(/^(\/|[a-z][a-z0-9+.-]*:)/i);
  const resolved = new URL(location!, PROXIED_BASE + requestPath);
  return resolved.pathname + resolved.search;
}

async function createSession(displayName = 'Deploy check'): Promise<string> {
  const res = await api('/api/sessions', { method: 'POST', body: { displayName } });
  expect(res.status).toBe(201);
  return ((await res.json()) as { sessionId: string }).sessionId;
}

async function askHuman(sessionId: string, body: Record<string, unknown> = {}): Promise<string> {
  const res = await api(`/api/sessions/${sessionId}/message`, {
    method: 'POST',
    body: { content: 'Ship it?', ...body },
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { requestId: string }).requestId;
}

async function waitUntilHeld(requestId: string) {
  await vi.waitFor(() => expect(server.polls.countWaiters(requestId)).toBe(1), { timeout: 2000 });
}

function respond(sessionId: string, cookie: string, form: Record<string, string>) {
  return web(`/web/sessions/${sessionId}/respond`, { cookie, form });
}

interface UpdatesBody {
  html: string;
  count: number;
  pending: { requestId: string; expiresAt: string | null } | null;
  othersPending: string[];
  statusHtml: string;
}

async function updates(sessionId: string, cookie: string, after = 0): Promise<UpdatesBody> {
  const res = await web(`/web/api/sessions/${sessionId}/updates?after=${after}`, { cookie });
  expect(res.status).toBe(200);
  return (await res.json()) as UpdatesBody;
}

/** Pushes a request's deadline into the past; the next read expires it as a timeout. */
function backdateDeadline(requestId: string): string {
  const past = new Date(Date.now() - 60_000).toISOString();
  db.getDatabase().prepare('UPDATE requests SET expiresAt = ? WHERE id = ?').run(past, requestId);
  return past;
}

describe('login', () => {
  it('renders the form with URLs relative to the page', async () => {
    const res = await web('/web/login');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('href="./static/style.css"');
    expect(html).toContain('src="./static/app.js"');
    expect(html).toContain('action="./login"');
    expect(html).toMatch(/<label for="password" class="visually-hidden">/);
  });

  it('sets a signed cookie with no Path and no Secure over plain http', async () => {
    const res = await web('/web/login', { form: { password: config.webPassword } });
    expect(res.status).toBe(303);
    expect(proxiedLocation(res, '/web/login')).toBe('/grass/web/');
    const [setCookie] = res.headers.getSetCookie();
    expect(setCookie).toMatch(
      /^tg_auth=v1\.\d+\.[A-Za-z0-9_-]{43}; Max-Age=604800; HttpOnly; SameSite=Strict$/
    );
  });

  it('lets the cookie in', async () => {
    const res = await web('/web/', { cookie: await login() });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<h1>Touch Grass</h1>');
  });

  it('answers a wrong password with 401 and no cookie', async () => {
    const res = await web('/web/login', { form: { password: 'nope' } });
    expect(res.status).toBe(401);
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(await res.text()).toContain('Wrong password.');
  });

  it.each([
    ['sessions/0123abcd', '/grass/web/sessions/0123abcd'],
    ['', '/grass/web/'],
    ['//evil.example', '/grass/web/'],
    ['https://evil.example/', '/grass/web/'],
    ['sessions/../logout', '/grass/web/'],
    ['sessions/XYZ', '/grass/web/'],
  ])('only follows next=%j when it is a session path', async (next, expected) => {
    const res = await web('/web/login', { form: { password: config.webPassword, next } });
    expect(res.status).toBe(303);
    expect(proxiedLocation(res, '/web/login')).toBe(expected);
  });

  it('carries a valid next through the login form', async () => {
    const html = await (await web('/web/login?next=sessions%2F00ff')).text();
    expect(html).toContain('name="next" value="sessions/00ff"');
    const evil = await (await web('/web/login?next=https%3A%2F%2Fevil.example')).text();
    expect(evil).toContain('name="next" value=""');
  });

  it('locks a client out with a 429 page after five wrong passwords, and resets on success', async () => {
    for (let attempt = 1; attempt <= 4; attempt++) {
      expect((await web('/web/login', { form: { password: 'nope' } })).status).toBe(401);
    }
    const locked = await web('/web/login', { form: { password: 'nope' } });
    expect(locked.status).toBe(429);
    expect(locked.headers.get('retry-after')).toBe('1');
    expect(await locked.text()).toContain('Wait 1 second before trying again');

    // Even the right password waits out the lock.
    const stillLocked = await web('/web/login', { form: { password: config.webPassword } });
    expect(stillLocked.status).toBe(429);
    expect(stillLocked.headers.getSetCookie()).toEqual([]);

    await new Promise(resolve => setTimeout(resolve, 1100));
    expect((await web('/web/login', { form: { password: config.webPassword } })).status).toBe(303);
    // The success cleared the record, so the next miss is an ordinary 401 again.
    expect((await web('/web/login', { form: { password: 'nope' } })).status).toBe(401);
  });

  it('counts a whole IPv6 /64 as one client, so rotating addresses does not dodge the lock', async () => {
    await start({ trustProxy: 'loopback' });
    const fromAddress = (suffix: number, prefix = '2001:db8:1:2') =>
      web('/web/login', {
        form: { password: 'nope' },
        headers: { 'X-Forwarded-For': `${prefix}::${suffix.toString(16)}` },
      });
    for (let attempt = 1; attempt <= 4; attempt++) {
      expect((await fromAddress(attempt)).status).toBe(401);
    }
    expect((await fromAddress(5)).status).toBe(429);
    // Another /64 has its own count.
    expect((await fromAddress(1, '2001:db8:1:3')).status).toBe(401);
  });

  it('marks the cookie Secure only behind a trusted proxy reporting https', async () => {
    const viaProxy = { 'X-Forwarded-Proto': 'https' };
    const untrusted = await web('/web/login', {
      form: { password: config.webPassword },
      headers: viaProxy,
    });
    expect(untrusted.headers.getSetCookie()[0]).not.toContain('Secure');

    await start({ trustProxy: 'loopback' });
    const trusted = await web('/web/login', {
      form: { password: config.webPassword },
      headers: viaProxy,
    });
    expect(trusted.headers.getSetCookie()[0]).toMatch(/; Secure$/);
    expect(trusted.headers.getSetCookie()[0]).not.toMatch(/Path=/i);
  });

  it('logout clears the cookie on the same default path', async () => {
    const res = await web('/web/logout', { method: 'POST', cookie: await login() });
    expect(res.status).toBe(303);
    expect(proxiedLocation(res, '/web/logout')).toBe('/grass/web/login');
    expect(res.headers.getSetCookie()).toEqual(['tg_auth=; Max-Age=0; HttpOnly; SameSite=Strict']);
  });

  it('caps 401s per client: past the limit every page is a 429, the login page included', async () => {
    for (let attempt = 0; attempt < AUTH_FAILURE_LIMIT; attempt++) {
      expect((await web('/web/api/sessions')).status).toBe(401);
    }
    const page = await web('/web/login');
    expect(page.status).toBe(429);
    expect(Number(page.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(page.headers.get('content-type')).toMatch(/text\/html/);
    expect(await page.text()).toContain('Too many failed sign-ins from your address');

    const poll = await web('/web/api/sessions');
    expect(poll.status).toBe(429);
    expect(poll.headers.get('content-type')).toMatch(/application\/json/);
  });

  it("doesn't count the login backoff's own 429s toward the cap", async () => {
    // From the fifth miss on the backoff answers 429 itself, so only four 401s reach the cap.
    let lockouts = 0;
    for (let attempt = 0; attempt < AUTH_FAILURE_LIMIT + 5; attempt++) {
      const res = await web('/web/login', { form: { password: 'nope' } });
      if (res.status === 429) lockouts++;
    }
    expect(lockouts).toBe(AUTH_FAILURE_LIMIT + 1);
    expect((await web('/web/login')).status).toBe(200);
  });
});

describe('cookie verification', () => {
  const key = () => deriveCookieKey(config.webPassword);

  function tamperMac(token: string): string {
    const macStart = token.lastIndexOf('.') + 1;
    const mac = token.slice(macStart);
    return token.slice(0, macStart) + (mac[0] === 'A' ? 'B' : 'A') + mac.slice(1);
  }

  it('accepts a cookie signed with the WEB_PASSWORD key', async () => {
    const token = signWebCookie(key(), Date.now() + 60_000);
    expect((await web('/web/', { cookie: `${WEB_COOKIE_NAME}=${token}` })).status).toBe(200);
  });

  it.each([
    ['tampered MAC', () => tamperMac(signWebCookie(key(), Date.now() + 60_000))],
    ['expired', () => signWebCookie(key(), Date.now() - 1000)],
    [
      'signed with another password',
      () => signWebCookie(deriveCookieKey('other'), Date.now() + 60_000),
    ],
    ['garbage', () => 'not-a-token'],
  ])('rejects a %s cookie', async (_label, makeToken) => {
    const cookie = `${WEB_COOKIE_NAME}=${makeToken()}`;

    const page = await web('/web/', { cookie });
    expect(page.status).toBe(303);
    expect(proxiedLocation(page, '/web/')).toBe('/grass/web/login');

    const poll = await web('/web/api/sessions', { cookie });
    expect(poll.status).toBe(401);
    expect(await poll.json()).toEqual({ error: 'Not signed in' });
  });

  it('stops accepting cookies once WEB_PASSWORD changes', async () => {
    const cookie = await login();
    await start({ webPassword: 'a-brand-new-password' });
    expect((await web('/web/', { cookie })).status).toBe(303);
  });
});

describe('relative redirects', () => {
  it('sends /web to web/', async () => {
    const res = await web('/web');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('web/');
    expect(proxiedLocation(res, '/web')).toBe('/grass/web/');
  });

  it('sends a signed-out deep link to login and back', async () => {
    const res = await web('/web/sessions/00ff');
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('../login?next=sessions%2F00ff');
    expect(proxiedLocation(res, '/web/sessions/00ff')).toBe(
      '/grass/web/login?next=sessions%2F00ff'
    );
  });

  it('sends a signed-out answer to login with the session as next', async () => {
    const res = await web('/web/sessions/00ff/respond', { form: { content: 'hi' } });
    expect(res.status).toBe(303);
    expect(proxiedLocation(res, '/web/sessions/00ff/respond')).toBe(
      '/grass/web/login?next=sessions%2F00ff'
    );
  });

  it('builds chat page URLs relative to the page depth', async () => {
    const sessionId = await createSession();
    const html = await (await web(`/web/sessions/${sessionId}`, { cookie: await login() })).text();
    expect(html).toContain('href="../static/style.css"');
    expect(html).toContain('src="../static/app.js"');
    expect(html).toContain('data-base="../"');
    expect(html).toContain(`action="../sessions/${sessionId}/respond"`);
    expect(html).toContain('<a href="../" class="back-button" title="Back to sessions">');
  });
});

describe('security headers', () => {
  it.each(['/web/login', '/web/', '/web/static/app.js', '/web/static/missing.css', '/web/nope'])(
    'are on %s',
    async path => {
      const res = await web(path);
      expect(res.headers.get('content-security-policy')).toBe(EXPECTED_CSP);
      expect(res.headers.get('x-frame-options')).toBe('DENY');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      // no-referrer would make browsers send `Origin: null` with every form POST, which the
      // cross-origin check refuses; same-origin keeps the real Origin on the UI's own forms.
      expect(res.headers.get('referrer-policy')).toBe('same-origin');
    }
  );

  it('keeps pages free of inline script, inline style and event handlers', async () => {
    const cookie = await login();
    const sessionId = await createSession();
    await askHuman(sessionId, { files: [{ path: 'a.txt', content: 'x' }] });
    const pages = await Promise.all(
      ['/web/login', '/web/', `/web/sessions/${sessionId}`].map(path =>
        web(path, { cookie }).then(res => res.text())
      )
    );
    for (const html of pages) {
      expect(html).not.toMatch(/<script(?![^>]*\ssrc=)[^>]*>/);
      expect(html).not.toMatch(/\sstyle=/);
      expect(html).not.toMatch(/\son[a-z]+=/);
    }
  });

  it('marks pages no-store but lets static assets cache', async () => {
    expect((await web('/web/login')).headers.get('cache-control')).toBe('no-store');
    expect((await web('/web/static/style.css')).headers.get('cache-control')).not.toBe('no-store');
  });
});

describe('static assets', () => {
  it.each([
    ['app.js', /javascript/],
    ['style.css', /text\/css/],
    ['favicon.svg', /image\/svg\+xml/],
  ])('serves %s without a cookie', async (file, contentType) => {
    const res = await web(`/web/static/${file}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(contentType);
  });

  it('answers a missing asset with a 404 page instead of a login redirect', async () => {
    const res = await web('/web/static/nope.js');
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    // send's error is unexposed (its message holds the file path), so only the status text shows.
    const html = await res.text();
    expect(html).toContain('Not Found');
    expect(html).not.toContain('nope.js');
  });
});

describe('cross-origin POST check', () => {
  it('refuses a POST whose Origin is another site', async () => {
    const res = await web('/web/login', {
      form: { password: config.webPassword },
      headers: { Origin: 'https://evil.example' },
    });
    expect(res.status).toBe(403);
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(await res.text()).toContain('Request refused');
  });

  it('refuses an answer from a sandboxed frame and leaves the request pending', async () => {
    const cookie = await login();
    const sessionId = await createSession();
    const requestId = await askHuman(sessionId);
    const res = await web(`/web/sessions/${sessionId}/respond`, {
      cookie,
      form: { requestId, content: 'yes' },
      headers: { Origin: 'null', 'Sec-Fetch-Site': 'cross-site' },
    });
    expect(res.status).toBe(403);
    expect(db.getRequest(requestId)?.status).toBe('pending');
  });

  it('explains a null Origin without blaming the proxy', async () => {
    const res = await web('/web/login', {
      form: { password: config.webPassword },
      headers: { Origin: 'null' },
    });
    expect(res.status).toBe(403);
    const html = await res.text();
    expect(html).toContain('Origin: null');
    expect(html).not.toContain('proxy_set_header');
  });

  it('accepts the login form as a browser sends it from the login page', async () => {
    const res = await web('/web/login', {
      form: { password: config.webPassword },
      headers: { Origin: server.baseUrl, 'Sec-Fetch-Site': 'same-origin' },
    });
    expect(res.status).toBe(303);
    expect(res.headers.getSetCookie()).toHaveLength(1);
  });

  it('accepts a same-origin POST from a browser that sends no Sec-Fetch-Site', async () => {
    const res = await web('/web/login', {
      form: { password: config.webPassword },
      headers: { Origin: server.baseUrl },
    });
    expect(res.status).toBe(303);
  });

  it('goes by Sec-Fetch-Site when the browser sends it, even if a proxy rewrote Host', async () => {
    const res = await web('/web/login', {
      form: { password: config.webPassword },
      headers: { Origin: 'https://grass.example', 'Sec-Fetch-Site': 'same-origin' },
    });
    expect(res.status).toBe(303);
  });

  it.each(['same-site', 'cross-site'])('refuses Sec-Fetch-Site: %s', async fetchSite => {
    const res = await web('/web/login', {
      form: { password: config.webPassword },
      headers: { Origin: 'https://other.example', 'Sec-Fetch-Site': fetchSite },
    });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('sent from another site (https://other.example)');
  });

  it('trusts X-Forwarded-Host only when TRUST_PROXY trusts the proxy', async () => {
    const proxied = {
      form: { password: config.webPassword },
      headers: { Origin: 'https://grass.example', 'X-Forwarded-Host': 'grass.example' },
    };
    expect((await web('/web/login', proxied)).status).toBe(403);
    await start({ trustProxy: 'loopback' });
    expect((await web('/web/login', proxied)).status).toBe(303);
  });
});

describe('answering', () => {
  it('delivers the answer with LF line breaks, wakes the API poll and redirects back', async () => {
    const cookie = await login();
    const sessionId = await createSession();
    const requestId = await askHuman(sessionId);
    const held = api(`/api/requests/${requestId}/poll`);
    await waitUntilHeld(requestId);

    const res = await respond(sessionId, cookie, {
      requestId,
      content: 'line one\r\nline two\r\n',
    });
    expect(res.status).toBe(303);
    // `sent` is how app.js learns the answer landed and drops the draft.
    expect(proxiedLocation(res, `/web/sessions/${sessionId}/respond`)).toBe(
      `/grass/web/sessions/${sessionId}?sent=${requestId}`
    );

    const outcome = await held;
    expect(await outcome.json()).toEqual({
      status: 'answered',
      response: { content: 'line one\nline two\n' },
    });
    expect(db.getMessages(sessionId).at(-1)?.content).toBe('line one\nline two\n');
  });

  it('refuses an answer to a superseded question with a 409 page that keeps the draft', async () => {
    const cookie = await login();
    const sessionId = await createSession();
    const staleRequestId = await askHuman(sessionId);
    const currentRequestId = await askHuman(sessionId, { content: 'Actually, which branch?' });

    const res = await respond(sessionId, cookie, {
      requestId: staleRequestId,
      content: '<b>Ship it</b> & "go"',
    });
    expect(res.status).toBe(409);
    const html = await res.text();
    expect(html).toContain('&lt;b&gt;Ship it&lt;/b&gt; &amp; &quot;go&quot;</textarea>');
    expect(html).toContain('The AI sent a new message before you answered');
    // The form now targets the question that is actually open.
    expect(html).toContain(`name="requestId" id="request-id" value="${currentRequestId}"`);
    expect(db.getRequest(currentRequestId)?.status).toBe('pending');
  });

  it('refuses a whitespace-only answer with 400', async () => {
    const cookie = await login();
    const sessionId = await createSession();
    const requestId = await askHuman(sessionId);
    const res = await respond(sessionId, cookie, { requestId, content: ' \r\n\t ' });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('Your answer is empty');
    expect(db.getRequest(requestId)?.status).toBe('pending');
  });

  it('explains a cancelled question', async () => {
    const cookie = await login();
    const sessionId = await createSession();
    const requestId = await askHuman(sessionId);
    await api(`/api/requests/${requestId}/cancel`, { method: 'POST' });
    const res = await respond(sessionId, cookie, { requestId, content: 'too late' });
    expect(res.status).toBe(409);
    expect(await res.text()).toContain('it cancelled the question');
  });

  it('explains a question whose deadline passed', async () => {
    const cookie = await login();
    const sessionId = await createSession();
    const requestId = await askHuman(sessionId, { timeoutMs: 60_000 });
    backdateDeadline(requestId);
    const res = await respond(sessionId, cookie, { requestId, content: 'too late' });
    expect(res.status).toBe(409);
    const html = await res.text();
    expect(html).toContain('its deadline passed');
    expect(html).toContain('too late</textarea>');
  });

  it('turns a double submit into a 409 instead of a second answer', async () => {
    const cookie = await login();
    const sessionId = await createSession();
    const requestId = await askHuman(sessionId);
    expect((await respond(sessionId, cookie, { requestId, content: 'yes' })).status).toBe(303);
    const again = await respond(sessionId, cookie, { requestId, content: 'yes' });
    expect(again.status).toBe(409);
    expect(await again.text()).toContain('already answered');
    expect(db.getMessages(sessionId).filter(message => message.role === 'human')).toHaveLength(1);
  });

  it('refuses an answer over 1 MB with a 413 page that names the limit', async () => {
    const cookie = await login();
    const sessionId = await createSession();
    const requestId = await askHuman(sessionId);
    const res = await respond(sessionId, cookie, { requestId, content: 'x'.repeat(1_100_000) });
    expect(res.status).toBe(413);
    expect(await res.text()).toContain('Answers are limited to 1 MB of text.');
    expect(db.getRequest(requestId)?.status).toBe('pending');
  });

  it('answers an unknown session with a 404 page', async () => {
    const res = await respond('00ff', await login(), { requestId: 'x', content: 'hello' });
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('This session no longer exists');
  });
});

describe('chat page', () => {
  it('renders files around the message, empty content, caller id and <time> tags', async () => {
    const cookie = await login();
    const sessionId = await createSession('Review <the> diff');
    await askHuman(sessionId, {
      content: 'Middle text',
      files: [
        { path: 'after.txt', content: 'AFTER', placement: 'after' },
        { path: 'before.txt', content: 'BEFORE' },
      ],
    });
    await askHuman(sessionId, { content: '', files: [{ path: 'only.txt', content: 'ONLY' }] });

    const html = await (await web(`/web/sessions/${sessionId}`, { cookie })).text();
    const before = html.indexOf('before.txt');
    const middle = html.indexOf('Middle text');
    const after = html.indexOf('after.txt');
    expect(before).toBeGreaterThan(-1);
    expect(before).toBeLessThan(middle);
    expect(middle).toBeLessThan(after);
    expect(html.match(/class="message-content"/g)).toHaveLength(1);
    expect(html).toContain('only.txt');
    expect(html).toContain('<h1>Review &lt;the&gt; diff</h1>');
    expect(html).toContain('caller: test-caller');
    expect(html).toMatch(
      /<time datetime="\d{4}-\d\d-\d\dT[^"]+Z">\d{4}-\d\d-\d\d \d\d:\d\d UTC<\/time>/
    );
  });

  it('names an unnamed session by its short id', async () => {
    const res = await api('/api/sessions', { method: 'POST', body: {} });
    const { sessionId } = (await res.json()) as { sessionId: string };
    const html = await (await web(`/web/sessions/${sessionId}`, { cookie: await login() })).text();
    expect(html).toContain(`<h1>Session ${sessionId.slice(0, 8)}</h1>`);
  });

  it('shows the deadline while the AI waits', async () => {
    const cookie = await login();
    const sessionId = await createSession();
    await askHuman(sessionId, { timeoutMs: 600_000 });
    const html = await (await web(`/web/sessions/${sessionId}`, { cookie })).text();
    expect(html).toMatch(/It gives up <time datetime="[^"]+" data-countdown>/);
    expect(html).toMatch(/<button type="submit" id="send-btn">Send<\/button>/);
  });

  it('says when the AI stopped waiting and makes the box read-only', async () => {
    const cookie = await login();
    const sessionId = await createSession();
    const requestId = await askHuman(sessionId);
    await api(`/api/requests/${requestId}/cancel`, { method: 'POST' });
    const html = await (await web(`/web/sessions/${sessionId}`, { cookie })).text();
    expect(html).toContain('The AI stopped waiting at <time');
    expect(html).toMatch(/<textarea[^>]*readonly>/);
    expect(html).toContain('id="send-btn" disabled');
    expect(html).toContain('name="requestId" id="request-id" value=""');
  });

  it('has the alert toggles and counts questions waiting in other sessions', async () => {
    const cookie = await login();
    const sessionId = await createSession();
    await askHuman(sessionId);
    const otherRequestId = await askHuman(await createSession('Other'));

    const html = await (await web(`/web/sessions/${sessionId}`, { cookie })).text();
    expect(html).toContain('<title>(2) Deploy check - Touch Grass</title>');
    expect(html).toContain(`data-others-pending="${otherRequestId}"`);
    expect(html).toContain('<span class="badge" id="others-waiting">1 other waiting</span>');
    expect(html).toContain('id="sound-toggle"');
    expect(html).toContain('id="notify-toggle"');
  });

  it('hides the others badge when no other session waits', async () => {
    const cookie = await login();
    const sessionId = await createSession();
    const html = await (await web(`/web/sessions/${sessionId}`, { cookie })).text();
    expect(html).toContain('<title>Deploy check - Touch Grass</title>');
    expect(html).toContain('id="others-waiting" hidden>');
  });
});

describe('chat updates endpoint', () => {
  it('returns everything for after=0 along with the pending request', async () => {
    const cookie = await login();
    const sessionId = await createSession();
    const requestId = await askHuman(sessionId, { content: 'Is <this> fine?' });

    const body = await updates(sessionId, cookie);
    expect(body).toEqual({
      html: expect.stringContaining('Is &lt;this&gt; fine?'),
      count: 1,
      pending: { requestId, expiresAt: null },
      othersPending: [],
      statusHtml: expect.stringContaining('waiting for your answer'),
    });
  });

  it('lists the questions waiting in other sessions, not this one', async () => {
    const cookie = await login();
    const sessionId = await createSession();
    await askHuman(sessionId);
    const otherRequestId = await askHuman(await createSession('Other'));
    expect((await updates(sessionId, cookie)).othersPending).toEqual([otherRequestId]);
  });

  it('returns only the messages after the given count', async () => {
    const cookie = await login();
    const sessionId = await createSession();
    const firstRequestId = await askHuman(sessionId, { content: 'First question' });
    await respond(sessionId, cookie, { requestId: firstRequestId, content: 'First answer' });
    const secondRequestId = await askHuman(sessionId, { content: 'Second question' });

    const body = await updates(sessionId, cookie, 1);
    expect(body.count).toBe(3);
    expect(body.html).not.toContain('First question');
    expect(body.html).toContain('First answer');
    expect(body.html).toContain('Second question');
    expect(body.pending?.requestId).toBe(secondRequestId);

    const nothingNew = await updates(sessionId, cookie, 3);
    expect(nothingNew).toMatchObject({ html: '', count: 3 });
  });

  it('says the AI stopped waiting after a cancel', async () => {
    const cookie = await login();
    const sessionId = await createSession();
    const requestId = await askHuman(sessionId);
    await api(`/api/requests/${requestId}/cancel`, { method: 'POST' });

    const body = await updates(sessionId, cookie, 1);
    expect(body.pending).toBeNull();
    expect(body.statusHtml).toContain('The AI stopped waiting at');
    expect(body.statusHtml).toContain('cancelled the question');
  });

  it('says the AI stopped waiting at the deadline once it passed', async () => {
    const cookie = await login();
    const sessionId = await createSession();
    const requestId = await askHuman(sessionId, { timeoutMs: 60_000 });
    const deadline = backdateDeadline(requestId);

    const body = await updates(sessionId, cookie, 1);
    expect(body.pending).toBeNull();
    expect(body.statusHtml).toContain(`The AI stopped waiting at <time datetime="${deadline}">`);
    expect(body.statusHtml).toContain('deadline passed');
  });

  it('says the answer was delivered once the human answered', async () => {
    const cookie = await login();
    const sessionId = await createSession();
    const requestId = await askHuman(sessionId);
    await respond(sessionId, cookie, { requestId, content: 'done' });
    const body = await updates(sessionId, cookie, 2);
    expect(body.pending).toBeNull();
    expect(body.statusHtml).toContain('Answer delivered');
  });

  it('says an async note needs no answer, on the page and in updates', async () => {
    const cookie = await login();
    const sessionId = await createSession();
    const requestId = await askHuman(sessionId);
    await respond(sessionId, cookie, { requestId, content: 'done' });
    await api(`/api/sessions/${sessionId}/message`, {
      method: 'POST',
      body: { content: 'Deployed, thanks', awaitReply: false },
    });

    const body = await updates(sessionId, cookie, 2);
    expect(body.pending).toBeNull();
    expect(body.html).toContain('no reply needed');
    expect(body.statusHtml).toContain('needs no answer');

    const page = await (await web(`/web/sessions/${sessionId}`, { cookie })).text();
    expect(page).toContain('needs no answer');
    expect(page.match(/no reply needed/g)).toHaveLength(1);
  });

  it('rejects a bad after with 400 and an unknown session with 404', async () => {
    const cookie = await login();
    const sessionId = await createSession();
    const bad = await web(`/web/api/sessions/${sessionId}/updates?after=-1`, { cookie });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'after must be a non-negative integer' });
    const missing = await web('/web/api/sessions/00ff/updates', { cookie });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'Session not found' });
  });
});

describe('session list', () => {
  interface ListBody {
    html: string;
    pendingIds: string[];
    signature: string;
  }

  async function listJson(cookie: string): Promise<ListBody> {
    const res = await web('/web/api/sessions', { cookie });
    expect(res.status).toBe(200);
    return (await res.json()) as ListBody;
  }

  it('returns an escaped fragment, the pending count and a signature that tracks changes', async () => {
    const cookie = await login();
    const sessionId = await createSession('<script>alert(1)</script>');
    const idle = await listJson(cookie);
    expect(idle.pendingIds).toEqual([]);
    expect(idle.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(idle.html).not.toContain('<script>');
    expect((await listJson(cookie)).signature).toBe(idle.signature);

    const requestId = await askHuman(sessionId, { timeoutMs: 600_000 });
    const waiting = await listJson(cookie);
    expect(waiting.pendingIds).toEqual([requestId]);
    expect(waiting.signature).not.toBe(idle.signature);
    expect(waiting.html).toContain('needs answer');
    expect(waiting.html).toMatch(/Waiting <time datetime="[^"]+" data-elapsed>/);
    expect(waiting.html).toMatch(/AI gives up <time datetime="[^"]+" data-countdown>/);
    expect(waiting.html).toContain(`href="./sessions/${sessionId}"`);
    expect(waiting.html).toContain(`action="./sessions/${sessionId}/delete"`);
  });

  it('puts the pending count in the page title and the ids on the page', async () => {
    const cookie = await login();
    const requestId = await askHuman(await createSession());
    const html = await (await web('/web/', { cookie })).text();
    expect(html).toContain('<title>(1) Touch Grass</title>');
    expect(html).toContain(`data-pending-ids="${requestId}"`);
  });

  it('changes the pending ids when one question replaces another', async () => {
    const cookie = await login();
    const sessionId = await createSession();
    const first = await askHuman(sessionId);
    const before = await listJson(cookie);
    const second = await askHuman(sessionId, { content: 'Actually, which branch?' });
    const after = await listJson(cookie);
    expect(before.pendingIds).toEqual([first]);
    expect(after.pendingIds).toEqual([second]);
  });
});

describe('deleting a session', () => {
  it('removes it and wakes its held API poll with 404', async () => {
    const cookie = await login();
    const sessionId = await createSession();
    const requestId = await askHuman(sessionId);
    const held = api(`/api/requests/${requestId}/poll`);
    await waitUntilHeld(requestId);

    const res = await web(`/web/sessions/${sessionId}/delete`, { method: 'POST', cookie });
    expect(res.status).toBe(303);
    expect(proxiedLocation(res, `/web/sessions/${sessionId}/delete`)).toBe('/grass/web/');

    expect((await held).status).toBe(404);
    expect(db.getSession(sessionId)).toBeUndefined();
    expect((await web(`/web/api/sessions/${sessionId}/updates`, { cookie })).status).toBe(404);
  });

  it('lands on the list when the session is already gone', async () => {
    const res = await web('/web/sessions/00ff/delete', { method: 'POST', cookie: await login() });
    expect(res.status).toBe(303);
  });
});
