/**
 * Header filtering for proxy requests and responses.
 * Strips hop-by-hop headers and proxy-internal headers.
 */

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/** Headers stripped from outgoing proxy request */
const STRIP_FROM_REQUEST = new Set([...HOP_BY_HOP, 'host', 'x-proxy-target']);

/** Headers stripped from target response before returning to client */
const STRIP_FROM_RESPONSE = new Set([...HOP_BY_HOP]);

export function filterRequestHeaders(
  incoming: Record<string, string | string[] | undefined>
): Record<string, string | string[]> {
  const filtered: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(incoming)) {
    if (value === undefined) continue;
    if (STRIP_FROM_REQUEST.has(key.toLowerCase())) continue;
    filtered[key] = value;
  }
  return filtered;
}

export function filterResponseHeaders(
  incoming: Record<string, string | string[] | undefined>
): Record<string, string | string[]> {
  const filtered: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(incoming)) {
    if (value === undefined) continue;
    if (STRIP_FROM_RESPONSE.has(key.toLowerCase())) continue;
    filtered[key] = value;
  }
  return filtered;
}
