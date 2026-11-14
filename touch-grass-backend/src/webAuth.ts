/**
 * Web UI auth and hardening: the signed session cookie and the principal (admin or user) it
 * signs in, login backoff, security headers and the cross-origin POST check. Routes, and the
 * database lookups behind a principal, live in webRoutes.ts.
 */

import crypto from 'crypto';
import type { Request, RequestHandler, Response } from 'express';
import net from 'net';
import { errorPage, webRootFor } from './webViews.js';

export const WEB_COOKIE_NAME = 'tg_auth';
const WEB_SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

/** The principal id in the admin's cookies; a user's cookies carry the user's 32-hex id. */
export const ADMIN_PRINCIPAL_ID = 'admin';

const COOKIE_VERSION = 'v2';
const COOKIE_KEY_LABEL = 'touch-grass-web-cookie-v1';
const COOKIE_PATTERN = /^v2\.(admin|[0-9a-f]{32})\.(\d{1,16})\.([A-Za-z0-9_-]{43})$/;

/** Who a signed-in browser is. The admin sees every session, a user only those with its token. */
export type WebPrincipal =
  | { role: 'admin'; username: string }
  | { role: 'user'; id: string; username: string; token: string };

declare module 'express-serve-static-core' {
  interface Request {
    /** Set by requireWebAuth for every route registered after it. */
    webUser?: WebPrincipal;
    /**
     * The binding webUser's cookie verified against. A route that waits before acting can
     * compare it with the current one, since by then the password may have changed.
     */
    webBinding?: string;
  }
}

/** A principal plus the binding its cookies are signed over. */
export interface ResolvedPrincipal {
  principal: WebPrincipal;
  binding: string;
}

/** Looks up a cookie's principal id; undefined when nobody has it (a deleted user). */
export type PrincipalResolver = (principalId: string) => ResolvedPrincipal | undefined;

// ── Signed cookie ──
//
// The cookie is `v2.<principal id>.<expiry ms>.<base64url HMAC>`: nothing is stored server-side,
// so it survives restarts. The key comes from WEB_PASSWORD, so changing it revokes every cookie
// at once. The MAC also covers a binding the cookie doesn't carry, looked up on every request:
// a user's password hash, so a password change or reset revokes that user's cookies, and the
// admin's name, so a new WEB_ADMIN_USERNAME revokes the admin's. v1 cookies, which carried no
// principal, don't match the pattern and send their browser back to the login page.

export function deriveCookieKey(webPassword: string): Buffer {
  return crypto.createHmac('sha256', webPassword).update(COOKIE_KEY_LABEL).digest();
}

/** Letter case doesn't count, the same as at login. */
export function adminBinding(adminUsername: string): string {
  return `admin:${adminUsername.toLowerCase()}`;
}

export function userBinding(passwordHash: string): string {
  return `user:${passwordHash}`;
}

export function principalIdOf(principal: WebPrincipal): string {
  return principal.role === 'admin' ? ADMIN_PRINCIPAL_ID : principal.id;
}

function cookieMac(key: Buffer, payload: string, binding: string): string {
  // The payload can't hold a line break, so the separator keeps payload and binding apart.
  return crypto.createHmac('sha256', key).update(`${payload}\n${binding}`).digest('base64url');
}

export function signWebCookie(
  key: Buffer,
  principalId: string,
  binding: string,
  expiresAtMs: number
): string {
  const payload = `${COOKIE_VERSION}.${principalId}.${expiresAtMs}`;
  return `${payload}.${cookieMac(key, payload, binding)}`;
}

/**
 * The principal a cookie signs in, with the binding it verified against, or null when the cookie
 * is malformed, expired, revoked or forged.
 */
export function verifyWebCookie(
  key: Buffer,
  token: string,
  resolve: PrincipalResolver,
  nowMs = Date.now()
): ResolvedPrincipal | null {
  const match = COOKIE_PATTERN.exec(token);
  if (!match) return null;
  const [, principalId, expiresAt, mac] = match;
  if (Number(expiresAt) <= nowMs) return null;
  const resolved = resolve(principalId);
  if (!resolved) return null;
  // Compare the canonical encodings: decoding first would accept variants of the last
  // base64url character that differ only in its unused low bits.
  const expected = Buffer.from(
    cookieMac(key, `${COOKIE_VERSION}.${principalId}.${expiresAt}`, resolved.binding)
  );
  return crypto.timingSafeEqual(Buffer.from(mac), expected) ? resolved : null;
}

function cookieValues(header: string | undefined, name: string): string[] {
  if (!header) return [];
  const values: string[] = [];
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq !== -1 && part.slice(0, eq).trim() === name) {
      values.push(part.slice(eq + 1).trim());
    }
  }
  return values;
}

