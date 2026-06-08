/**
 * SHA-256 hex digest of a UTF-8 string. Uses Web Crypto, which works in
 * both the browser/worker bundle and Node (≥19). Returns a 64-char
 * lowercase hex string.
 *
 * Used to derive opaque cache-routing keys from project/chat IDs so we
 * never send raw IDs in `prompt_cache_key` / `metadata.user_id`.
 */
export async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const out = new Uint8Array(digest);
  return Array.from(out, b => b.toString(16).padStart(2, '0')).join('');
}
