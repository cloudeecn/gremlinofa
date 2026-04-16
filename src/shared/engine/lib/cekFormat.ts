/**
 * Pure CEK string ↔ bytes helpers + format detection.
 *
 * The CEK is a 256-bit AES key persisted as either base32 (RFC 4648,
 * lowercase, no padding — the format new keys are minted in) or base64
 * (legacy format from before the base32 migration). Both are 32-byte
 * payloads; only the encoding differs.
 *
 * These helpers are pure: no I/O, no global state, safe to call from any
 * thread (main or worker). The frontend uses them in three places:
 *
 *   1. `bootstrapClient.ts` decodes the localStorage-stored CEK to bytes
 *      before posting it through `gremlinClient.init`.
 *   2. OOBE generates a new CEK with `crypto.getRandomValues`, encodes it
 *      to base32 with `bytesToBase32`, and persists the string.
 *   3. The Data Manager exposes a base64 → base32 conversion button when
 *      a legacy CEK is detected via `isCEKBase32`.
 */

const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

/** True iff the string contains only base32 characters (a-z, 2-7). */
export function isBase32(str: string): boolean {
  const normalized = str.toLowerCase().replace(/\s/g, '');
  return /^[a-z2-7]+$/.test(normalized);
}

/** Encode a Uint8Array to base32 (lowercase, no padding). */
export function bytesToBase32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let result = '';

  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | bytes[i];
    bits += 8;

    while (bits >= 5) {
      bits -= 5;
      result += BASE32_ALPHABET[(value >>> bits) & 0x1f];
    }
  }

  if (bits > 0) {
    result += BASE32_ALPHABET[(value << (5 - bits)) & 0x1f];
  }

  return result;
}

/** Decode a base32 string (case-insensitive, whitespace-tolerant) to bytes. */
export function base32ToBytes(base32: string): Uint8Array {
  const normalized = base32.toLowerCase().replace(/\s/g, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];

  for (let i = 0; i < normalized.length; i++) {
    const char = normalized[i];
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx === -1) {
      throw new Error(`Invalid base32 character: ${char}`);
    }

    value = (value << 5) | idx;
    bits += 5;

    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 0xff);
    }
  }

  return new Uint8Array(bytes);
}

/** Encode a Uint8Array to base64. */
export function bytesToBase64(bytes: Uint8Array): string {
  const binaryString = Array.from(bytes, byte => String.fromCharCode(byte)).join('');
  return btoa(binaryString);
}

/** Decode a base64 string to bytes. */
export function base64ToBytes(base64: string): Uint8Array {
  const binaryString = atob(base64);
  return Uint8Array.from(binaryString, char => char.charCodeAt(0));
}

/** Decode a CEK string in either base32 or base64 to its raw 32-byte form. */
export function decodeCEK(encoded: string): Uint8Array {
  const trimmed = encoded.trim();
  return isBase32(trimmed) ? base32ToBytes(trimmed) : base64ToBytes(trimmed);
}

/** Convert a base64-encoded CEK string to base32, preserving the underlying bytes. */
export function convertCEKToBase32(cek: string): string {
  if (isBase32(cek)) return cek;
  return bytesToBase32(base64ToBytes(cek));
}

/** Generate a fresh 32-byte CEK and return its base32 encoding. */
export function generateCEKBase32(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return bytesToBase32(bytes);
}
