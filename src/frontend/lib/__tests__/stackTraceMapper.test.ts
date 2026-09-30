import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('stacktrace-js', () => ({ default: { fromError: vi.fn() } }));

import StackTrace from 'stacktrace-js';
import { mapStackString, mapStackTrace } from '../stackTraceMapper';

type GpsOptions = {
  sourceCache: Record<string, unknown>;
  sourceMapConsumerCache: Record<string, unknown>;
};

const optionsOfCall = (index: number) =>
  vi.mocked(StackTrace.fromError).mock.calls[index][1] as unknown as GpsOptions;

describe('stackTraceMapper', () => {
  beforeEach(() => {
    vi.mocked(StackTrace.fromError).mockResolvedValue([
      {
        functionName: 'handleClick',
        fileName: 'src/App.tsx',
        lineNumber: 12,
        columnNumber: 4,
      } as StackTrace.StackFrame,
    ]);
  });

  it('formats mapped frames', async () => {
    const mapped = await mapStackTrace(new TypeError('boom'));

    expect(mapped).toBe('TypeError: boom\n    at handleClick (src/App.tsx:12:4)');
  });

  it('shares one set of source caches across calls', async () => {
    await mapStackTrace(new Error('first'));
    await mapStackTrace(new Error('second'));
    await mapStackString('Error: third\n    at x (https://app/assets/index.js:1:100)');

    const first = optionsOfCall(0);
    expect(first.sourceCache).toBeTypeOf('object');
    expect(first.sourceMapConsumerCache).toBeTypeOf('object');
    for (const index of [1, 2]) {
      expect(optionsOfCall(index).sourceCache).toBe(first.sourceCache);
      expect(optionsOfCall(index).sourceMapConsumerCache).toBe(first.sourceMapConsumerCache);
    }
  });

  it('evicts cached fetches that failed so the next error retries', async () => {
    const failed = Promise.reject(new Error('offline'));
    const loaded = Promise.resolve('{"version":3}');
    vi.mocked(StackTrace.fromError).mockImplementationOnce(async (_error, options) => {
      const { sourceCache, sourceMapConsumerCache } = options as unknown as GpsOptions;
      sourceCache['https://app/assets/index.js.map'] = failed;
      sourceCache['https://app/assets/vendor.js.map'] = loaded;
      sourceMapConsumerCache['https://app/assets/index.js.map'] = failed;
      return [];
    });

    await mapStackTrace(new Error('boom'));
    await failed.catch(() => {});

    const { sourceCache, sourceMapConsumerCache } = optionsOfCall(0);
    expect(sourceCache).not.toHaveProperty(['https://app/assets/index.js.map']);
    expect(sourceMapConsumerCache).not.toHaveProperty(['https://app/assets/index.js.map']);
    expect(sourceCache['https://app/assets/vendor.js.map']).toBe(loaded);
  });

  it('falls back to the original stack when mapping throws', async () => {
    vi.mocked(StackTrace.fromError).mockRejectedValueOnce(new Error('no maps'));
    const error = new Error('boom');

    expect(await mapStackTrace(error)).toBe(error.stack);
  });
});
