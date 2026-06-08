/**
 * Detects which imported projects need post-import VFS migration.
 *
 * Two migration types:
 * - `remote_vfs`: project uses a remote VFS server — files need to be
 *   fetched and written to the target adapter (scenarios 2 & 3).
 * - `table_to_filesystem`: VFS table records exist in storage but the
 *   server uses filesystem VFS mode — records need to be materialized
 *   on disk and cleaned up from the database (scenario 4).
 */

import type { Project } from '../protocol/types';
import type { StorageAdapter } from '../services/storage/StorageAdapter';
import { Tables } from '../services/storage/StorageAdapter';

export type VfsMigrationTaskType = 'remote_vfs' | 'table_to_filesystem';

export interface VfsMigrationTask {
  type: VfsMigrationTaskType;
  projectId: string;
  projectName: string;
  remoteVfsUrl?: string;
  remoteVfsPassword?: string;
}

/**
 * Scan projects for remote VFS references.
 */
export function detectRemoteVfsTasks(projects: Project[]): VfsMigrationTask[] {
  return projects
    .filter(p => p.remoteVfsUrl)
    .map(p => ({
      type: 'remote_vfs' as const,
      projectId: p.id,
      projectName: p.name,
      remoteVfsUrl: p.remoteVfsUrl,
      remoteVfsPassword: p.remoteVfsPassword ?? '',
    }));
}

/**
 * Scan projects for VFS table records that need filesystem materialization.
 * Only relevant when `vfsMode === 'filesystem'` — the table records exist
 * from CSV import but the filesystem adapter won't see them.
 */
export async function detectTableToFilesystemTasks(
  projects: Project[],
  adapter: StorageAdapter
): Promise<VfsMigrationTask[]> {
  const tasks: VfsMigrationTask[] = [];
  for (const project of projects) {
    // Skip projects configured to use remote VFS — their table records
    // are stale leftovers, not data that should be materialized on disk.
    if (project.remoteVfsUrl) continue;

    const metaId = `vfs_meta_${project.id}`;
    const record = await adapter.get(Tables.VFS_META, metaId);
    if (record) {
      tasks.push({
        type: 'table_to_filesystem',
        projectId: project.id,
        projectName: project.name,
      });
    }
  }
  return tasks;
}
