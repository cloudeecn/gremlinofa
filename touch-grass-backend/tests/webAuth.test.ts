import crypto from 'crypto';
import { describe, expect, it } from 'vitest';
import {
  adminBinding,
  createLoginLimiter,
  createLoginQueue,
  createPasswordCheck,
  deriveCookieKey,
  loginClientKey,
  parseReturnTo,
  signWebCookie,
  userBinding,
  verifyWebCookie,
  type LoginTarget,
  type PrincipalResolver,
  type ResolvedPrincipal,
} from '../src/webAuth.js';

const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

const ALICE_ID = 'a'.repeat(32);
const BOB_ID = 'b'.repeat(32);

describe('signed web cookie', () => {
  const key = deriveCookieKey('correct horse');
  const nowMs = 1_800_000_000_000;

  const admin: ResolvedPrincipal = {
    principal: { role: 'admin', username: 'Admin' },
    binding: adminBinding('Admin'),
  };
  const userWith = (id: string, passwordHash: string): ResolvedPrincipal => ({
    principal: { role: 'user', id, username: `user-${id[0]}`, token: `tg_${id[0]}` },
    binding: userBinding(passwordHash),
  });
  const principals = new Map<string, ResolvedPrincipal>([
    ['admin', admin],
    [ALICE_ID, userWith(ALICE_ID, 'scrypt$alice-hash')],
    [BOB_ID, userWith(BOB_ID, 'scrypt$bob-hash')],
  ]);
  const resolve: PrincipalResolver = id => principals.get(id);

  const aliceCookie = () =>
    signWebCookie(key, ALICE_ID, userBinding('scrypt$alice-hash'), nowMs + 1000);

  it('signs in the admin until the expiry', () => {
    const token = signWebCookie(key, 'admin', adminBinding('Admin'), nowMs + 1000);
    expect(token).toMatch(/^v2\.admin\.1800000001000\.[A-Za-z0-9_-]{43}$/);
    expect(verifyWebCookie(key, token, resolve, nowMs)).toEqual(admin);
    expect(verifyWebCookie(key, token, resolve, nowMs + 1000)).toBeNull();
  });

  it('signs in a user by id', () => {
    const token = aliceCookie();
    expect(token.startsWith(`v2.${ALICE_ID}.`)).toBe(true);
    expect(verifyWebCookie(key, token, resolve, nowMs)).toEqual(principals.get(ALICE_ID));
  });

  it('ignores the letter case of the admin name in the binding', () => {
    expect(adminBinding('ADMIN')).toBe(adminBinding('admin'));
    expect(adminBinding('Boss')).not.toBe(adminBinding('Admin'));
  });

  it('rejects a cookie whose binding changed: a new password, or another admin name', () => {
    const token = aliceCookie();
    const newPassword = (id: string) =>
      id === ALICE_ID ? userWith(ALICE_ID, 'scrypt$new-hash') : resolve(id);
    expect(verifyWebCookie(key, token, newPassword, nowMs)).toBeNull();

    const adminToken = signWebCookie(key, 'admin', adminBinding('Admin'), nowMs + 1000);
    const renamedAdmin = (id: string) =>
      id === 'admin'
        ? { principal: { role: 'admin' as const, username: 'Boss' }, binding: adminBinding('Boss') }
        : undefined;
    expect(verifyWebCookie(key, adminToken, renamedAdmin, nowMs)).toBeNull();
  });

  it('rejects a cookie whose principal no longer exists', () => {
    expect(verifyWebCookie(key, aliceCookie(), () => undefined, nowMs)).toBeNull();
  });

  it('rejects a swapped principal, even one with the same binding', () => {
    const swapped = aliceCookie().replace(ALICE_ID, BOB_ID);
    expect(verifyWebCookie(key, swapped, resolve, nowMs)).toBeNull();
    const sameHash = (id: string) => userWith(id, 'scrypt$alice-hash');
    expect(verifyWebCookie(key, swapped, sameHash, nowMs)).toBeNull();
    // A user cookie edited to say admin doesn't verify against the admin binding either.
    expect(
      verifyWebCookie(key, aliceCookie().replace(ALICE_ID, 'admin'), resolve, nowMs)
    ).toBeNull();
  });

  it('rejects a moved expiry and another key', () => {
    const token = aliceCookie();
    expect(
      verifyWebCookie(key, token.replace('1800000001000', '1900000001000'), resolve, nowMs)
    ).toBeNull();
    expect(verifyWebCookie(deriveCookieKey('battery staple'), token, resolve, nowMs)).toBeNull();
  });

  it('rejects a v1 cookie that was valid before the upgrade', () => {
    const payload = `v1.${nowMs + 1000}`;
    const v1 = `${payload}.${crypto.createHmac('sha256', key).update(payload).digest('base64url')}`;
    expect(verifyWebCookie(key, v1, resolve, nowMs)).toBeNull();
  });

  it('rejects malformed tokens', () => {
    const token = aliceCookie();
    for (const malformed of [
      '',
      'v1',
      'v2.1.abc',
      `v2.admin.${nowMs + 1000}`,
      `${token}x`,
      token.replace('v2.', 'v2..'),
      token.replace('v2.', 'v3.'),
      token.replace(ALICE_ID, ALICE_ID.toUpperCase()),
      token.replace(ALICE_ID, ALICE_ID.slice(1)),
      signWebCookie(key, 'Admin', adminBinding('Admin'), nowMs + 1000),
    ]) {
      expect(verifyWebCookie(key, malformed, resolve, nowMs)).toBeNull();
    }
  });

  it('rejects a MAC that differs only in the unused bits of its last character', () => {
    const token = aliceCookie();
    const last = token.at(-1)!;
    // 43 base64url characters carry 258 bits for a 256-bit MAC; flipping the lowest bit of the
    // last character decodes to the same bytes, so only a string comparison catches it.
    const twin = BASE64URL[BASE64URL.indexOf(last) ^ 1];
    expect(Buffer.from(token.slice(-43), 'base64url')).toEqual(
      Buffer.from(token.slice(-43, -1) + twin, 'base64url')
    );
    expect(verifyWebCookie(key, token.slice(0, -1) + twin, resolve, nowMs)).toBeNull();
  });

  it('derives a different key for each password', () => {
    expect(deriveCookieKey('a').equals(deriveCookieKey('b'))).toBe(false);
    expect(deriveCookieKey('a').equals(deriveCookieKey('a'))).toBe(true);
  });
});

