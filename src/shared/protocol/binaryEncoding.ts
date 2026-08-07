/**
 * JSON wire-format helpers for types that don't survive JSON.stringify.
 *
 * - **Uint8Array** serializes as {"0":1,"1":2,...} — we encode it as
 *   {__b64: "<base64>"} and decode on the other side.
 * - **Date** is encoded as {__date: "<iso>"} and revived only from that
 *   marker. Reviving any ISO-looking string would corrupt ordinary string
 *   fields whose value happens to be a timestamp (e.g. a tool result of
 *   exactly "2026-08-06T12:34:56.789Z"). As a fallback for peers running
 *   an older build that sends bare ISO strings, a small allowlist of
 *   known Date-field keys still revives from plain ISO strings.
 *
 * Used by both WebSocket transports (client + server). The worker
 * transport uses structured clone (postMessage) which preserves both
 * types natively.
 */

const B64_MARKER = '__b64';
const DATE_MARKER = '__date';

// --------------------------------------------------------------------------
// Base64 primitives (work in both browser and Node.js)
// --------------------------------------------------------------------------

function uint8ArrayToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
  }
  // Browser — chunk String.fromCharCode to avoid call-stack overflow
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

function base64ToUint8Array(base64: string): Uint8Array {
  if (typeof Buffer !== 'undefined') {
    const buf = Buffer.from(base64, 'base64');
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// --------------------------------------------------------------------------
// JSON replacer / reviver
// --------------------------------------------------------------------------

/**
 * JSON.stringify replacer — converts Uint8Array / ArrayBuffer to
 * {__b64: "..."} and Date to {__date: "<iso>"}.
 *
 * Must be a regular function: JSON.stringify calls Date.prototype.toJSON()
 * before invoking the replacer, so `value` is already a string — the
 * original Date is only reachable via `this[key]`.
 */
export function binaryReplacer(this: unknown, key: string, value: unknown): unknown {
  const original = (this as Record<string, unknown>)[key];
  if (original instanceof Date) {
    // Invalid Date: Date.toJSON() serializes it as null; mirror that instead
    // of letting toISOString() throw and kill the whole envelope send.
    return isNaN(original.getTime()) ? null : { [DATE_MARKER]: original.toISOString() };
  }
  if (value instanceof Uint8Array) {
    return { [B64_MARKER]: uint8ArrayToBase64(value) };
  }
  if (value instanceof ArrayBuffer) {
    return { [B64_MARKER]: uint8ArrayToBase64(new Uint8Array(value)) };
  }
  return value;
}

/**
 * Matches ISO 8601 date strings produced by Date.toJSON():
 * "2024-01-15T09:30:00.000Z" or "2024-01-15T09:30:00Z"
 */
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;

/**
 * Keys that are Date-typed in the protocol (see src/shared/protocol/types).
 * Bare ISO strings on these keys revive to Date for compatibility with
 * older peers that serialized Dates without the {__date} marker.
 */
const DATE_FIELD_KEYS = new Set([
  'timestamp',
  'chatTimestamp',
  'createdAt',
  'updatedAt',
  'lastModifiedAt',
  'lastUsedAt',
]);

/**
 * JSON.parse reviver — restores Uint8Array from {__b64: "..."} markers and
 * Date from {__date: "..."} markers (plus the legacy bare-ISO fallback on
 * allowlisted keys). Strings on other keys are never touched, even if they
 * look like timestamps.
 */
export function binaryReviver(key: string, value: unknown): unknown {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (B64_MARKER in record && typeof record[B64_MARKER] === 'string') {
      return base64ToUint8Array(record[B64_MARKER] as string);
    }
    if (DATE_MARKER in record && typeof record[DATE_MARKER] === 'string') {
      return new Date(record[DATE_MARKER] as string);
    }
  }
  // Legacy fallback: older peers send Dates as bare ISO strings
  if (typeof value === 'string' && DATE_FIELD_KEYS.has(key) && ISO_DATE_RE.test(value)) {
    return new Date(value);
  }
  return value;
}
