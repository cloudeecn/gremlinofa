/**
 * ID Generation Utility
 * Generates unique IDs with base32-encoded random strings for collision resistance
 */

/**
 * Generate a unique ID with a prefix and base32-encoded random string
 * @param prefix - The prefix for the ID (e.g., 'msg_user', 'chat', 'project')
 * @returns A unique ID like 'prefix_abc7xyz2mnopqrs...' (prefix + 32 char base32)
 *
 * Uses 32 random bytes (160 bits entropy) for astronomical collision resistance
 */
export const generateUniqueId = (prefix: string): string => {
  const base32Chars = 'abcdefghijklmnopqrstuvwxyz234567';
  const randomBytes = crypto.getRandomValues(new Uint8Array(32));

  let result = '';
  for (const byte of randomBytes) {
    result += base32Chars[byte & 31];
  }

  return `${prefix}_${result}`;
};