describe('createPasswordCheck', () => {
  it('matches only the exact string', () => {
    const matches = createPasswordCheck('pässwörd');
    expect(matches('pässwörd')).toBe(true);
    expect(matches('passwörd')).toBe(false);
    expect(matches('pässwörd ')).toBe(false);
    expect(matches(undefined)).toBe(false);
    expect(matches(['pässwörd'])).toBe(false);
  });
});

describe('parseReturnTo', () => {
  it.each([
    ['', ''],
    ['sessions/0123456789abcdef', 'sessions/0123456789abcdef'],
    ['account', 'account'],
    ['admin', 'admin'],
    ['Admin', ''],
    ['admin/users', ''],
    ['account/password', ''],
    ['adminx', ''],
    ['sessions/', ''],
    ['sessions/ABC', ''],
    ['sessions/abc/respond', ''],
    ['/sessions/abc', ''],
    ['//evil.example', ''],
    ['https://evil.example', ''],
    [undefined, ''],
    [['sessions/abc'], ''],
  ])('%j → %j', (raw, expected) => {
    expect(parseReturnTo(raw)).toBe(expected);
  });
});

describe('loginClientKey', () => {
  it.each([
    ['192.0.2.1', '192.0.2.1'],
    ['::ffff:192.0.2.1', '192.0.2.1'],
    ['::FFFF:192.0.2.1', '192.0.2.1'],
    ['2001:db8:1:2:aaaa:bbbb:cccc:dddd', '2001:db8:1:2::/64'],
    ['2001:0DB8:0001:0002::1', '2001:db8:1:2::/64'],
    ['2001:db8::1', '2001:db8:0:0::/64'],
    ['2001:db8:1:2:3:4:192.0.2.1', '2001:db8:1:2::/64'],
    ['64:ff9b::192.0.2.1', '64:ff9b:0:0::/64'],
    ['::1', '0:0:0:0::/64'],
    ['fe80::1%eth0', 'fe80:0:0:0::/64'],
    [undefined, 'unknown'],
  ])('%s → %s', (ip, expected) => {
    expect(loginClientKey(ip)).toBe(expected);
  });

  it('puts every address of one /64 under one key', () => {
    expect(loginClientKey('2001:db8:1:2::1')).toBe(loginClientKey('2001:db8:1:2:ffff::9'));
    expect(loginClientKey('2001:db8:1:2::1')).not.toBe(loginClientKey('2001:db8:1:3::1'));
  });
});