function signedInPrincipal(
  req: Request,
  key: Buffer,
  resolve: PrincipalResolver
): ResolvedPrincipal | null {
  // A browser can hold several cookies of this name (another path, or one left by an older
  // backend); the first valid one wins.
  for (const token of cookieValues(req.headers.cookie, WEB_COOKIE_NAME)) {
    const signedIn = verifyWebCookie(key, token, resolve);
    if (signedIn) return signedIn;
  }
  return null;
}

function cookieHeader(req: Request, value: string, maxAgeSeconds: number): string {
  // No Path attribute on purpose: the browser defaults it to the directory of the URL that set
  // it (…/web for POST …/web/login), which stays right under any reverse-proxy path prefix. So
  // only routes directly under the web root may set or clear it; one deeper would store a second
  // cookie beside this one, which logout misses.
  const attributes = [
    `${WEB_COOKIE_NAME}=${value}`,
    `Max-Age=${maxAgeSeconds}`,
    'HttpOnly',
    'SameSite=Strict',
  ];
  // req.secure follows X-Forwarded-Proto only when TRUST_PROXY trusts the proxy.
  if (req.secure) attributes.push('Secure');
  return attributes.join('; ');
}

export function issueSessionCookie(
  req: Request,
  res: Response,
  key: Buffer,
  principalId: string,
  binding: string
): void {
  const token = signWebCookie(
    key,
    principalId,
    binding,
    Date.now() + WEB_SESSION_MAX_AGE_SECONDS * 1000
  );
  res.setHeader('Set-Cookie', cookieHeader(req, token, WEB_SESSION_MAX_AGE_SECONDS));
}

export function clearSessionCookie(req: Request, res: Response): void {
  res.setHeader('Set-Cookie', cookieHeader(req, '', 0));
}

/** Constant-time check against WEB_PASSWORD; the digests keep the length from leaking. */
export function createPasswordCheck(expected: string): (candidate: unknown) => boolean {
  const digest = (text: string) => crypto.createHash('sha256').update(text, 'utf8').digest();
  const expectedDigest = digest(expected);
  return candidate =>
    typeof candidate === 'string' && crypto.timingSafeEqual(digest(candidate), expectedDigest);
}

// ── Where to go after login ──

const RETURN_TO_PATTERN = /^(?:sessions\/[0-9a-f]{1,64}|account|admin)?$/;

/**
 * Only '' (the session list), 'sessions/<hex id>', 'account' and 'admin' are allowed, so `next`
 * can't redirect off-site.
 */
export function parseReturnTo(raw: unknown): string {
  return typeof raw === 'string' && RETURN_TO_PATTERN.test(raw) ? raw : '';
}

function returnToFor(routerPath: string): string {
  const session = /^\/sessions\/([0-9a-f]{1,64})(?:\/|$)/.exec(routerPath);
  if (session) return `sessions/${session[1]}`;
  // A signed-out form post under /admin/users/… comes back to the admin page.
  const page = /^\/(account|admin)(?:\/|$)/.exec(routerPath);
  return page ? page[1] : '';
}

function loginUrl(routerPath: string, returnTo: string): string {
  const query = returnTo ? `?next=${encodeURIComponent(returnTo)}` : '';
  return `${webRootFor(routerPath)}login${query}`;
}

export interface RequireWebAuthOptions {
  cookieKey: Buffer;
  /** Injected, so this module stays free of the database. */
  resolve: PrincipalResolver;
}

/**
 * Lets requests with a valid cookie through and puts its principal on `req.webUser`, its binding
 * on `req.webBinding`. Others get a JSON 401 under /api/ (the pollers turn that into a trip to the
 * login page) or a redirect to the login page that comes back to the page they were on.
 */
export function createRequireWebAuth({
  cookieKey,
  resolve,
}: RequireWebAuthOptions): RequestHandler {
  return (req, res, next) => {
    const signedIn = signedInPrincipal(req, cookieKey, resolve);
    if (signedIn) {
      req.webUser = signedIn.principal;
      req.webBinding = signedIn.binding;
      next();
      return;
    }
    if (req.path.startsWith('/api/')) {
      res.status(401).json({ error: 'Not signed in' });
      return;
    }
    res.redirect(303, loginUrl(req.path, returnToFor(req.path)));
  };
}

// ── Login backoff ──

/** The consecutive wrong password that starts the first 1 s lock. */
const LOCK_AFTER_FAILURES = 5;
const MAX_LOCK_MS = 60_000;
/** A client that stays quiet this long starts over. Longer than MAX_LOCK_MS. */
const FAILURE_MEMORY_MS = 15 * 60_000;
const PRUNE_INTERVAL_MS = 60_000;
/** Bounds memory when many addresses fail; the stalest entries go first. */
const MAX_TRACKED_CLIENTS = 10_000;

