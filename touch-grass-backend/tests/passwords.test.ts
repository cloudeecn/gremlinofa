import crypto from 'crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  generateUserToken,
  hashPassword,
  passwordProblem,
  sameUsername,
  usernameProblem,
  verifyPassword,
} from '../src/passwords.js';

afterEach(() => {
  vi.restoreAllMocks();
});

/** Swaps the base64url hash part for one that differs in its first byte. */
function tamper(encoded: string): string {
  const parts = encoded.split('$');
  const hash = Buffer.from(parts[5], 'base64url');
  hash[0] ^= 1;
  parts[5] = hash.toString('base64url');
  return parts.join('$');
}

describe('hashPassword / verifyPassword', () => {
  it('round-trips and stores the parameters with a fresh salt', async () => {
    const encoded = await hashPassword('correct horse');
    expect(encoded).toMatch(/^scrypt\$16384\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{86}$/);
    expect(await verifyPassword('correct horse', encoded)).toBe(true);
    expect(await hashPassword('correct horse')).not.toBe(encoded);
  });

  it('round-trips a non-ASCII password', async () => {
    const encoded = await hashPassword('pässwörd-✓-草');
    expect(await verifyPassword('pässwörd-✓-草', encoded)).toBe(true);
    expect(await verifyPassword('passwort-✓-草', encoded)).toBe(false);
  });

  it('refuses a wrong password, a tampered hash and a missing hash', async () => {
    const encoded = await hashPassword('correct horse');
    expect(await verifyPassword('correct horsf', encoded)).toBe(false);
    expect(await verifyPassword('correct horse', tamper(encoded))).toBe(false);
    expect(await verifyPassword('correct horse', undefined)).toBe(false);
  });

  it('honours the parameters stored with an older hash', async () => {
    const salt = crypto.randomBytes(16);
    const key = crypto.scryptSync('old one', salt, 32, { N: 1024, r: 8, p: 1 });
    const encoded = `scrypt$1024$8$1$${salt.toString('base64url')}$${key.toString('base64url')}`;
    expect(await verifyPassword('old one', encoded)).toBe(true);
    expect(await verifyPassword('old two', encoded)).toBe(false);
  });

  it.each([
    ['empty', ''],
    ['another scheme', 'bcrypt$16384$8$1$c2FsdA$aGFzaA'],
    ['too few parts', 'scrypt$16384$8$1$c2FsdA'],
    ['N not a power of two', 'scrypt$1000$8$1$c2FsdA$aGFzaA'],
    ['a memory cost over the cap', 'scrypt$1048576$8$1$c2FsdA$aGFzaA'],
    ['p over the cap', 'scrypt$16384$8$17$c2FsdA$aGFzaA'],
    ['a non-numeric r', 'scrypt$16384$x$1$c2FsdA$aGFzaA'],
    ['an empty salt', 'scrypt$16384$8$1$$aGFzaA'],
    ['an empty hash', 'scrypt$16384$8$1$c2FsdA$'],
    ['an N OpenSSL refuses for r=1 (N >= 2^16)', 'scrypt$131072$1$1$c2FsdA$aGFzaA'],
  ])('returns false for a malformed hash (%s)', async (_label, encoded) => {
    expect(await verifyPassword('anything', encoded)).toBe(false);
  });

  // p + 2 > N in both, so OpenSSL needs more than 256 * N * r bytes for them.
  it.each([
    [2, 1, 1],
    [16, 1, 16],
  ])('honours a tiny N=%i (r=%i, p=%i)', async (N, r, p) => {
    const salt = crypto.randomBytes(16);
    const key = crypto.scryptSync('tiny', salt, 32, { N, r, p });
    const encoded = `scrypt$${N}$${r}$${p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
    expect(await verifyPassword('tiny', encoded)).toBe(true);
    expect(await verifyPassword('tinz', encoded)).toBe(false);
  });

  it('still fails loudly when scrypt breaks for a reason other than its parameters', async () => {
    const encoded = await hashPassword('correct horse');
    vi.spyOn(crypto, 'scrypt').mockImplementation(((...args: unknown[]) => {
      const callback = args.at(-1) as (err: Error) => void;
      callback(Object.assign(new Error('out of memory'), { code: 'ERR_OUT_OF_MEMORY' }));
    }) as typeof crypto.scrypt);
    await expect(verifyPassword('correct horse', encoded)).rejects.toThrow('out of memory');
  });

  it('runs exactly one scrypt whether or not there is a usable hash', async () => {
    const encoded = await hashPassword('correct horse');
    const scrypt = vi.spyOn(crypto, 'scrypt');
    for (const stored of [encoded, undefined, 'garbage']) {
      scrypt.mockClear();
      await verifyPassword('correct horse', stored);
      expect(scrypt).toHaveBeenCalledTimes(1);
    }
  });
});

describe('passwordProblem', () => {
  it.each([
    ['8 characters', 'a'.repeat(8)],
    ['1024 characters', 'a'.repeat(1024)],
    ['8 emoji, 16 UTF-16 units', '🌱'.repeat(8)],
  ])('accepts %s', (_label, password) => {
    expect(passwordProblem(password)).toBeNull();
  });

  it.each([
    ['empty', '', 'at least 8'],
    ['7 characters', 'a'.repeat(7), 'at least 8'],
    ['7 emoji, 14 UTF-16 units', '🌱'.repeat(7), 'at least 8'],
    ['1025 characters', 'a'.repeat(1025), 'at most 1024'],
  ])('refuses %s', (_label, password, reason) => {
    expect(passwordProblem(password)).toContain(reason);
  });
});

describe('usernameProblem', () => {
  it.each(['bob', 'Bob.Smith', 'night_shift-2', 'a', 'x'.repeat(64)])('accepts %s', username => {
    expect(usernameProblem(username, 'Admin')).toBeNull();
  });

  it.each([
    ['empty', '', 'Enter a username'],
    ['65 characters', 'x'.repeat(65), 'at most 64'],
    ['a space', 'bob smith', 'only letters'],
    ['an at sign', 'bob@example', 'only letters'],
    ['a non-ASCII letter', 'jürgen', 'only letters'],
    ['a colon', 'bob:1', 'only letters'],
  ])('refuses %s', (_label, username, reason) => {
    expect(usernameProblem(username, 'Admin')).toContain(reason);
  });

  it.each(['Admin', 'admin', 'ADMIN'])("refuses the admin's name as %s", username => {
    expect(usernameProblem(username, 'Admin')).toContain('WEB_ADMIN_USERNAME');
  });

  it('compares usernames regardless of case', () => {
    expect(sameUsername('Bob', 'bOB')).toBe(true);
    expect(sameUsername('bob', 'bobby')).toBe(false);
  });
});

describe('generateUserToken', () => {
  it('returns tg_ plus 24 random bytes in base64url', () => {
    const tokens = new Set(Array.from({ length: 50 }, generateUserToken));
    expect(tokens.size).toBe(50);
    for (const token of tokens) {
      expect(token).toMatch(/^tg_[A-Za-z0-9_-]{32}$/);
    }
  });
});
