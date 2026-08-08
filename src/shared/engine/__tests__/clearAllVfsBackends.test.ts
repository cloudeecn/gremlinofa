/**
 * `clearAllVfsBackends` runs ahead of replace-mode import and purgeAllData:
 * filesystem / remote VFS backends keep the actual files outside the vfs_*
 * tables, so a table-only wipe used to leave every old file on disk (and
 * re-exposed them under any re-imported project reusing the same id).
 */

import { describe, it, expect, vi } from 'vitest';
import { clearAllVfsBackends } from '../importRunner';
import type { BackendDeps } from '../backendDeps';
import type { UnifiedStorage } from '../../services/storage/unifiedStorage';
import type { EncryptionCore } from '../../services/encryption/encryptionCore';

function makeDeps(overrides: {
  projects: { id: string; name: string }[];
  clearVfsImpls: Record<string, () => Promise<void>>;
}) {
  const storage = {
    getProjects: vi.fn(async () => overrides.projects),
  } as unknown as UnifiedStorage;
  const encryption = {
    deriveUserId: vi.fn(async () => 'user-1'),
  } as unknown as EncryptionCore;
  const cleared: string[] = [];
  const deps = {
    createVfsAdapter: vi.fn((_deps: BackendDeps, project: { id: string }) => ({
      clearVfs: async () => {
        await (overrides.clearVfsImpls[project.id] ?? (async () => {}))();
        cleared.push(project.id);
      },
    })),
  } as unknown as BackendDeps;
  return { storage, encryption, deps, cleared };
}

describe('clearAllVfsBackends', () => {
  it('clears the VFS backend of every project', async () => {
    const { storage, encryption, deps, cleared } = makeDeps({
      projects: [
        { id: 'p1', name: 'One' },
        { id: 'p2', name: 'Two' },
      ],
      clearVfsImpls: {},
    });
    const warnings: string[] = [];

    await clearAllVfsBackends(storage, encryption, deps, m => warnings.push(m));

    expect(cleared).toEqual(['p1', 'p2']);
    expect(warnings).toEqual([]);
  });

  it('reports a failed backend as a warning and keeps clearing the rest', async () => {
    const { storage, encryption, deps, cleared } = makeDeps({
      projects: [
        { id: 'p1', name: 'Broken' },
        { id: 'p2', name: 'Fine' },
      ],
      clearVfsImpls: {
        p1: async () => {
          throw new Error('remote VFS unreachable');
        },
      },
    });
    const warnings: string[] = [];

    await clearAllVfsBackends(storage, encryption, deps, m => warnings.push(m));

    expect(cleared).toEqual(['p2']);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Broken');
    expect(warnings[0]).toContain('remote VFS unreachable');
  });

  it('is a no-op without a createVfsAdapter factory', async () => {
    const storage = { getProjects: vi.fn() } as unknown as UnifiedStorage;
    const encryption = { deriveUserId: vi.fn() } as unknown as EncryptionCore;

    await clearAllVfsBackends(storage, encryption, undefined, () => {});
    await clearAllVfsBackends(storage, encryption, {} as BackendDeps, () => {});

    expect(storage.getProjects).not.toHaveBeenCalled();
  });
});