/**
 * The password a guess was checked against: WEB_PASSWORD, or one user's (by name, letter case
 * aside). Kept apart by kind, so a user whose name matches the admin's (WEB_ADMIN_USERNAME was
 * changed onto it) proves only their own password.
 */
export type LoginTarget = { role: 'admin' } | { role: 'user'; username: string };

export interface LoginLimiter {
  /** Seconds this client must still wait, or 0 when it may try. */
  lockedFor(clientKey: string): number;
  /**
   * Records a wrong password for `target`; returns the lock it triggered in seconds (0 for
   * none).
   */
  recordFailure(clientKey: string, target: LoginTarget): number;
  /** Records `target`'s correct password. */
  recordSuccess(clientKey: string, target: LoginTarget): void;
  trackedClients(): number;
}

interface FailureRecord {
  failures: number;
  lockedUntil: number;
  lastFailureAt: number;
  /** targetDigest of every failure so far, or null once they cover two targets. */
  target: string | null;
}

/**
 * Fixed-size, so a record costs the same whatever name was typed: the login form takes up to
 * 16 KB, and MAX_TRACKED_CLIENTS records of that would hold on to over 150 MB.
 */
function targetDigest(target: LoginTarget): string {
  const label = target.role === 'admin' ? 'admin' : `user:${target.username.toLowerCase()}`;
  return crypto.createHash('sha256').update(label, 'utf8').digest('base64url');
}

/**
 * Per-client backoff: the LOCK_AFTER_FAILURES-th wrong password in a row locks the client for
 * 1 s, and each further one doubles that (2 s, 4 s…) up to 60 s. A correct password clears the
 * record only when every miss in it was for that same target: it proves that one password, and
 * says nothing about guesses at the admin's or another user's.
 */
export function createLoginLimiter(now: () => number = Date.now): LoginLimiter {
  const clients = new Map<string, FailureRecord>();
  let lastPruneAt = 0;

  function prune(nowMs: number): void {
    if (nowMs - lastPruneAt >= PRUNE_INTERVAL_MS) {
      lastPruneAt = nowMs;
      for (const [clientKey, record] of clients) {
        if (nowMs - record.lastFailureAt > FAILURE_MEMORY_MS) clients.delete(clientKey);
      }
    }
    // Records are re-inserted on every failure, so insertion order is staleness order.
    for (const clientKey of clients.keys()) {
      if (clients.size <= MAX_TRACKED_CLIENTS) break;
      clients.delete(clientKey);
    }
  }

  return {
    lockedFor(clientKey) {
      const record = clients.get(clientKey);
      if (!record) return 0;
      return Math.max(0, Math.ceil((record.lockedUntil - now()) / 1000));
    },

    recordFailure(clientKey, target) {
      const nowMs = now();
      const digest = targetDigest(target);
      const stored = clients.get(clientKey);
      const previous =
        stored && nowMs - stored.lastFailureAt <= FAILURE_MEMORY_MS ? stored : undefined;
      const failures = previous ? previous.failures + 1 : 1;
      const lockMs =
        failures >= LOCK_AFTER_FAILURES
          ? Math.min(1000 * 2 ** (failures - LOCK_AFTER_FAILURES), MAX_LOCK_MS)
          : 0;
      clients.delete(clientKey);
      clients.set(clientKey, {
        failures,
        lockedUntil: nowMs + lockMs,
        lastFailureAt: nowMs,
        target: !previous || previous.target === digest ? digest : null,
      });
      prune(nowMs);
      return Math.ceil(lockMs / 1000);
    },

    recordSuccess(clientKey, target) {
      if (clients.get(clientKey)?.target === targetDigest(target)) {
        clients.delete(clientKey);
      }
    },

    trackedClients() {
      return clients.size;
    },
  };
}

export interface LoginQueue {
  /** Runs `check` once every earlier check for this client has settled. */
  run<T>(clientKey: string, check: () => Promise<T>): Promise<T>;
  /** Clients with a check running or waiting. */
  queuedClients(): number;
}

/**
 * One password check at a time per client. A check awaits scrypt between reading lockedFor and
 * recording its failure, so a burst of parallel guesses would otherwise all pass lockedFor and
 * all get checked before the first one locked the client.
 */
export function createLoginQueue(): LoginQueue {
  const tails = new Map<string, Promise<unknown>>();
  return {
    run(clientKey, check) {
      const outcome = (tails.get(clientKey) ?? Promise.resolve()).then(() => check());
      // The next check waits for this one whichever way it settles.
      const tail = outcome.catch(() => undefined);
      tails.set(clientKey, tail);
      void tail.then(() => {
        if (tails.get(clientKey) === tail) tails.delete(clientKey);
      });
      return outcome;
    },

    queuedClients() {
      return tails.size;
    },
  };
}

