/**
 * JSON wire-format helpers for types that don't survive JSON.stringify.
 *
 * - **Uint8Array** serializes as {"0":1,"1":2,...} — we encode it as
 *   {__b64: "<base64>"} and decode on the other side.
 * - **Date** serializes as an ISO string — JSON.parse leaves it as a
 *   string, but callers expect a Date object. The reviver detects ISO
 *   date strings and converts them back.
 *
 * Used by both WebSocket transports (client + server). The worker
 * transport uses structured clone (postMessage) which preserves both
 * types natively.
 */

const B64_MARKER = '__b64';

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

/** JSON.stringify replacer — converts Uint8Array to {__b64: "..."}. */
export function binaryReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return { [B64_MARKER]: uint8ArrayToBase64(value) };
  }
  return value;
}

/**
 * Matches ISO 8601 date strings produced by Date.toJSON():
 * "2024-01-15T09:30:00.000Z" or "2024-01-15T09:30:00Z"
 */
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;

/**
 * JSON.parse reviver — restores Uint8Array from {__b64: "..."} markers
 * and Date objects from ISO 8601 strings.
 */
export function binaryReviver(_key: string, value: unknown): unknown {
  // Uint8Array marker
  if (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    B64_MARKER in (value as Record<string, unknown>)
  ) {
    const b64 = (value as Record<string, unknown>)[B64_MARKER];
    if (typeof b64 === 'string') {
      return base64ToUint8Array(b64);
    }
  }
  // Date revival — JSON.stringify converts Date to ISO string via toJSON()
  if (typeof value === 'string' && ISO_DATE_RE.test(value)) {
    return new Date(value);
  }
  return value;
}
