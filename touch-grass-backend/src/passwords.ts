import crypto from 'crypto';

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 1024;
export const USERNAME_MAX_LENGTH = 64;

const USERNAME_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

/** About 50 ms per hash on a desktop core, 16 MiB of memory. */
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SALT_BYTES = 16;
const KEY_BYTES = 64;

/**
 * Bounds for parameters read back from the database, so a corrupted row can't make one login
 * allocate gigabytes or run for minutes. They leave room to raise the cost later without
 * breaking stored hashes.
 */
const MAX_SCRYPT_MEMORY_BYTES = 256 * 1024 * 1024;
const MAX_SCRYPT_P = 16;
const MAX_KEY_BYTES = 256;

const DUMMY_SALT = Buffer.alloc(SALT_BYTES, 0x5a);

interface ScryptParams {
  N: number;
  r: number;
  p: number;
}

const CURRENT_PARAMS: ScryptParams = { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P };

/** The memory OpenSSL needs for these parameters; it refuses to run when `maxmem` is lower. */
function scryptMemoryBytes({ N, r, p }: ScryptParams): number {
  return 128 * r * (N + p + 2);
}

function scrypt(
  password: string,
  salt: Buffer,
  keyBytes: number,
  params: ScryptParams
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // Node's default 32 MiB cap would refuse a raised N, so the cap follows the parameters;
    // parseHash bounds them.
    crypto.scrypt(
      password,
      salt,
      keyBytes,
      { ...params, maxmem: scryptMemoryBytes(params) },
      (err, key) => (err ? reject(err) : resolve(key))
    );
  });
}

/** `scrypt$N$r$p$<salt>$<hash>`, salt and hash in base64url. */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(SALT_BYTES);
  const key = await scrypt(password, salt, KEY_BYTES, CURRENT_PARAMS);
  return [
    'scrypt',
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString('base64url'),
    key.toString('base64url'),
  ].join('$');
}

interface ParsedHash {
  params: ScryptParams;
  salt: Buffer;
  key: Buffer;
}

function parsePositiveInteger(raw: string): number | null {
  if (!/^[1-9]\d{0,9}$/.test(raw)) return null;
  return Number(raw);
}

function parseHash(encoded: string): ParsedHash | null {
  const parts = encoded.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const N = parsePositiveInteger(parts[1]);
  const r = parsePositiveInteger(parts[2]);
  const p = parsePositiveInteger(parts[3]);
  if (N === null || r === null || p === null || p > MAX_SCRYPT_P) return null;
  // scrypt wants N to be a power of two above 1.
  if (
    N < 2 ||
    !Number.isInteger(Math.log2(N)) ||
    scryptMemoryBytes({ N, r, p }) > MAX_SCRYPT_MEMORY_BYTES
  ) {
    return null;
  }
  const salt = Buffer.from(parts[4], 'base64url');
  const key = Buffer.from(parts[5], 'base64url');
  if (salt.length === 0 || key.length === 0 || key.length > MAX_KEY_BYTES) return null;
  return { params: { N, r, p }, salt, key };
}

/**
 * True when `password` matches `encoded`. Always runs exactly one scrypt: with no hash (an unknown
 * username, or the admin, whose password is checked elsewhere) or a malformed one, it hashes
 * against a fixed salt and returns false, so the response time doesn't tell which names exist.
 */
export async function verifyPassword(
  password: string,
  encoded: string | undefined
): Promise<boolean> {
  const parsed = encoded === undefined ? null : parseHash(encoded);
  const key = parsed && (await scryptUnlessRefused(password, parsed));
  if (!parsed || !key) {
    await scrypt(password, DUMMY_SALT, KEY_BYTES, CURRENT_PARAMS);
    return false;
  }
  return crypto.timingSafeEqual(key, parsed.key);
}

/**
 * The key for a stored hash, or null when OpenSSL refuses its parameters (N >= 2^(16r), say),
 * which parseHash doesn't spell out. Node refuses them before hashing anything, so the dummy
 * scrypt that follows is still the only one that does work.
 */
async function scryptUnlessRefused(password: string, parsed: ParsedHash): Promise<Buffer | null> {
  try {
    return await scrypt(password, parsed.salt, parsed.key.length, parsed.params);
  } catch (err) {
    if ((err as { code?: unknown }).code === 'ERR_CRYPTO_INVALID_SCRYPT_PARAMS') return null;
    throw err;
  }
}

/** Why `password` can't be used, or null when it can. Counts code points, so an emoji is one. */
export function passwordProblem(password: string): string | null {
  const length = Array.from(password).length;
  if (length < PASSWORD_MIN_LENGTH) {
    return `Passwords need at least ${PASSWORD_MIN_LENGTH} characters.`;
  }
  if (length > PASSWORD_MAX_LENGTH) {
    return `Passwords can have at most ${PASSWORD_MAX_LENGTH} characters.`;
  }
  return null;
}

/** Username comparison everywhere: login, the admin-name check, the boot warning. */
export function sameUsername(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** Why `username` can't be given to a user, or null when it can. Callers trim it first. */
export function usernameProblem(username: string, adminUsername: string): string | null {
  if (username === '') {
    return 'Enter a username.';
  }
  if (username.length > USERNAME_MAX_LENGTH) {
    return `Usernames can have at most ${USERNAME_MAX_LENGTH} characters.`;
  }
  if (!USERNAME_PATTERN.test(username)) {
    return 'Usernames can use only letters, digits, dots, underscores and hyphens.';
  }
  if (sameUsername(username, adminUsername)) {
    return 'That name belongs to the admin (WEB_ADMIN_USERNAME).';
  }
  return null;
}

/** The routing token a user hands to the minion tool as `remoteToken`. 192 random bits. */
export function generateUserToken(): string {
  return 'tg_' + crypto.randomBytes(24).toString('base64url');
}