describe('createLoginLimiter', () => {
  const ADMIN: LoginTarget = { role: 'admin' };
  const user = (username: string): LoginTarget => ({ role: 'user', username });

  function limiterWithClock() {
    let nowMs = 1_000_000;
    const limiter = createLoginLimiter(() => nowMs);
    return {
      limiter,
      advance: (ms: number) => {
        nowMs += ms;
      },
    };
  }

  it('allows four misses, then locks for 1 s, 2 s, 4 s… up to 60 s', () => {
    const { limiter, advance } = limiterWithClock();
    const locks: number[] = [];
    for (let attempt = 1; attempt <= 12; attempt++) {
      const lock = limiter.recordFailure('1.2.3.4', ADMIN);
      locks.push(lock);
      advance(lock * 1000);
    }
    expect(locks).toEqual([0, 0, 0, 0, 1, 2, 4, 8, 16, 32, 60, 60]);
  });

  it('counts down the lock and keeps clients apart', () => {
    const { limiter, advance } = limiterWithClock();
    for (let attempt = 1; attempt <= 6; attempt++) limiter.recordFailure('1.2.3.4', ADMIN);
    expect(limiter.lockedFor('1.2.3.4')).toBe(2);
    expect(limiter.lockedFor('5.6.7.8')).toBe(0);
    advance(1500);
    expect(limiter.lockedFor('1.2.3.4')).toBe(1);
    advance(500);
    expect(limiter.lockedFor('1.2.3.4')).toBe(0);
  });

  it('forgets a client when the target its misses were for signs in, in any letter case', () => {
    const { limiter } = limiterWithClock();
    for (let attempt = 1; attempt <= 5; attempt++) limiter.recordFailure('1.2.3.4', user('Bob'));
    limiter.recordSuccess('1.2.3.4', user('bob'));
    expect(limiter.lockedFor('1.2.3.4')).toBe(0);
    expect(limiter.recordFailure('1.2.3.4', user('bob'))).toBe(0);

    for (let attempt = 1; attempt <= 5; attempt++) limiter.recordFailure('5.6.7.8', ADMIN);
    limiter.recordSuccess('5.6.7.8', ADMIN);
    expect(limiter.lockedFor('5.6.7.8')).toBe(0);
    expect(limiter.recordFailure('5.6.7.8', ADMIN)).toBe(0);
  });

  it("keeps the misses when another name signs in, so it can't reset guesses at the admin", () => {
    const { limiter } = limiterWithClock();
    for (let attempt = 1; attempt <= 4; attempt++) limiter.recordFailure('1.2.3.4', ADMIN);
    limiter.recordSuccess('1.2.3.4', user('mallory'));
    expect(limiter.recordFailure('1.2.3.4', ADMIN)).toBe(1);
  });

  it("keeps guesses at the admin when a user who holds the admin's name signs in", () => {
    const { limiter } = limiterWithClock();
    for (let attempt = 1; attempt <= 4; attempt++) limiter.recordFailure('1.2.3.4', ADMIN);
    limiter.recordSuccess('1.2.3.4', user('admin'));
    expect(limiter.recordFailure('1.2.3.4', ADMIN)).toBe(1);
  });

  it('keeps misses that cover two names, even when one of them signs in', () => {
    const { limiter } = limiterWithClock();
    limiter.recordFailure('1.2.3.4', ADMIN);
    for (let attempt = 1; attempt <= 3; attempt++) {
      limiter.recordFailure('1.2.3.4', user('mallory'));
    }
    limiter.recordSuccess('1.2.3.4', user('mallory'));
    expect(limiter.recordFailure('1.2.3.4', user('mallory'))).toBe(1);
  });

  it('compares long names whole', () => {
    // The login form takes up to 16 KB; records keep a digest instead of the name.
    const { limiter } = limiterWithClock();
    const long = 'a'.repeat(16_000);
    limiter.recordFailure('1.2.3.4', user(long));
    limiter.recordSuccess('1.2.3.4', user(long.slice(1)));
    expect(limiter.trackedClients()).toBe(1);
    limiter.recordSuccess('1.2.3.4', user(long.toUpperCase()));
    expect(limiter.trackedClients()).toBe(0);
  });

  it('judges the names afresh once the client has been quiet for 15 minutes', () => {
    const { limiter, advance } = limiterWithClock();
    limiter.recordFailure('1.2.3.4', ADMIN);
    advance(15 * 60_000 + 1);
    limiter.recordFailure('1.2.3.4', user('bob'));
    limiter.recordSuccess('1.2.3.4', user('bob'));
    expect(limiter.trackedClients()).toBe(0);
  });

  it('starts over after 15 quiet minutes and prunes stale clients', () => {
    const { limiter, advance } = limiterWithClock();
    for (let attempt = 1; attempt <= 4; attempt++) limiter.recordFailure('1.2.3.4', ADMIN);
    advance(15 * 60_000 + 1);
    expect(limiter.recordFailure('1.2.3.4', ADMIN)).toBe(0);

    limiter.recordFailure('5.6.7.8', ADMIN);
    expect(limiter.trackedClients()).toBe(2);
    advance(16 * 60_000);
    limiter.recordFailure('9.9.9.9', ADMIN);
    expect(limiter.trackedClients()).toBe(1);
  });
});

