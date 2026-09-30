/**
 * Gate a URL that came from outside the app (LLM tool output, a backend
 * response) to http/https before it becomes an `href`. React does not block a
 * `javascript:` href. Returns `undefined` (a non-clickable link) for anything
 * else, so callers can still show the URL text.
 */
export function safeHref(url: string): string | undefined {
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:' ? url : undefined;
  } catch {
    return undefined;
  }
}