function ipv6Prefix64(address: string): string {
  const [head, tail] = address.split('::');
  const groupsOf = (part: string | undefined) => (part ? part.split(':') : []);
  const headGroups = groupsOf(head);
  const tailGroups = groupsOf(tail);
  // A dotted IPv4 tail (::ffff:1.2.3.4 style) fills two 16-bit groups.
  const tailWidth = tailGroups.reduce((width, group) => width + (group.includes('.') ? 2 : 1), 0);
  const zeros =
    tail === undefined ? [] : Array<string>(8 - headGroups.length - tailWidth).fill('0');
  const prefix = [...headGroups, ...zeros, ...tailGroups]
    .slice(0, 4)
    .map(group => parseInt(group, 16).toString(16));
  return `${prefix.join(':')}::/64`;
}

/**
 * The backoff record a client address counts against. An IPv6 client usually holds a whole /64
 * and can pick a fresh address for every try, so the /64 shares one record; IPv4-mapped IPv6
 * addresses (dual-stack listeners) count as the IPv4 address they carry.
 */
export function loginClientKey(ip: string | undefined): string {
  if (!ip) return 'unknown';
  const address = ip.split('%')[0];
  if (!net.isIPv6(address)) return address;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  return mapped ? mapped[1] : ipv6Prefix64(address);
}

// ── Headers and cross-origin checks ──

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "img-src 'self' data:",
  "style-src 'self'",
  "script-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

export const webSecurityHeaders: RequestHandler = (_req, res, next) => {
  res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Not no-referrer: under it browsers send `Origin: null` with every form POST, and
  // rejectCrossOriginWrites would refuse the UI's own forms. same-origin still tells other sites
  // nothing.
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
};

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Sec-Fetch-Site for the UI's own forms; `none` is a navigation the human started. */
const OWN_FETCH_SITES = new Set(['same-origin', 'none']);

function originMatchesHost(origin: string, host: string | undefined): boolean {
  if (!host) return false;
  try {
    const originUrl = new URL(origin);
    if (originUrl.protocol !== 'http:' && originUrl.protocol !== 'https:') return false;
    // Parse the host with the origin's scheme so an explicit default port (:443) compares equal.
    return originUrl.host === new URL(`${originUrl.protocol}//${host}`).host;
  } catch {
    // Includes `Origin: null` from sandboxed frames.
    return false;
  }
}

function refusalMessage(origin: string | undefined, fetchSite: string | undefined): string {
  if (origin === 'null') {
    return (
      'Your browser hid which page sent this form (Origin: null), so it was refused. ' +
      'That happens inside sandboxed frames and with some privacy settings. ' +
      'Open Touch Grass in a tab of its own and try again.'
    );
  }
  if (fetchSite !== undefined) {
    return (
      `This form was sent from another site${origin ? ` (${origin})` : ''}, so it was refused. ` +
      'Open Touch Grass in a tab of its own and try again.'
    );
  }
  return (
    `This form was sent from ${origin}, which is not the site it was posted to. ` +
    'Behind a reverse proxy, pass the original Host header through ' +
    '(nginx: proxy_set_header Host $http_host), or set X-Forwarded-Host and TRUST_PROXY.'
  );
}

/**
 * Backstop to SameSite=Strict for state-changing requests. Browsers that send Sec-Fetch-Site
 * (over HTTPS and on localhost) are judged by it alone, so a proxy that rewrites Host doesn't
 * matter there. Otherwise an Origin, when present, has to match the Host; `req.host` reads
 * X-Forwarded-Host only when TRUST_PROXY trusts the proxy. Requests with neither header (old
 * browsers, curl) pass.
 */
export const rejectCrossOriginWrites: RequestHandler = (req, res, next) => {
  if (SAFE_METHODS.has(req.method)) {
    next();
    return;
  }
  const fetchSite = req.get('sec-fetch-site');
  const origin = req.get('origin');
  const allowed =
    fetchSite !== undefined
      ? OWN_FETCH_SITES.has(fetchSite)
      : origin === undefined || originMatchesHost(origin, req.host);
  if (allowed) {
    next();
    return;
  }
  console.warn(
    `Refused ${req.method} ${req.originalUrl}: Origin ${origin ?? '(none)'}, ` +
      `Sec-Fetch-Site ${fetchSite ?? '(none)'}, host ${req.host ?? '(none)'}`
  );
  res
    .status(403)
    .type('html')
    .send(
      errorPage({
        base: webRootFor(req.path),
        title: 'Request refused',
        message: refusalMessage(origin, fetchSite),
      })
    );
};
