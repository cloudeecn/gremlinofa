import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EncryptionCore } from '../../services/encryption/encryptionCore';
import type { UnifiedStorage } from '../../services/storage/unifiedStorage';
import type { ExportEvent } from '../../protocol/protocol';

vi.mock('../dataExport', () => ({ streamExportCSVLines: vi.fn() }));

import { streamExportCSVLines } from '../dataExport';
import { runExport } from '../exportRunner';

const storage = { getAdapter: () => ({}) } as unknown as UnifiedStorage;
const encryption = {} as EncryptionCore;

/** Mocked Date.now() */
let now = 0;

/** Header line plus `rows` records, advancing the mocked clock `msPerRow` before each record. */
function mockExportLines(rows: number, msPerRow: number) {
  vi.mocked(streamExportCSVLines).mockImplementation(async function* () {
    yield 'header\n';
    for (let i = 1; i <= rows; i++) {
      now += msPerRow;
      yield `row ${i}\n`;
    }
  });
}

async function collect(): Promise<ExportEvent[]> {
  const events: ExportEvent[] = [];
  for await (const event of runExport(storage, encryption)) events.push(event);
  return events;
}

const progressCounts = (events: ExportEvent[]) =>
  events.flatMap(event => (event.type === 'progress' ? [event.processed] : []));

describe('runExport progress throttle', () => {
  beforeEach(() => {
    now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports the first record and the final count for a fast export', async () => {
    mockExportLines(500, 0);

    const events = await collect();

    expect(progressCounts(events)).toEqual([1, 500]);
  });

  it('emits at most one progress event per 100 ms', async () => {
    // 1000 records over one simulated second
    mockExportLines(1000, 1);

    const events = await collect();

    expect(progressCounts(events)).toEqual([1, 101, 201, 301, 401, 501, 601, 701, 801, 901, 1000]);
  });

  it('delivers the final count before done', async () => {
    mockExportLines(250, 1);

    const events = await collect();

    const types = events.map(event => event.type);
    const finalProgress = types.lastIndexOf('progress');
    expect(events[finalProgress]).toEqual({ type: 'progress', processed: 250 });
    expect(finalProgress).toBeLessThan(types.indexOf('done'));
    expect(types.at(-1)).toBe('done');
  });

  it('does not repeat the final count when it was just reported', async () => {
    mockExportLines(3, 100);

    const events = await collect();

    expect(progressCounts(events)).toEqual([1, 2, 3]);
  });

  it('reports no progress for a header-only export', async () => {
    mockExportLines(0, 0);

    const events = await collect();

    expect(progressCounts(events)).toEqual([]);
    expect(events.map(event => event.type)).toEqual(['chunk', 'done']);
  });
});
