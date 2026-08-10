import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  isCacheDebugEnabled,
  logCacheUsage,
  probePrefixDivergence,
  resetPrefixProbe,
} from '../promptCacheDebug';

type DebugGlobal = { __GREMLIN_CACHE_DEBUG__?: boolean };

const KEY = 'a'.repeat(64);

function request(instructions: string, items: unknown[]) {
  return { instructions, tools: [{ type: 'function', name: 'read' }], input: items };
}

/** The last `[promptCache] …` payload the probe logged. */
function lastPayload(debug: ReturnType<typeof vi.spyOn>): Record<string, unknown> {
  const calls = debug.mock.calls;
  return calls[calls.length - 1][1] as Record<string, unknown>;
}

describe('promptCacheDebug', () => {
  let debug: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetPrefixProbe();
    debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  afterEach(() => {
    debug.mockRestore();
    delete (globalThis as DebugGlobal).__GREMLIN_CACHE_DEBUG__;
  });

  describe('logCacheUsage', () => {
    it('reports the cache-read share of the total input', () => {
      logCacheUsage('chatgpt-subscription', KEY, { inputTokens: 200, cacheReadTokens: 800 });

      expect(lastPayload(debug)).toMatchObject({
        apiType: 'chatgpt-subscription',
        key: 'aaaaaaaa',
        input: 200,
        cacheRead: 800,
        hitPct: 80,
      });
    });

    it('reports zero rather than NaN when the call used no input tokens', () => {
      logCacheUsage('responses_api', undefined, {});

      expect(lastPayload(debug)).toMatchObject({ key: '<none>', hitPct: 0 });
    });
  });

  describe('probePrefixDivergence', () => {
    it('stays silent unless the debug flag is armed', () => {
      probePrefixDivergence('responses_api', KEY, request('sys', [{ n: 1 }]));
      expect(debug).not.toHaveBeenCalled();
    });

    it('reports a stable prefix when the next request only appends', () => {
      (globalThis as DebugGlobal).__GREMLIN_CACHE_DEBUG__ = true;

      probePrefixDivergence('responses_api', KEY, request('sys', [{ n: 1 }]));
      probePrefixDivergence('responses_api', KEY, request('sys', [{ n: 1 }, { n: 2 }]));

      expect(lastPayload(debug)).toMatchObject({ kept: 3, appended: 1 });
      expect(debug.mock.calls[1][0]).toContain('prefix stable');
    });

    it('names the input item that changed under it', () => {
      (globalThis as DebugGlobal).__GREMLIN_CACHE_DEBUG__ = true;

      probePrefixDivergence('responses_api', KEY, request('sys', [{ n: 1 }, { n: 2 }]));
      probePrefixDivergence('responses_api', KEY, request('sys', [{ n: 1 }, { n: 'edited' }]));

      expect(debug.mock.calls[1][0]).toContain('PREFIX DIVERGED');
      expect(lastPayload(debug)).toMatchObject({
        segment: 'input[1]',
        stablePrefixSegments: 3,
      });
    });

    it('names the instructions when the system prompt moves', () => {
      (globalThis as DebugGlobal).__GREMLIN_CACHE_DEBUG__ = true;

      probePrefixDivergence('responses_api', KEY, request('sys', [{ n: 1 }]));
      probePrefixDivergence('responses_api', KEY, request('sys v2', [{ n: 1 }]));

      expect(lastPayload(debug)).toMatchObject({
        segment: 'instructions',
        stablePrefixSegments: 0,
      });
    });

    it('tracks each routing key separately', () => {
      (globalThis as DebugGlobal).__GREMLIN_CACHE_DEBUG__ = true;
      const other = 'b'.repeat(64);

      probePrefixDivergence('responses_api', KEY, request('sys', [{ n: 1 }]));
      probePrefixDivergence('responses_api', other, request('different', [{ n: 9 }]));
      probePrefixDivergence('responses_api', KEY, request('sys', [{ n: 1 }]));

      // The second key's request must not be mistaken for the first key's baseline.
      expect(debug.mock.calls[2][0]).toContain('prefix stable');
    });
  });

  it('reads the debug flag off globalThis', () => {
    expect(isCacheDebugEnabled()).toBe(false);
    (globalThis as DebugGlobal).__GREMLIN_CACHE_DEBUG__ = true;
    expect(isCacheDebugEnabled()).toBe(true);
  });
});