describe('createLoginQueue', () => {
  function deferred() {
    let release!: () => void;
    const promise = new Promise<void>(resolve => {
      release = resolve;
    });
    return { promise, release };
  }

  it('runs one check at a time per client, in arrival order', async () => {
    const queue = createLoginQueue();
    const events: string[] = [];
    const gate = deferred();
    const first = queue.run('1.2.3.4', async () => {
      events.push('first starts');
      await gate.promise;
      events.push('first ends');
    });
    const second = queue.run('1.2.3.4', async () => {
      events.push('second starts');
    });
    await new Promise(resolve => setImmediate(resolve));
    expect(events).toEqual(['first starts']);
    gate.release();
    await Promise.all([first, second]);
    expect(events).toEqual(['first starts', 'first ends', 'second starts']);
  });

  it('lets other clients through while one waits', async () => {
    const queue = createLoginQueue();
    const gate = deferred();
    const slow = queue.run('1.2.3.4', () => gate.promise);
    expect(await queue.run('5.6.7.8', async () => 'other')).toBe('other');
    gate.release();
    await slow;
  });

  it('keeps going after a check throws, and forgets clients once they are done', async () => {
    const queue = createLoginQueue();
    const failed = queue.run('1.2.3.4', async () => {
      throw new Error('boom');
    });
    const next = queue.run('1.2.3.4', async () => 'ran');
    expect(queue.queuedClients()).toBe(1);
    await expect(failed).rejects.toThrow('boom');
    expect(await next).toBe('ran');
    await new Promise(resolve => setImmediate(resolve));
    expect(queue.queuedClients()).toBe(0);
  });
});
