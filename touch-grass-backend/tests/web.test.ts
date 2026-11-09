import crypto from 'crypto';
import { CookieJar } from 'jsdom';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../src/config.js';
import * as db from '../src/db.js';
import { AUTH_FAILURE_LIMIT } from '../src/middleware.js';
import { generateUserToken, hashPassword } from '../src/passwords.js';
import type { User } from '../src/types.js';
import {
  adminBinding,
  deriveCookieKey,
  signWebCookie,
  userBinding,
  WEB_COOKIE_NAME,
} from '../src/webAuth.js';
import { makeCaller, startTestServer, type TestServer } from './helpers.js';

const EXPECTED_CSP =
  "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; " +
  "frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

/** Where a reverse proxy mounts the backend in the URL-resolution checks. */
const PROXIED_BASE = 'https://proxy.example/grass';

const ADMIN_FORM = { username: config.webAdminUsername, password: config.webPassword };
const WRONG_ADMIN_FORM = { ...ADMIN_FORM, password: 'nope' };

/** Every test user gets this password; hashing it once keeps the suite fast. */
const USER_PASSWORD = 'grass-is-greener';
let userPasswordHash: string;

beforeAll(async () => {
  userPasswordHash = await hashPassword(USER_PASSWORD);
});

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

async function login(form: Record<string, string> = ADMIN_FORM): Promise<string> {
  const res = await web('/web/login', { form });
  expect(res.status).toBe(303);
  return cookiePair(res);
}

function addUser(username: string): User {
  const user = db.createUser({
    id: crypto.randomBytes(16).toString('hex'),
    username,
    passwordHash: userPasswordHash,
    token: generateUserToken(),
  });
  if (!user) throw new Error(`username ${username} is taken`);
  return user;
}

/** A cookie for `user` as it is now, signed directly: a real login costs a scrypt. */
function cookieFor(user: User): string {
  const token = signWebCookie(
    deriveCookieKey(config.webPassword),
    user.id,
    userBinding(user.passwordHash),
    Date.now() + 60_000
  );
  return `${WEB_COOKIE_NAME}=${token}`;
}

/** The status of the session list for `cookie`: 200 signed in, 303 sent to the login page. */
async function listStatus(cookie: string): Promise<number> {
  return (await web('/web/', { cookie })).status;
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

async function createSession(displayName = 'Deploy check', userToken?: string): Promise<string> {
  const res = await api('/api/sessions', { method: 'POST', body: { displayName, userToken } });
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
    expect(html).toMatch(/<label for="username" class="visually-hidden">/);
    expect(html).toMatch(/<label for="password" class="visually-hidden">/);
  });

  it('sets a signed cookie with no Path and no Secure over plain http', async () => {
    const res = await web('/web/login', { form: ADMIN_FORM });
    expect(res.status).toBe(303);
    expect(proxiedLocation(res, '/web/login')).toBe('/grass/web/');
    const [setCookie] = res.headers.getSetCookie();
    expect(setCookie).toMatch(
      /^tg_auth=v2\.admin\.\d+\.[A-Za-z0-9_-]{43}; Max-Age=604800; HttpOnly; SameSite=Strict$/
    );
  });

  it('lets the cookie in', async () => {
    const res = await web('/web/', { cookie: await login() });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<h1>Touch Grass</h1>');
  });

  it('answers a wrong password with 401 and no cookie', async () => {
    const res = await web('/web/login', { form: WRONG_ADMIN_FORM });
    expect(res.status).toBe(401);
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(await res.text()).toContain('Wrong username or password.');
  });

  it.each([
    ['sessions/0123abcd', '/grass/web/sessions/0123abcd'],
    ['', '/grass/web/'],
    ['//evil.example', '/grass/web/'],
    ['https://evil.example/', '/grass/web/'],
    ['sessions/../logout', '/grass/web/'],
    ['sessions/XYZ', '/grass/web/'],
    ['account', '/grass/web/account'],
    ['admin', '/grass/web/admin'],
    ['admin/users', '/grass/web/'],
  ])('only follows next=%j when it is a page of this UI', async (next, expected) => {
    const res = await web('/web/login', { form: { ...ADMIN_FORM, next } });
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
      expect((await web('/web/login', { form: WRONG_ADMIN_FORM })).status).toBe(401);
    }
    const locked = await web('/web/login', { form: WRONG_ADMIN_FORM });
    expect(locked.status).toBe(429);
    expect(locked.headers.get('retry-after')).toBe('1');
    expect(await locked.text()).toContain('Wait 1 second before trying again');

    // Even the right password waits out the lock.
    const stillLocked = await web('/web/login', { form: ADMIN_FORM });
    expect(stillLocked.status).toBe(429);
    expect(stillLocked.headers.getSetCookie()).toEqual([]);

    await new Promise(resolve => setTimeout(resolve, 1100));
    expect((await web('/web/login', { form: ADMIN_FORM })).status).toBe(303);
    // The success cleared the record, so the next miss is an ordinary 401 again.
    expect((await web('/web/login', { form: WRONG_ADMIN_FORM })).status).toBe(401);
  });

  it('counts a whole IPv6 /64 as one client, so rotating addresses does not dodge the lock', async () => {
    await start({ trustProxy: 'loopback' });
    const fromAddress = (suffix: number, prefix = '2001:db8:1:2') =>
      web('/web/login', {
        form: WRONG_ADMIN_FORM,
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
      form: ADMIN_FORM,
      headers: viaProxy,
    });
    expect(untrusted.headers.getSetCookie()[0]).not.toContain('Secure');

    await start({ trustProxy: 'loopback' });
    const trusted = await web('/web/login', {
      form: ADMIN_FORM,
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
      const res = await web('/web/login', { form: WRONG_ADMIN_FORM });
      if (res.status === 429) lockouts++;
    }
    expect(lockouts).toBe(AUTH_FAILURE_LIMIT + 1);
    expect((await web('/web/login')).status).toBe(200);
  });
});

