/**
 * Tests for selectVersionsToKeep and compactProject
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock dependencies before importing vfsService
vi.mock('../../encryption/encryptionService', () => ({
  encryptionService: {
    encryptWithCompression: vi.fn(async (data: string) => `encrypted:${data}`),
    decryptWithDecompression: vi.fn(async (data: string) => {
      if (data.startsWith('encrypted:')) {
        return data.slice(10);
      }
      throw new Error('Invalid encrypted data');
    }),
  },
}));

// In-memory storage mock
const mockStorage = new Map<string, Map<string, { encryptedData: string; parentId?: string }>>();

vi.mock('../../storage', () => ({
  storage: {
    getAdapter: () => ({
      get: vi.fn(async (table: string, id: string) => {
        const tableMap = mockStorage.get(table);
        return tableMap?.get(id) || null;
      }),
      save: vi.fn(
        async (
          table: string,
          id: string,
          encryptedData: string,
          metadata: { parentId?: string }
        ) => {
          if (!mockStorage.has(table)) {
            mockStorage.set(table, new Map());
          }
          mockStorage.get(table)!.set(id, { encryptedData, parentId: metadata.parentId });
        }
      ),
      delete: vi.fn(async (table: string, id: string) => {
        mockStorage.get(table)?.delete(id);
      }),
      deleteMany: vi.fn(async (table: string, filters: { parentId?: string }) => {
        const tableMap = mockStorage.get(table);
        if (!tableMap || !filters.parentId) return;
        for (const [id, record] of tableMap.entries()) {
          if (record.parentId === filters.parentId) {
            tableMap.delete(id);
          }
        }
      }),
    }),
  },
}));

vi.mock('../../../utils/idGenerator', () => ({
  generateUniqueId: vi.fn((prefix: string) => `${prefix}_${Math.random().toString(36).slice(2)}`),
}));

import {
  selectVersionsToKeep,
  compactProject,
  createFile,
  updateFile,
  deleteFile,
  readFile,
  listVersions,
} from '../vfsService';

const MS_HOUR = 3_600_000;
const MS_DAY = 86_400_000;
const MS_WEEK = 604_800_000;
const MS_YEAR = 365 * MS_DAY;

beforeEach(() => {
  mockStorage.clear();
});

// ============================================================================
// selectVersionsToKeep — pure function tests
// ============================================================================

describe('selectVersionsToKeep', () => {
  it('returns empty set for empty input', () => {
    const result = selectVersionsToKeep([], Date.now());
    expect(result.size).toBe(0);
  });

  it('keeps all versions within 24h', () => {
    const now = Date.now();
    const versions = [
      { version: 1, createdAt: now - 1000 },
      { version: 2, createdAt: now - 2000 },
      { version: 3, createdAt: now - MS_HOUR },
      { version: 4, createdAt: now - 23 * MS_HOUR },
    ];
    const kept = selectVersionsToKeep(versions, now);
    expect(kept.size).toBe(4);
    expect(kept.has(1)).toBe(true);
    expect(kept.has(2)).toBe(true);
    expect(kept.has(3)).toBe(true);
    expect(kept.has(4)).toBe(true);
  });

  it('keeps 1 per hour bucket for 24h–3d tier', () => {
    const now = Date.now();
    // Align to start of an hour bucket so +10min stays in the same bucket
    const baseTime = Math.floor((now - 30 * MS_HOUR) / MS_HOUR) * MS_HOUR;
    const versions = [
      { version: 1, createdAt: baseTime },
      { version: 2, createdAt: baseTime + 10 * 60_000 }, // 10 min later, same hour bucket
    ];
    const kept = selectVersionsToKeep(versions, now);
    // Highest version in the bucket wins
    expect(kept.size).toBe(1);
    expect(kept.has(2)).toBe(true);
  });

  it('keeps 1 per day bucket for 3d–30d tier', () => {
    const now = Date.now();
    // Two versions in the same day bucket, ~5 days ago
    const baseTime = Math.floor((now - 5 * MS_DAY) / MS_DAY) * MS_DAY;
    const versions = [
      { version: 1, createdAt: baseTime },
      { version: 2, createdAt: baseTime + 2 * MS_HOUR }, // same day bucket
    ];
    const kept = selectVersionsToKeep(versions, now);
    expect(kept.size).toBe(1);
    expect(kept.has(2)).toBe(true);
  });

  it('keeps 1 per week bucket for 30d–1yr tier', () => {
    const now = Date.now();
    // Align to start of a week bucket so +1day stays in the same bucket
    const baseTime = Math.floor((now - 60 * MS_DAY) / MS_WEEK) * MS_WEEK;
    const versions = [
      { version: 1, createdAt: baseTime },
      { version: 2, createdAt: baseTime + MS_DAY }, // same week bucket
    ];
    const kept = selectVersionsToKeep(versions, now);
    expect(kept.size).toBe(1);
    expect(kept.has(2)).toBe(true);
  });

  it('discards versions older than 1 year', () => {
    const now = Date.now();
    const versions = [
      { version: 1, createdAt: now - MS_YEAR - MS_DAY },
      { version: 2, createdAt: now - MS_YEAR - 2 * MS_DAY },
    ];
    const kept = selectVersionsToKeep(versions, now);
    expect(kept.size).toBe(0);
  });

  it('handles mixed tiers correctly', () => {
    const now = Date.now();
    const versions = [
      { version: 1, createdAt: now - 1000 }, // <24h → kept
      { version: 2, createdAt: now - 30 * MS_HOUR }, // 24h-3d → hourly bucket
      { version: 3, createdAt: now - 31 * MS_HOUR }, // different hour bucket
      { version: 4, createdAt: now - 10 * MS_DAY }, // 3d-30d → daily bucket
      { version: 5, createdAt: now - 90 * MS_DAY }, // 30d-1yr → weekly bucket
      { version: 6, createdAt: now - MS_YEAR - 1 }, // >1yr → discarded
    ];
    const kept = selectVersionsToKeep(versions, now);
    expect(kept.has(1)).toBe(true); // <24h
    expect(kept.has(2)).toBe(true); // hourly
    expect(kept.has(3)).toBe(true); // different hourly bucket
    expect(kept.has(4)).toBe(true); // daily
    expect(kept.has(5)).toBe(true); // weekly
    expect(kept.has(6)).toBe(false); // >1yr
  });

  it('handles boundary at exactly 24h', () => {
    const now = Date.now();
    // Exactly at 24h boundary — should be in the <24h tier (<=)
    const versions = [{ version: 1, createdAt: now - MS_DAY }];
    const kept = selectVersionsToKeep(versions, now);
    expect(kept.has(1)).toBe(true);
  });

  it('handles boundary at exactly 3d', () => {
    const now = Date.now();
    // Exactly at 3d — still in 24h-3d tier (<=)
    const versions = [{ version: 1, createdAt: now - 3 * MS_DAY }];
    const kept = selectVersionsToKeep(versions, now);
    expect(kept.has(1)).toBe(true);
  });

  it('handles boundary at exactly 30d', () => {
    const now = Date.now();
    // Exactly at 30d — still in 3d-30d tier (<=)
    const versions = [{ version: 1, createdAt: now - 30 * MS_DAY }];
    const kept = selectVersionsToKeep(versions, now);
    expect(kept.has(1)).toBe(true);
  });

  it('handles boundary at exactly 365d (1yr)', () => {
    const now = Date.now();
    // Exactly at 1yr — still in 30d-1yr tier (<=)
    const versions = [{ version: 1, createdAt: now - MS_YEAR }];
    const kept = selectVersionsToKeep(versions, now);
    expect(kept.has(1)).toBe(true);
  });

  it('picks highest version per bucket', () => {
    const now = Date.now();
    // Three versions in the same daily bucket
    const baseTime = now - 10 * MS_DAY;
    const dayBucket = Math.floor(baseTime / MS_DAY);
    // Ensure they're all in the same day bucket
    const t1 = dayBucket * MS_DAY + 1000;
    const t2 = dayBucket * MS_DAY + 2000;
    const t3 = dayBucket * MS_DAY + 3000;
    const versions = [
      { version: 5, createdAt: t1 },
      { version: 10, createdAt: t2 },
      { version: 3, createdAt: t3 },
    ];
    const kept = selectVersionsToKeep(versions, now);
    expect(kept.size).toBe(1);
    expect(kept.has(10)).toBe(true);
  });
});

// ============================================================================
// compactProject — integration tests
// ============================================================================

describe('compactProject', () => {
  const PROJECT_ID = 'test_project';

  it('succeeds with all-zero results on empty project', async () => {
    const result = await compactProject(PROJECT_ID);
    expect(result.purgedNodes).toBe(0);
    expect(result.purgedOrphans).toBe(0);
    expect(result.prunedRevisions).toBe(0);
    expect(result.collapsedFiles).toBe(0);
    expect(result.treeNodes).toBe(0);
    expect(result.fileCount).toBe(0);
    expect(result.totalRevisions).toBe(0);
  });

  it('purges deleted nodes older than 1 week', async () => {
    // Create a file and soft-delete it
    await createFile(PROJECT_ID, '/old-file.txt', 'content');
    await deleteFile(PROJECT_ID, '/old-file.txt');

    // Manually backdate the deletion by patching the tree
    await backdateDeletedNode(PROJECT_ID, '/old-file.txt', Date.now() - 8 * MS_DAY);

    // Verify file is deleted
    const result = await compactProject(PROJECT_ID);
    expect(result.purgedNodes).toBe(1);
  });

  it('skips recently deleted nodes', async () => {
    await createFile(PROJECT_ID, '/recent-del.txt', 'content');
    await deleteFile(PROJECT_ID, '/recent-del.txt');

    // Don't backdate — recently deleted
    const result = await compactProject(PROJECT_ID);
    expect(result.purgedNodes).toBe(0);
  });

  it('does not prune versions for file with only current version', async () => {
    await createFile(PROJECT_ID, '/single.txt', 'only version');

    const result = await compactProject(PROJECT_ID);
    expect(result.prunedRevisions).toBe(0);
    expect(result.collapsedFiles).toBe(0);

    // File is still readable
    const content = await readFile(PROJECT_ID, '/single.txt');
    expect(content).toBe('only version');
  });

  it('prunes old versions per retention policy', async () => {
    await createFile(PROJECT_ID, '/versioned.txt', 'v1');

    // Create many versions
    for (let i = 2; i <= 10; i++) {
      await updateFile(PROJECT_ID, '/versioned.txt', `v${i}`);
    }

    const now = Date.now();
    // Backdate all historical versions to >1yr ago so they all get pruned
    await backdateAllVersionsToOld(PROJECT_ID, '/versioned.txt', now);

    const result = await compactProject(PROJECT_ID);
    // All 9 historical versions should be pruned (>1yr → discard)
    expect(result.prunedRevisions).toBe(9);
    expect(result.collapsedFiles).toBe(1);

    // Current content is preserved
    const content = await readFile(PROJECT_ID, '/versioned.txt');
    expect(content).toBe('v10');
  });

  it('renumbers versions continuously after pruning', async () => {
    await createFile(PROJECT_ID, '/renum.txt', 'v1');
    for (let i = 2; i <= 5; i++) {
      await updateFile(PROJECT_ID, '/renum.txt', `v${i}`);
    }

    // Backdate all versions to >1yr so they all get pruned
    const now = Date.now();
    await backdateAllVersionsToOld(PROJECT_ID, '/renum.txt', now);

    const result = await compactProject(PROJECT_ID);
    expect(result.prunedRevisions).toBeGreaterThan(0);

    // Current content preserved
    const content = await readFile(PROJECT_ID, '/renum.txt');
    expect(content).toBe('v5');

    // After pruning with all versions old, only current version remains
    // The version number should be 1 (no historical versions kept)
    const versions = await listVersions(
      PROJECT_ID,
      await getFileIdForPath(PROJECT_ID, '/renum.txt')
    );
    // All versions should be sequential starting from 1
    for (let i = 0; i < versions.length; i++) {
      expect(versions[i].version).toBe(i + 1);
    }
  });

  it('returns post-compact summary with tree size, file count, and revision count', async () => {
    // Create 2 files, one with revisions
    await createFile(PROJECT_ID, '/a.txt', 'a1');
    await updateFile(PROJECT_ID, '/a.txt', 'a2');
    await updateFile(PROJECT_ID, '/a.txt', 'a3');
    await createFile(PROJECT_ID, '/b.txt', 'b1');

    const result = await compactProject(PROJECT_ID);
    expect(result.treeNodes).toBe(2); // 2 file nodes
    expect(result.fileCount).toBe(2); // 2 live files
    expect(result.totalRevisions).toBe(2); // a.txt has 2 historical revisions (v1, v2)
  });

  it('fires progress callback with expected phases', async () => {
    await createFile(PROJECT_ID, '/prog.txt', 'content');

    const phases: string[] = [];
    await compactProject(PROJECT_ID, progress => {
      if (!phases.includes(progress.phase)) {
        phases.push(progress.phase);
      }
    });

    expect(phases).toContain('scanning');
    expect(phases).toContain('done');
  });
});

// ============================================================================
// Test helpers — backdating tree timestamps to simulate age
// ============================================================================

// These helpers reach into the mock storage to modify tree/version timestamps

async function getTreeFromStorage(projectId: string) {
  const metaId = `vfs_meta_${projectId}`;
  const tableMap = mockStorage.get('vfs_meta');
  const record = tableMap?.get(metaId);
  if (!record) return null;
  const json = record.encryptedData.startsWith('encrypted:')
    ? record.encryptedData.slice(10)
    : record.encryptedData;
  return JSON.parse(json);
}

async function saveTreeToStorage(projectId: string, tree: unknown) {
  const metaId = `vfs_meta_${projectId}`;
  if (!mockStorage.has('vfs_meta')) mockStorage.set('vfs_meta', new Map());
  mockStorage.get('vfs_meta')!.set(metaId, {
    encryptedData: `encrypted:${JSON.stringify(tree)}`,
    parentId: projectId,
  });
}

async function backdateDeletedNode(projectId: string, path: string, timestamp: number) {
  const tree = await getTreeFromStorage(projectId);
  if (!tree) return;

  const segments = path.split('/').filter(Boolean);
  let node = tree;
  for (const seg of segments) {
    node = node.children[seg];
  }
  node.updatedAt = timestamp;
  await saveTreeToStorage(projectId, tree);
}

async function getFileIdForPath(projectId: string, path: string): Promise<string> {
  const tree = await getTreeFromStorage(projectId);
  const segments = path.split('/').filter(Boolean);
  let node = tree;
  for (const seg of segments) {
    node = node.children[seg];
  }
  return node.fileId;
}

async function backdateAllVersionsToOld(projectId: string, path: string, now: number) {
  const fileId = await getFileIdForPath(projectId, path);
  const versionsTable = mockStorage.get('vfs_versions');
  if (!versionsTable) return;

  for (const [id, record] of versionsTable.entries()) {
    if (record.parentId === fileId) {
      const json = record.encryptedData.startsWith('encrypted:')
        ? record.encryptedData.slice(10)
        : record.encryptedData;
      const versionData = JSON.parse(json);
      versionData.createdAt = now - MS_YEAR - MS_DAY; // older than 1 year
      versionsTable.set(id, {
        encryptedData: `encrypted:${JSON.stringify(versionData)}`,
        parentId: fileId,
      });
    }
  }
}
