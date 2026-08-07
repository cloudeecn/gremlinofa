/**
 * Unit tests for the server-mode console timestamp wrapper.
 *
 * `console` is process-global, so each test restores the patch (via the
 * returned `restore()`) in `afterEach` to keep the prefix from leaking into
 * other test files running in the same vitest worker.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { installLogTimestamps } from '../installLogTimestamps';

// Matches `2026-06-22T12:53:47.412Z` at the start of a string.
const ISO_PREFIX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /;

let restore: (() => void) | undefined;

afterEach(() => {
  restore?.();
  restore = undefined;
  vi.restoreAllMocks();
});

describe('installLogTimestamps', () => {
  it('prefixes a string-first call with an ISO timestamp, keeping printf args intact', () => {
    const spy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    restore = installLogTimestamps();

    console.debug('[claudeAgent] sdk event=%s', 'assistant');

    expect(spy).toHaveBeenCalledTimes(1);
    const [fmt, ...rest] = spy.mock.calls[0];
    // Timestamp folded into the format string so `%s` stays the first arg.
    expect(fmt).toMatch(ISO_PREFIX);
    expect(fmt).toContain('[claudeAgent] sdk event=%s');
    // The printf argument is passed through untouched for the runtime to format.
    expect(rest).toEqual(['assistant']);
  });

  it('prepends the timestamp as a leading arg when the first arg is not a string', () => {
    const spy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    restore = installLogTimestamps();

    const payload = { port: 8080 };
    console.debug(payload);

    const [ts, obj] = spy.mock.calls[0];
    expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(obj).toBe(payload);
  });

  it('routes warn/error through their own originals', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    restore = installLogTimestamps();

    console.warn('[server] heads up');
    console.error('[server] boom');

    expect(warnSpy.mock.calls[0][0]).toMatch(ISO_PREFIX);
    expect(errorSpy.mock.calls[0][0]).toMatch(ISO_PREFIX);
  });

  it('is idempotent — a second install does not double-stamp', () => {
    const spy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const restore1 = installLogTimestamps();
    const restore2 = installLogTimestamps();
    restore = () => {
      restore1();
      restore2();
    };

    console.debug('once');

    const fmt = spy.mock.calls[0][0] as string;
    // Exactly one timestamp, not two.
    expect(fmt).toMatch(ISO_PREFIX);
    expect(fmt.replace(ISO_PREFIX, '')).toBe('once');
  });

  it('restore() puts the original console.debug back', () => {
    const before = console.debug;
    const undo = installLogTimestamps();
    expect(console.debug).not.toBe(before);
    undo();
    expect(console.debug).toBe(before);
  });
});