describe('cookie verification', () => {
  const key = () => deriveCookieKey(config.webPassword);
  const adminCookie = (expiresAtMs: number, signingKey = key(), adminName = ADMIN_FORM.username) =>
    signWebCookie(signingKey, 'admin', adminBinding(adminName), expiresAtMs);

  function tamperMac(token: string): string {
    const macStart = token.lastIndexOf('.') + 1;
    const mac = token.slice(macStart);
    return token.slice(0, macStart) + (mac[0] === 'A' ? 'B' : 'A') + mac.slice(1);
  }

  it('accepts a cookie signed with the WEB_PASSWORD key', async () => {
    const token = adminCookie(Date.now() + 60_000);
    expect((await web('/web/', { cookie: `${WEB_COOKIE_NAME}=${token}` })).status).toBe(200);
  });

  it.each([
    ['tampered MAC', () => tamperMac(adminCookie(Date.now() + 60_000))],
    ['expired', () => adminCookie(Date.now() - 1000)],
    [
      'signed with another password',
      () => adminCookie(Date.now() + 60_000, deriveCookieKey('other')),
    ],
    ['bound to another admin name', () => adminCookie(Date.now() + 60_000, key(), 'Boss')],
    [
      'pre-2.2 (v1)',
      () => {
        const payload = `v1.${Date.now() + 60_000}`;
        const mac = crypto.createHmac('sha256', key()).update(payload).digest('base64url');
        return `${payload}.${mac}`;
      },
    ],
    [
      'unknown user',
      () => signWebCookie(key(), 'f'.repeat(32), userBinding('scrypt$x'), Date.now() + 60_000),
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

  it('stops accepting cookies once WEB_PASSWORD changes, users included', async () => {
    const cookie = await login();
    const userCookie = cookieFor(addUser('bob'));
    await start({ webPassword: 'a-brand-new-password' });
    expect(await listStatus(cookie)).toBe(303);
    expect(await listStatus(userCookie)).toBe(303);
  });

  it("stops accepting the admin's cookies once WEB_ADMIN_USERNAME changes, but not its case", async () => {
    const cookie = await login();
    await start({ webAdminUsername: 'ADMIN' });
    expect(await listStatus(cookie)).toBe(200);
    await start({ webAdminUsername: 'Boss' });
    expect(await listStatus(cookie)).toBe(303);
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

  it.each([
    ['/web/account', './login?next=account'],
    ['/web/admin', './login?next=admin'],
    ['/web/admin/', '../login?next=admin'],
  ])('sends a signed-out %s to login and back', async (path, location) => {
    const res = await web(path);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(location);
  });

  it('sends a signed-out admin form post back to the admin page after login', async () => {
    const res = await web(`/web/admin/users/${'a'.repeat(32)}/rename`, { form: { username: 'x' } });
    expect(res.status).toBe(303);
    expect(proxiedLocation(res, `/web/admin/users/${'a'.repeat(32)}/rename`)).toBe(
      '/grass/web/login?next=admin'
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
    const bob = addUser('bob');
    const bobCookie = cookieFor(bob);
    const sessionId = await createSession();
    await askHuman(sessionId, { files: [{ path: 'a.txt', content: 'x' }] });
    const pages = await Promise.all(
      [
        ['/web/login', cookie],
        ['/web/', cookie],
        [`/web/sessions/${sessionId}`, cookie],
        ['/web/account', cookie],
        ['/web/account?changed=1', bobCookie],
        ['/web/admin', cookie],
        [`/web/admin?created=${bob.id}`, cookie],
      ].map(([path, pageCookie]) =>
        web(path, { cookie: pageCookie }).then(res => {
          expect(res.status).toBe(200);
          return res.text();
        })
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
      form: ADMIN_FORM,
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
      form: ADMIN_FORM,
      headers: { Origin: 'null' },
    });
    expect(res.status).toBe(403);
    const html = await res.text();
    expect(html).toContain('Origin: null');
    expect(html).not.toContain('proxy_set_header');
  });

  it('accepts the login form as a browser sends it from the login page', async () => {
    const res = await web('/web/login', {
      form: ADMIN_FORM,
      headers: { Origin: server.baseUrl, 'Sec-Fetch-Site': 'same-origin' },
    });
    expect(res.status).toBe(303);
    expect(res.headers.getSetCookie()).toHaveLength(1);
  });

  it('accepts a same-origin POST from a browser that sends no Sec-Fetch-Site', async () => {
    const res = await web('/web/login', {
      form: ADMIN_FORM,
      headers: { Origin: server.baseUrl },
    });
    expect(res.status).toBe(303);
  });

  it('goes by Sec-Fetch-Site when the browser sends it, even if a proxy rewrote Host', async () => {
    const res = await web('/web/login', {
      form: ADMIN_FORM,
      headers: { Origin: 'https://grass.example', 'Sec-Fetch-Site': 'same-origin' },
    });
    expect(res.status).toBe(303);
  });

  it.each(['same-site', 'cross-site'])('refuses Sec-Fetch-Site: %s', async fetchSite => {
    const res = await web('/web/login', {
      form: ADMIN_FORM,
      headers: { Origin: 'https://other.example', 'Sec-Fetch-Site': fetchSite },
    });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('sent from another site (https://other.example)');
  });

  it('trusts X-Forwarded-Host only when TRUST_PROXY trusts the proxy', async () => {
    const proxied = {
      form: ADMIN_FORM,
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

describe('signing in by username', () => {
  it.each(['admin', 'ADMIN', '  Admin  '])('signs the admin in as %j', async username => {
    const res = await web('/web/login', { form: { ...ADMIN_FORM, username } });
    expect(res.status).toBe(303);
    expect(cookiePair(res)).toMatch(/^tg_auth=v2\.admin\./);
  });

  it('signs a user in by name in any letter case', async () => {
    const bob = addUser('bob');
    const cookie = await login({ username: 'BOB', password: USER_PASSWORD });
    expect(cookie).toMatch(new RegExp(`^tg_auth=v2\\.${bob.id}\\.`));
    const html = await (await web('/web/', { cookie })).text();
    expect(html).toContain('Signed in as <strong>bob</strong>');
    expect(html).not.toContain('href="./admin"');
  });

  it('answers a wrong password and an unknown name alike, keeping the typed name', async () => {
    addUser('bob');
    for (const form of [
      { username: 'bob', password: 'not-it' },
      { username: 'nobody', password: USER_PASSWORD },
      { username: 'bob', password: config.webPassword },
    ]) {
      const res = await web('/web/login', { form });
      expect(res.status).toBe(401);
      const html = await res.text();
      expect(html).toContain('Wrong username or password.');
      expect(html).toContain(`name="username" placeholder="Username" value="${form.username}"`);
    }
    const escaped = await (
      await web('/web/login', { form: { username: '"><b>x', password: 'p' } })
    ).text();
    expect(escaped).toContain('value="&quot;&gt;&lt;b&gt;x"');
  });

  it("never checks the admin's name against the users table", async () => {
    // A user created before WEB_ADMIN_USERNAME was changed to its name.
    db.createUser({
      id: 'b'.repeat(32),
      username: 'Boss',
      passwordHash: userPasswordHash,
      token: 'tg_boss',
    });
    await start({ webAdminUsername: 'boss' });
    expect(
      (await web('/web/login', { form: { username: 'Boss', password: USER_PASSWORD } })).status
    ).toBe(401);
    const asAdmin = await web('/web/login', {
      form: { username: 'Boss', password: config.webPassword },
    });
    expect(asAdmin.status).toBe(303);
    expect(cookiePair(asAdmin)).toMatch(/^tg_auth=v2\.admin\./);
  });

  it.each([
    ['admin', '/grass/web/'],
    ['account', '/grass/web/account'],
    ['sessions/00ff', '/grass/web/sessions/00ff'],
  ])('sends a user who asked for next=%j to %s', async (next, expected) => {
    addUser('bob');
    const res = await web('/web/login', {
      form: { username: 'bob', password: USER_PASSWORD, next },
    });
    expect(res.status).toBe(303);
    expect(proxiedLocation(res, '/web/login')).toBe(expected);
  });

  it.each(['account', 'admin'])('carries next=%s through the login form', async next => {
    const html = await (await web(`/web/login?next=${next}`)).text();
    expect(html).toContain(`name="next" value="${next}"`);
  });

  it('answers a stored hash whose parameters OpenSSL refuses with the ordinary 401', async () => {
    const bob = addUser('bob');
    db.setUserPassword(bob.id, 'scrypt$131072$1$1$c2FsdA$aGFzaA');
    const res = await web('/web/login', { form: { username: 'bob', password: USER_PASSWORD } });
    expect(res.status).toBe(401);
    expect(await res.text()).toContain('Wrong username or password.');
  });

  it("doesn't let a user's own sign-in reset the backoff from guesses at the admin", async () => {
    addUser('mallory');
    for (let attempt = 1; attempt <= 4; attempt++) {
      expect((await web('/web/login', { form: WRONG_ADMIN_FORM })).status).toBe(401);
    }
    await login({ username: 'mallory', password: USER_PASSWORD });
    const locked = await web('/web/login', { form: WRONG_ADMIN_FORM });
    expect(locked.status).toBe(429);
    expect(locked.headers.get('retry-after')).toBe('1');
  });

  it('clears the backoff when the name that missed signs in, whatever its letter case', async () => {
    addUser('bob');
    for (let attempt = 1; attempt <= 4; attempt++) {
      expect(
        (await web('/web/login', { form: { username: 'bob', password: 'typo' } })).status
      ).toBe(401);
    }
    await login({ username: 'BOB', password: USER_PASSWORD });
    for (let attempt = 1; attempt <= 4; attempt++) {
      expect(
        (await web('/web/login', { form: { username: 'bob', password: 'typo' } })).status
      ).toBe(401);
    }
  });

  it('checks one guess at a time per client, so parallel guesses all meet the lock', async () => {
    const scrypt = vi.spyOn(crypto, 'scrypt');
    try {
      const statuses = await Promise.all(
        Array.from({ length: 10 }, () =>
          web('/web/login', { form: WRONG_ADMIN_FORM }).then(res => res.status)
        )
      );
      expect(statuses.filter(status => status === 401)).toHaveLength(4);
      expect(statuses.filter(status => status === 429)).toHaveLength(6);
      // The fifth guess locked the client; the five queued behind it were never checked.
      expect(scrypt).toHaveBeenCalledTimes(5);
    } finally {
      scrypt.mockRestore();
    }
  });
});

describe('who sees which session', () => {
  let alice: User;
  let bob: User;
  let aliceCookie: string;
  let adminCookie: string;
  let aliceSession: string;
  let bobSession: string;
  let orphanSession: string;
  let aliceRequest: string;
  let bobRequest: string;
  let orphanRequest: string;

  beforeEach(async () => {
    alice = addUser('alice');
    bob = addUser('bob');
    aliceCookie = cookieFor(alice);
    adminCookie = await login();
    aliceSession = await createSession('Alice job', alice.token);
    bobSession = await createSession('Bob job', bob.token);
    orphanSession = await createSession('Nobody job');
    aliceRequest = await askHuman(aliceSession);
    bobRequest = await askHuman(bobSession);
    orphanRequest = await askHuman(orphanSession);
  });

  async function listJson(cookie: string) {
    const res = await web('/web/api/sessions', { cookie });
    expect(res.status).toBe(200);
    return (await res.json()) as { html: string; pendingIds: string[]; signature: string };
  }

  it('lists only their own sessions to a user, with no owner labels', async () => {
    const page = await (await web('/web/', { cookie: aliceCookie })).text();
    const list = await listJson(aliceCookie);
    for (const html of [page, list.html]) {
      expect(html).toContain('Alice job');
      expect(html).not.toContain('Bob job');
      expect(html).not.toContain('Nobody job');
      expect(html).not.toContain('user: ');
      expect(html).not.toContain('no token');
    }
    expect(page).toContain('<title>(1) Touch Grass</title>');
    expect(page).toContain(`data-pending-ids="${aliceRequest}"`);
    expect(list.pendingIds).toEqual([aliceRequest]);
  });

  it('lists every session to the admin, labelled with its owner', async () => {
    const list = await listJson(adminCookie);
    expect(list.pendingIds.sort()).toEqual([aliceRequest, bobRequest, orphanRequest].sort());
    expect(list.html).toContain('caller: test-caller &middot; user: alice');
    expect(list.html).toContain('caller: test-caller &middot; user: bob');
    expect(list.html).toContain('caller: test-caller &middot; no token');
    expect(list.signature).not.toBe((await listJson(aliceCookie)).signature);
  });

  it("answers another inbox's chat page exactly like a missing session", async () => {
    const missing = await web('/web/sessions/00ff', { cookie: aliceCookie });
    expect(missing.status).toBe(404);
    const missingHtml = await missing.text();
    for (const sessionId of [bobSession, orphanSession]) {
      const res = await web(`/web/sessions/${sessionId}`, { cookie: aliceCookie });
      expect(res.status).toBe(404);
      expect(await res.text()).toBe(missingHtml);
    }
  });

  it('shows the admin any chat page with its owner', async () => {
    const bobPage = await (
      await web(`/web/sessions/${bobSession}`, { cookie: adminCookie })
    ).text();
    expect(bobPage).toContain('caller: test-caller &middot; user: bob</span>');
    const orphanPage = await web(`/web/sessions/${orphanSession}`, { cookie: adminCookie });
    expect(orphanPage.status).toBe(200);
    expect(await orphanPage.text()).toContain('caller: test-caller &middot; no token</span>');
  });

  it('refuses an answer into another inbox like one into a missing session, leaving the question open', async () => {
    const missing = await respond('00ff', aliceCookie, { requestId: 'none', content: 'x' });
    expect(missing.status).toBe(404);
    const missingHtml = await missing.text();

    const held = api(`/api/requests/${bobRequest}/poll`);
    await waitUntilHeld(bobRequest);
    const res = await respond(bobSession, aliceCookie, {
      requestId: bobRequest,
      content: 'mine now',
    });
    expect(res.status).toBe(404);
    expect(await res.text()).toBe(missingHtml);
    expect(db.getRequest(bobRequest)?.status).toBe('pending');
    expect(db.getMessages(bobSession).some(message => message.role === 'human')).toBe(false);
    expect(server.polls.countWaiters(bobRequest)).toBe(1);
    const orphan = await respond(orphanSession, aliceCookie, {
      requestId: orphanRequest,
      content: 'x',
    });
    expect(orphan.status).toBe(404);
    expect(await orphan.text()).toBe(missingHtml);

    // Bob can still answer, which ends the held poll.
    expect(
      (await respond(bobSession, cookieFor(bob), { requestId: bobRequest, content: 'yes' })).status
    ).toBe(303);
    expect(await (await held).json()).toEqual({ status: 'answered', response: { content: 'yes' } });
  });

  it('leaves a session in another inbox alone when asked to delete it', async () => {
    for (const sessionId of [bobSession, orphanSession]) {
      const res = await web(`/web/sessions/${sessionId}/delete`, {
        method: 'POST',
        cookie: aliceCookie,
      });
      expect(res.status).toBe(303);
      expect(proxiedLocation(res, `/web/sessions/${sessionId}/delete`)).toBe('/grass/web/');
      expect(db.getSession(sessionId)).toBeDefined();
    }
    expect(db.getRequest(bobRequest)?.status).toBe('pending');

    const own = await web(`/web/sessions/${aliceSession}/delete`, {
      method: 'POST',
      cookie: aliceCookie,
    });
    expect(own.status).toBe(303);
    expect(db.getSession(aliceSession)).toBeUndefined();
  });

  it("answers updates for another inbox's session with 404", async () => {
    for (const sessionId of [bobSession, orphanSession]) {
      const res = await web(`/web/api/sessions/${sessionId}/updates`, { cookie: aliceCookie });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'Session not found' });
    }
  });

  it("counts only the viewer's own sessions as others waiting", async () => {
    const aliceOther = await askHuman(await createSession('Alice second', alice.token));

    const page = await (await web(`/web/sessions/${aliceSession}`, { cookie: aliceCookie })).text();
    expect(page).toContain(`data-others-pending="${aliceOther}"`);
    expect(page).toContain('<title>(2) Alice job - Touch Grass</title>');
    expect((await updates(aliceSession, aliceCookie)).othersPending).toEqual([aliceOther]);

    // The 400 and 409 re-renders of the chat page use the same scope.
    const empty = await respond(aliceSession, aliceCookie, {
      requestId: aliceRequest,
      content: ' ',
    });
    expect(empty.status).toBe(400);
    expect(await empty.text()).toContain(`data-others-pending="${aliceOther}"`);
    const stale = await respond(aliceSession, aliceCookie, { requestId: 'gone', content: 'hi' });
    expect(stale.status).toBe(409);
    expect(await stale.text()).toContain(`data-others-pending="${aliceOther}"`);

    const adminOthers = (await updates(aliceSession, adminCookie)).othersPending;
    expect(adminOthers.sort()).toEqual([aliceOther, bobRequest, orphanRequest].sort());
  });

  it('keeps users out of the admin pages with the ordinary 404', async () => {
    const notFound = await (await web('/web/nope', { cookie: aliceCookie })).text();
    const userId = bob.id;
    for (const [path, form] of [
      ['/web/admin', undefined],
      ['/web/admin/users', { username: 'mallory', password: 'long-enough-1' }],
      [`/web/admin/users/${userId}/rename`, { username: 'mallory' }],
      [`/web/admin/users/${userId}/password`, { password: 'long-enough-1' }],
      [`/web/admin/users/${userId}/delete`, {}],
    ] as const) {
      const res = await web(path, { cookie: aliceCookie, form });
      expect(res.status).toBe(404);
      const html = await res.text();
      expect(html).toContain('Nothing lives at this address.');
      // Same page, give or take the depth of the relative URLs. The prefixes become a marker
      // rather than '' so CodeQL doesn't read the comparison as a path sanitizer.
      const anyDepth = (page: string) => page.replace(/(?:\.\.?\/)+/g, '{rel}');
      expect(anyDepth(html)).toBe(anyDepth(notFound));
    }
    expect(db.getUserByUsername('mallory')).toBeUndefined();
    expect(db.getUserById(bob.id)).toEqual(bob);
  });
});

describe('managing users', () => {
  let adminCookie: string;

  beforeEach(async () => {
    adminCookie = await login();
  });

  function adminPost(path: string, form: Record<string, string>) {
    return web(`/web/admin${path}`, { cookie: adminCookie, form });
  }

  it('adds a user, shows its token, and the user can sign in', async () => {
    const res = await adminPost('/users', { username: '  carol ', password: 'carols-password' });
    expect(res.status).toBe(303);
    const carol = db.getUserByUsername('carol')!;
    expect(carol).toBeDefined();
    expect(carol.token).toMatch(/^tg_[A-Za-z0-9_-]{32}$/);
    expect(proxiedLocation(res, '/web/admin/users')).toBe(`/grass/web/admin?created=${carol.id}`);

    const page = await (
      await web(`/web/admin?created=${carol.id}`, { cookie: adminCookie })
    ).text();
    expect(page).toContain(
      `Added <strong>carol</strong>. Their token is <code class="token">${carol.token}</code>.`
    );

    const cookie = await login({ username: 'Carol', password: 'carols-password' });
    expect(await listStatus(cookie)).toBe(200);
  });

  it('shows live counts per user and for sessions without a token', async () => {
    const bob = addUser('bob');
    const sessionId = await createSession('Bob job', bob.token);
    const requestId = await askHuman(sessionId);
    await respond(sessionId, adminCookie, { requestId, content: 'done' });
    await askHuman(sessionId, { content: 'One more?' });
    await createSession('Nobody job');

    const html = await (await web('/web/admin', { cookie: adminCookie })).text();
    expect(html).toMatch(
      /<th scope="row">bob<\/th>\s*<td class="num">1<\/td><td class="num">2<\/td><td class="num">1<\/td><td class="num">1<\/td><td><time /
    );
    expect(html).toMatch(
      /<th scope="row">No token \(admin only\)<\/th>\s*<td class="num">1<\/td><td class="num">0<\/td><td class="num">0<\/td><td class="num">0<\/td>/
    );
  });

  it('refuses a taken name in any letter case with 409, keeping what was typed', async () => {
    addUser('bob');
    const res = await adminPost('/users', { username: 'BOB', password: 'long-enough-1' });
    expect(res.status).toBe(409);
    const html = await res.text();
    expect(html).toContain('The name BOB is taken.');
    expect(html).toContain('id="new-username" type="text" name="username" value="BOB"');
    expect(db.listUsers()).toHaveLength(1);
  });

  it.each([
    ["the admin's name", 'ADMIN', 'long-enough-1', 'belongs to the admin'],
    ['a short password', 'dave', 'short', 'at least 8'],
    ['a name with a space', 'dave smith', 'long-enough-1', 'only letters'],
    ['no name', '   ', 'long-enough-1', 'Enter a username'],
  ])('refuses %s with 400', async (_label, username, password, message) => {
    const res = await adminPost('/users', { username, password });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain(message);
    expect(db.listUsers()).toEqual([]);
  });

  it('renames a user, who stays signed in', async () => {
    const bob = addUser('bob');
    const cookie = cookieFor(bob);
    const res = await adminPost(`/users/${bob.id}/rename`, { username: 'robert' });
    expect(res.status).toBe(303);
    expect(proxiedLocation(res, `/web/admin/users/${bob.id}/rename`)).toBe(
      '/grass/web/admin?done=renamed'
    );
    expect(db.getUserById(bob.id)?.username).toBe('robert');
    const html = await (await web('/web/', { cookie })).text();
    expect(html).toContain('Signed in as <strong>robert</strong>');
    // A change of case alone is allowed.
    expect((await adminPost(`/users/${bob.id}/rename`, { username: 'Robert' })).status).toBe(303);
  });

  it('refuses a rename to a taken name with 409 and opens that user', async () => {
    const bob = addUser('bob');
    addUser('carol');
    const res = await adminPost(`/users/${bob.id}/rename`, { username: 'CAROL' });
    expect(res.status).toBe(409);
    const html = await res.text();
    expect(html).toContain('The name CAROL is taken.');
    expect(html).toContain('<details class="user-manage" open>');
    expect(html).toContain('value="CAROL"');
    expect(html).toContain('href="../../../static/style.css"');
    expect(db.getUserById(bob.id)?.username).toBe('bob');
    expect((await adminPost(`/users/${bob.id}/rename`, { username: 'Admin' })).status).toBe(400);
  });

  it('answers a malformed user id with the ordinary 404 and an unknown one with a banner', async () => {
    for (const action of ['rename', 'password', 'delete']) {
      const malformed = await adminPost(`/users/not-an-id/${action}`, {
        username: 'x',
        password: 'long-enough-1',
      });
      expect(malformed.status).toBe(404);
      expect(await malformed.text()).toContain('Nothing lives at this address.');

      const unknown = await adminPost(`/users/${'e'.repeat(32)}/${action}`, {
        username: 'x',
        password: 'long-enough-1',
      });
      expect(unknown.status).toBe(404);
      expect(await unknown.text()).toContain('That user no longer exists.');
    }
  });

  it('resets a password, which signs the user out everywhere', async () => {
    const bob = addUser('bob');
    const cookie = cookieFor(bob);
    expect((await adminPost(`/users/${bob.id}/password`, { password: 'short' })).status).toBe(400);
    expect(await listStatus(cookie)).toBe(200);

    const res = await adminPost(`/users/${bob.id}/password`, { password: 'a-new-password' });
    expect(res.status).toBe(303);
    expect(proxiedLocation(res, `/web/admin/users/${bob.id}/password`)).toBe(
      '/grass/web/admin?done=password-reset'
    );
    expect(await listStatus(cookie)).toBe(303);
    expect((await web('/web/api/sessions', { cookie })).status).toBe(401);
    expect(
      (await web('/web/login', { form: { username: 'bob', password: USER_PASSWORD } })).status
    ).toBe(401);
    await login({ username: 'bob', password: 'a-new-password' });
  });

  it('deletes a user: sessions stay for the admin, held polls keep waiting, cookies stop working', async () => {
    const bob = addUser('bob');
    const cookie = cookieFor(bob);
    const sessionId = await createSession('Bob job', bob.token);
    const requestId = await askHuman(sessionId);
    const held = api(`/api/requests/${requestId}/poll`);
    await waitUntilHeld(requestId);

    const res = await adminPost(`/users/${bob.id}/delete`, {});
    expect(res.status).toBe(303);
    expect(proxiedLocation(res, `/web/admin/users/${bob.id}/delete`)).toBe(
      '/grass/web/admin?done=deleted'
    );
    expect(db.getUserById(bob.id)).toBeUndefined();
    expect(db.getSession(sessionId)?.userToken).toBeNull();
    expect(server.polls.countWaiters(requestId)).toBe(1);
    expect(await listStatus(cookie)).toBe(303);

    const list = await (await web('/web/api/sessions', { cookie: adminCookie })).json();
    expect((list as { html: string }).html).toContain('Bob job');
    expect((list as { html: string }).html).toContain('no token');
    const recreate = await api('/api/sessions', { method: 'POST', body: { userToken: bob.token } });
    expect(recreate.status).toBe(400);

    // The admin can still answer the question bob never got to.
    expect((await respond(sessionId, adminCookie, { requestId, content: 'on it' })).status).toBe(
      303
    );
    expect((await held).status).toBe(200);
  });

  it('says what changed after a redirect, and ignores unknown notices', async () => {
    const page = (query: string) =>
      web(`/web/admin${query}`, { cookie: adminCookie }).then(res => res.text());
    expect(await page('?done=deleted')).toContain('User deleted. Their sessions stay');
    expect(await page('?done=constructor')).not.toContain('class="banner banner-info"');
    expect(await page('?created=nope')).not.toContain('Added <strong>');
  });
});

describe('account page', () => {
  let bob: User;

  beforeEach(() => {
    bob = addUser('bob');
  });

  function changePassword(cookie: string, form: Record<string, string>) {
    return web('/web/account', { cookie, form });
  }

  /** A path-aware cookie jar: cookies go where a browser would store and send them. */
  function browser() {
    const jar = new CookieJar();
    return {
      jar,
      async go(path: string, form?: Record<string, string>) {
        const url = `${server.baseUrl}${path}`;
        const cookie = await jar.getCookieString(url);
        const res = await web(path, { form, cookie: cookie || undefined });
        for (const line of res.headers.getSetCookie()) await jar.setCookie(line, url);
        return res;
      },
    };
  }

  it("shows a user's token and tells the admin where its password lives", async () => {
    const userPage = await (await web('/web/account', { cookie: cookieFor(bob) })).text();
    expect(userPage).toContain(`<code class="token">${bob.token}</code>`);
    expect(userPage).toContain('<form method="post" action="./account" class="stacked-form">');

    const adminPage = await (await web('/web/account', { cookie: await login() })).text();
    expect(adminPage).toContain('<code>WEB_PASSWORD</code>');
    expect(adminPage).not.toContain('class="token"');
  });

  it('gives the admin no password form to post to', async () => {
    const res = await changePassword(await login(), {
      current: config.webPassword,
      password: 'long-enough-1',
      confirm: 'long-enough-1',
    });
    expect(res.status).toBe(404);
  });

  it('refuses a wrong current password with 401, and the fifth miss locks like a login', async () => {
    const cookie = cookieFor(bob);
    const wrong = { current: 'not-it', password: 'long-enough-1', confirm: 'long-enough-1' };
    for (let attempt = 1; attempt <= 4; attempt++) {
      const res = await changePassword(cookie, wrong);
      expect(res.status).toBe(401);
      expect(await res.text()).toContain('Your current password is wrong.');
    }
    const locked = await changePassword(cookie, wrong);
    expect(locked.status).toBe(429);
    expect(locked.headers.get('retry-after')).toBe('1');
    // The lock covers the login form too: both are password guesses from this address.
    expect((await web('/web/login', { form: ADMIN_FORM })).status).toBe(429);
    expect(db.getUserById(bob.id)?.passwordHash).toBe(userPasswordHash);
  });

  it.each([
    ['too short', 'short', 'short', 'at least 8'],
    ["that don't match", 'long-enough-1', 'long-enough-2', "don't match"],
  ])('refuses new passwords %s with 400', async (_label, password, confirm, message) => {
    const res = await changePassword(cookieFor(bob), { current: USER_PASSWORD, password, confirm });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain(message.replaceAll("'", '&#039;'));
    expect(db.getUserById(bob.id)?.passwordHash).toBe(userPasswordHash);
  });

  it('changes the password, keeps this browser signed in and signs out the others', async () => {
    const thisBrowser = await login({ username: 'bob', password: USER_PASSWORD });
    const otherBrowser = cookieFor(bob);

    const res = await changePassword(thisBrowser, {
      current: USER_PASSWORD,
      password: 'a-new-password',
      confirm: 'a-new-password',
    });
    expect(res.status).toBe(303);
    expect(proxiedLocation(res, '/web/account')).toBe('/grass/web/account?changed=1');
    const renewed = cookiePair(res);
    expect(renewed).toMatch(new RegExp(`^tg_auth=v2\\.${bob.id}\\.`));

    const page = await web('/web/account?changed=1', { cookie: renewed });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Password changed.');
    expect(await listStatus(renewed)).toBe(200);
    expect(await listStatus(thisBrowser)).toBe(303);
    expect(await listStatus(otherBrowser)).toBe(303);
    await login({ username: 'bob', password: 'a-new-password' });
  });

  it('renews the cookie on the path the login set, so it replaces the old one', async () => {
    const { jar, go } = browser();
    expect((await go('/web/login', { username: 'bob', password: USER_PASSWORD })).status).toBe(303);
    const change = await go('/web/account', {
      current: USER_PASSWORD,
      password: 'a-new-password',
      confirm: 'a-new-password',
    });
    expect(change.status).toBe(303);

    const stored = await jar.getCookies(`${server.baseUrl}/web/account/deeper`);
    expect(stored.map(cookie => [cookie.key, cookie.path])).toEqual([[WEB_COOKIE_NAME, '/web']]);
    expect((await go('/web/')).status).toBe(200);
    expect((await go('/web/account')).status).toBe(200);

    // Logout clears that one cookie, so the next person at this browser isn't bob.
    expect((await go('/web/logout', {})).status).toBe(303);
    const account = await go('/web/account');
    expect(account.status).toBe(303);
    expect(account.headers.get('location')).toBe('./login?next=account');
  });

  it('checks one current password at a time per client, so parallel guesses all meet the lock', async () => {
    const cookie = cookieFor(bob);
    const wrong = { current: 'not-it', password: 'long-enough-1', confirm: 'long-enough-1' };
    const scrypt = vi.spyOn(crypto, 'scrypt');
    try {
      const statuses = await Promise.all(
        Array.from({ length: 10 }, () => changePassword(cookie, wrong).then(res => res.status))
      );
      expect(statuses.filter(status => status === 401)).toHaveLength(4);
      expect(statuses.filter(status => status === 429)).toHaveLength(6);
      // The status counts come out the same without the queue; only the scrypt count shows it.
      expect(scrypt).toHaveBeenCalledTimes(5);
    } finally {
      scrypt.mockRestore();
    }
  });

  it("doesn't clear guesses at the admin when a user proves their own current password", async () => {
    for (let attempt = 1; attempt <= 4; attempt++) {
      expect((await web('/web/login', { form: WRONG_ADMIN_FORM })).status).toBe(401);
    }
    // A correct current password with a new one the policy refuses.
    const res = await changePassword(cookieFor(bob), {
      current: USER_PASSWORD,
      password: 'x',
      confirm: 'x',
    });
    expect(res.status).toBe(400);
    expect((await web('/web/login', { form: WRONG_ADMIN_FORM })).status).toBe(429);
  });

  it("doesn't clear guesses at the admin when a user holding the admin's name proves their password", async () => {
    // Created before WEB_ADMIN_USERNAME moved onto its name: it can't sign in any more, but a
    // cookie it already had still works.
    const holder = addUser(config.webAdminUsername.toLowerCase());
    for (let attempt = 1; attempt <= 4; attempt++) {
      expect((await web('/web/login', { form: WRONG_ADMIN_FORM })).status).toBe(401);
    }
    const res = await changePassword(cookieFor(holder), {
      current: USER_PASSWORD,
      password: 'x',
      confirm: 'x',
    });
    expect(res.status).toBe(400);
    expect((await web('/web/login', { form: WRONG_ADMIN_FORM })).status).toBe(429);
  });

  it('clears its own wrong current password once the right one comes', async () => {
    const cookie = cookieFor(bob);
    const attempt = (current: string) =>
      changePassword(cookie, { current, password: 'x', confirm: 'x' }).then(res => res.status);
    for (let miss = 1; miss <= 4; miss++) expect(await attempt('not-it')).toBe(401);
    expect(await attempt(USER_PASSWORD)).toBe(400);
    for (let miss = 1; miss <= 4; miss++) expect(await attempt('not-it')).toBe(401);
  });

  it('answers the second request of a double submit with a 409 that counts no wrong password', async () => {
    const cookie = cookieFor(bob);
    const form = { current: USER_PASSWORD, password: 'a-new-password', confirm: 'a-new-password' };
    const realScrypt = crypto.scrypt;
    // Holds the first check back, so the second request is past the cookie check and waiting
    // in the queue before the first one saves.
    const scrypt = vi.spyOn(crypto, 'scrypt').mockImplementationOnce(((...args: unknown[]) => {
      setTimeout(() => (realScrypt as (...params: unknown[]) => void)(...args), 100);
    }) as typeof crypto.scrypt);
    let responses: Response[];
    try {
      responses = await Promise.all([changePassword(cookie, form), changePassword(cookie, form)]);
    } finally {
      scrypt.mockRestore();
    }
    expect(responses.map(res => res.status).sort()).toEqual([303, 409]);
    const refused = responses.find(res => res.status === 409)!;
    expect(await refused.text()).toContain('If you clicked twice');
    // The first response may have given the browser a valid cookie; clearing would drop it.
    expect(refused.headers.getSetCookie()).toEqual([]);

    // A miss from the 409 would make the fourth of these the fifth in a row, and locked.
    for (let attempt = 1; attempt <= 4; attempt++) {
      expect(
        (await web('/web/login', { form: { username: 'bob', password: 'typo' } })).status
      ).toBe(401);
    }
    await login({ username: 'bob', password: 'a-new-password' });
  });

  it('refuses the change when an admin reset lands while it is being saved', async () => {
    const resetHash = await hashPassword('admin-reset-pass');
    const cookie = cookieFor(bob);
    const realScrypt = crypto.scrypt;
    let calls = 0;
    const scrypt = vi.spyOn(crypto, 'scrypt').mockImplementation(((...args: unknown[]) => {
      // The first scrypt checks the current password, the second hashes the new one: the
      // admin's reset lands between them.
      if (++calls === 2) db.setUserPassword(bob.id, resetHash);
      return (realScrypt as (...params: unknown[]) => void)(...args);
    }) as typeof crypto.scrypt);
    let res: Response;
    try {
      res = await changePassword(cookie, {
        current: USER_PASSWORD,
        password: 'user-new-pass',
        confirm: 'user-new-pass',
      });
    } finally {
      scrypt.mockRestore();
    }
    expect(res.status).toBe(409);
    expect(await res.text()).toContain('this request changed nothing');
    expect(res.headers.getSetCookie()).toEqual(['tg_auth=; Max-Age=0; HttpOnly; SameSite=Strict']);
    expect(db.getUserById(bob.id)?.passwordHash).toBe(resetHash);
    expect(await listStatus(cookie)).toBe(303);
    await login({ username: 'bob', password: 'admin-reset-pass' });
  });
});
