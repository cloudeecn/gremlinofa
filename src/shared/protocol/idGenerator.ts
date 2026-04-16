/**
 * ID Generation Utility
 * Generates unique IDs with base32-encoded random strings for collision resistance
 */

const BASE32_CHARS = 'abcdefghijklmnopqrstuvwxyz234567';

/**
 * Generate a unique ID with a prefix and base32-encoded random string
 * @param prefix - The prefix for the ID (e.g., 'msg_user', 'chat', 'project')
 * @returns A unique ID like 'prefix_abc7xyz2mnopqrs...' (prefix + 32 char base32)
 *
 * Uses 32 random bytes (160 bits entropy) for astronomical collision resistance
 */
export const generateUniqueId = (prefix: string): string => {
  const randomBytes = crypto.getRandomValues(new Uint8Array(32));

  let result = '';
  for (const byte of randomBytes) {
    result += BASE32_CHARS[byte & 31];
  }

  return `${prefix}_${result}`;
};

/**
 * Position-dependent 10-bit hash over a string.
 * Catches substitution, transposition, and truncation errors.
 */
function computeChecksumBits(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) ^ hash ^ str.charCodeAt(i)) & 0x3ff;
  }
  return hash;
}

/** Encode a 10-bit value as 2 base32 characters. */
function encodeChecksum(bits: number): string {
  return BASE32_CHARS[(bits >> 5) & 31] + BASE32_CHARS[bits & 31];
}

/**
 * Generate a unique ID with a 2-character checksum appended.
 * Resulting format: `prefix_<32 random base32><2 checksum base32>` (34 chars after prefix).
 * Used for IDs that cross an LLM boundary and need copy-error detection.
 */
export function generateChecksummedId(prefix: string): string {
  const baseId = generateUniqueId(prefix);
  return baseId + encodeChecksum(computeChecksumBits(baseId));
}

/**
 * Validate the checksum on an ID produced by generateChecksummedId.
 * - `'valid'`        — checksum present and matches
 * - `'invalid'`      — checksum present but doesn't match (LLM garbled the ID)
 * - `'no_checksum'`  — legacy 32-char ID, skip validation
 */
export function validateIdChecksum(id: string): 'valid' | 'invalid' | 'no_checksum' {
  const underscoreIdx = id.lastIndexOf('_');
  if (underscoreIdx === -1) return 'no_checksum';

  const randomPart = id.substring(underscoreIdx + 1);
  if (randomPart.length <= 32) return 'no_checksum'; // legacy or short
  if (randomPart.length !== 34) return 'invalid'; // wrong length entirely

  const baseId = id.substring(0, id.length - 2);
  const expected = encodeChecksum(computeChecksumBits(baseId));
  const actual = id.substring(id.length - 2);
  return actual === expected ? 'valid' : 'invalid';
}
