/**
 * VFS Concurrency Tests
 *
 * Regression tests for the parallel write race condition (lost updates).
 * Without the tree lock, concurrent VFS writes would each loadTree → modify → saveTree
 * on a single JSON document, causing the second save to silently overwrite the first.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createVfsService } from '../vfsService';
import { withTreeLock } from '../treeLock';
import type { UnifiedStorage } from '../../storage/unifiedStorage';
import type { EncryptionCore } from '../../encryption/encryptionCore';
import { buildStubVfsDeps } from './_vfsTestHelpers';

let fileCounter = 0;
vi.mock('../../../protocol/idGenerator', () => ({
  generateUniqueId: vi.fn((prefix: string) => `${prefix}_${++fileCounter}`),
}));

// Build a lock-wrapped vfs surface that mirrors what `vfsFacade.X` used
// to do — wraps each call in `withTreeLock(projectId, ...)`. The point of
// this test file is to verify that the tree lock serializes parallel
// writes; constructing the wrapper inline keeps that semantic intact
// without depending on the now-deleted module-level wrappers.
const { stubStorage, stubEncryption, mockStorage } = buildStubVfsDeps();
const vfs = createVfsService(
  stubStorage as unknown as UnifiedStorage,
  stubEncryption as unknown as EncryptionCore
);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function lock<F extends (...args: any[]) => Promise<any>>(fn: F): F {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ((...args: any[]) => withTreeLock(args[0] as string, () => fn(...args))) as F;
}
const createFile = lock(vfs.createFile);
const deleteFile = lock(vfs.deleteFile);
const readDir = lock(vfs.readDir);
const mkdir = lock(vfs.mkdir);

const PROJECT_ID = 'test_project';

beforeEach(() => {
  mockStorage.clear();
  fileCounter = 0;
});

describe('VFS parallel write safety', () => {
  it('parallel deletes do not lose updates', async () => {
    const fileCount = 5;

    // Create files sequentially (setup)
    for (let i = 0; i < fileCount; i++) {
      await createFile(PROJECT_ID, `/file${i}.txt`, `content ${i}`);
    }

    // Verify all files exist
    const entriesBefore = await readDir(PROJECT_ID, '/');
    expect(entriesBefore).toHaveLength(fileCount);

    // Delete all files in parallel — this was the original race condition
    await Promise.all(
      Array.from({ length: fileCount }, (_, i) => deleteFile(PROJECT_ID, `/file${i}.txt`))
    );

    // All files should be deleted (soft-deleted, so readDir excludes them)
    const entriesAfter = await readDir(PROJECT_ID, '/');
    expect(entriesAfter).toHaveLength(0);
  });

  it('parallel creates in different directories do not lose updates', async () => {
    await mkdir(PROJECT_ID, '/dir1');
    await mkdir(PROJECT_ID, '/dir2');

    // Create files in different dirs simultaneously
    await Promise.all([
      createFile(PROJECT_ID, '/dir1/a.txt', 'a'),
      createFile(PROJECT_ID, '/dir2/b.txt', 'b'),
    ]);

    const dir1 = await readDir(PROJECT_ID, '/dir1');
    const dir2 = await readDir(PROJECT_ID, '/dir2');
    expect(dir1).toHaveLength(1);
    expect(dir2).toHaveLength(1);
  });

  it('interleaved create and delete on same project serialize correctly', async () => {
    await createFile(PROJECT_ID, '/target.txt', 'original');

    // Start delete and create concurrently
    await Promise.all([
      deleteFile(PROJECT_ID, '/target.txt'),
      createFile(PROJECT_ID, '/other.txt', 'new'),
    ]);

    const entries = await readDir(PROJECT_ID, '/');
    // target.txt should be deleted, other.txt should exist
    const names = entries.map(e => e.name);
    expect(names).toContain('other.txt');
    expect(names).not.toContain('target.txt');
  });
});
