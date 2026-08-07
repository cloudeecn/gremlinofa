/**
 * Coerce an untrusted value (e.g. a model-supplied tool parameter) to a
 * string for display. Non-strings are JSON-encoded rather than cast, so an
 * object never leaks into a string-typed render field (React error #31).
 */
export function coerceToString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  return JSON.stringify(value) ?? String(value);
}
