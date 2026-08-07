/**
 * Prefix every `console.*` line with an ISO 8601 timestamp — server mode only.
 *
 * Most of what surfaces during a server-mode request (agentic loop, storage,
 * API clients, tools) logs from `src/shared/`, which is also bundled into the
 * browser worker. Rather than touch ~178 call sites — and rather than reference
 * `process` in shared code, which the browser bundle doesn't shim — we wrap
 * `console` once at the Node entry point. The wrapper lives in `src/server/`, so
 * it only ever runs in server mode; the worker/browser console is untouched.
 *
 * Call it as the first statement in each Node entry (`nodeEntry.ts`, the
 * standalone VFS server). Idempotent. Returns a `restore()` so tests can undo
 * the patch (console is process-global); production never calls it.
 */

type ConsoleMethod = 'log' | 'debug' | 'info' | 'warn' | 'error';
const METHODS: ConsoleMethod[] = ['log', 'debug', 'info', 'warn', 'error'];

let installed = false;

export function installLogTimestamps(): () => void {
  if (installed) return () => {};
  installed = true;

  // Capture the original references so `restore()` can put them back exactly.
  // Call them via `.call(console, …)` (not a bound copy) so each method keeps
  // its native stdout/stderr routing without losing the original identity.
  const originals = METHODS.map(m => console[m]);

  METHODS.forEach((method, i) => {
    const orig = originals[i];
    console[method] = (first?: unknown, ...rest: unknown[]): void => {
      const ts = new Date().toISOString();
      // Keep printf semantics: the format string must stay the first arg, so
      // interpolate the timestamp into it. When the first arg isn't a string
      // there's no format string to protect — prepend the timestamp as its own.
      if (typeof first === 'string') {
        orig.call(console, `${ts} ${first}`, ...rest);
      } else if (first === undefined && rest.length === 0) {
        orig.call(console, ts);
      } else {
        orig.call(console, ts, first, ...rest);
      }
    };
  });

  return () => {
    METHODS.forEach((method, i) => {
      console[method] = originals[i];
    });
    installed = false;
  };
}
