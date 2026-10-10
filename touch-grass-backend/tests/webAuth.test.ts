import { describe, expect, it } from 'vitest';
import {
  createLoginLimiter,
  createPasswordCheck,
  deriveCookieKey,
  loginClientKey,
  parseReturnTo,
  signWebCookie,
  verifyWebCookie,
} from '../src/webAuth.js';

const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

describe('signed web cookie', () => {
  const key = deriveCookieKey('correct horse');
  const nowMs = 1_800_000_000_000;

  it('verifies until its expiry', () => {
    const token = signWebCookie(key, nowMs + 1000);
    expect(token).toMatch(/^v1\.1800000001000\.[A-Za-z0-9_-]{43}$/);
    expect(verifyWebCookie(key, token, nowMs)).toBe(true);
    expect(verifyWebCookie(key, token, nowMs + 1000)).toBe(false);
  });

  it('rejects a moved expiry, another key, and malformed tokens', () => {
    const token = signWebCookie(key, nowMs + 1000);
    expect(verifyWebCookie(key, token.replace('1800000001000', '1900000001000'), nowMs)).toBe(
      false
    );
    expect(verifyWebCookie(deriveCookieKey('battery staple'), token, nowMs)).toBe(false);
    for (const malformed of ['', 'v1', 'v2.1.abc', `${token}x`, token.replace('v1.', 'v1..')]) {
      expect(verifyWebCookie(key, malformed, nowMs)).toBe(false);
    }
  });

  it('rejects a MAC that differs only in the unused bits of its last character', () => {
    const token = signWebCookie(key, nowMs + 1000);
    const last = token.at(-1)!;
    // 43 base64url characters carry 258 bits for a 256-bit MAC; flipping the lowest bit of the
    // last character decodes to the same bytes, so only a string comparison catches it.
    const twin = BASE64URL[BASE64URL.indexOf(last) ^ 1];
    expect(Buffer.from(token.slice(-43), 'base64url')).toEqual(
      Buffer.from(token.slice(-43, -1) + twin, 'base64url')
    );
    expect(verifyWebCookie(key, token.slice(0, -1) + twin, nowMs)).toBe(false);
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
      const lock = limiter.recordFailure('1.2.3.4');
      locks.push(lock);
      advance(lock * 1000);
    }
    expect(locks).toEqual([0, 0, 0, 0, 1, 2, 4, 8, 16, 32, 60, 60]);
  });

  it('counts down the lock and keeps clients apart', () => {
    const { limiter, advance } = limiterWithClock();
    for (let attempt = 1; attempt <= 6; attempt++) limiter.recordFailure('1.2.3.4');
    expect(limiter.lockedFor('1.2.3.4')).toBe(2);
    expect(limiter.lockedFor('5.6.7.8')).toBe(0);
    advance(1500);
    expect(limiter.lockedFor('1.2.3.4')).toBe(1);
    advance(500);
    expect(limiter.lockedFor('1.2.3.4')).toBe(0);
  });

  it('forgets a client on success', () => {
    const { limiter } = limiterWithClock();
    for (let attempt = 1; attempt <= 5; attempt++) limiter.recordFailure('1.2.3.4');
    limiter.recordSuccess('1.2.3.4');
    expect(limiter.lockedFor('1.2.3.4')).toBe(0);
    expect(limiter.recordFailure('1.2.3.4')).toBe(0);
  });

  it('starts over after 15 quiet minutes and prunes stale clients', () => {
    const { limiter, advance } = limiterWithClock();
    for (let attempt = 1; attempt <= 4; attempt++) limiter.recordFailure('1.2.3.4');
    advance(15 * 60_000 + 1);
    expect(limiter.recordFailure('1.2.3.4')).toBe(0);

    limiter.recordFailure('5.6.7.8');
    expect(limiter.trackedClients()).toBe(2);
    advance(16 * 60_000);
    limiter.recordFailure('9.9.9.9');
    expect(limiter.trackedClients()).toBe(1);
  });
});
