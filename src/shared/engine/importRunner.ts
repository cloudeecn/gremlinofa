/**
 * Wraps `importDataFromFile` / `migrateDataFromFile` into a stream of
 * `ImportProgress` events for the `importData` RPC. The frontend reads the
 * uploaded `File` to a `Uint8Array` first, posts the bytes through, and the
 * runner here wraps them in an in-memory `Blob` so the existing CSV
 * streaming pipeline doesn't need a separate "from bytes" code path.
 *
 * The terminal `done` event carries the final counts so the consumer can
 * collect a result without a separate one-shot result envelope.
 *
 * After the CSV import phase, a VFS migration phase runs automatically
 * (unless `skipVfsMigration` is set). This migrates remote VFS files and
 * table-to-filesystem records into the target adapter.
 */

import { EncryptionCore } from '../services/encryption/encryptionCore';
import type { UnifiedStorage } from '../services/storage/unifiedStorage';
import { importDataFromFile, migrateDataFromFile } from './dataImport';
import type { ImportProgress as ImportProgressCount } from '../protocol/types/data';
import type { ImportDataParams, ImportProgress } from '../protocol/protocol';
import type { BackendDeps } from './backendDeps';
import { migrateProjectVfs, migrateProjectVfsBulk } from './vfsMigration';
import { detectRemoteVfsTasks, detectTableToFilesystemTasks } from './vfsMigrationDetector';
import { LocalVfsAdapter } from '../services/vfs/localVfsAdapter';
import { createVfsService } from '../services/vfs/vfsService';

export async function* runImport(
  storage: UnifiedStorage,
  encryption: EncryptionCore,
  params: ImportDataParams,
  deps?: BackendDeps,
  uploadChunks?: Uint8Array[]
): AsyncGenerator<ImportProgress, void, void> {
  const adapter = storage.getAdapter();

  // Build the Blob from either the inline data or the pre-uploaded chunks.
  // Blob accepts an array of parts without copying, so passing the chunks
  // directly avoids a 2GB+ memcpy for large imports.
  const blobParts = (uploadChunks ??
    (params.data ? [new Uint8Array(params.data)] : [])) as BlobPart[];
  if (blobParts.length === 0) {
    throw new Error(
      'importData: no data provided (supply data or upload chunks via importUploadChunk)'
    );
  }
  const blob = new Blob(blobParts, { type: 'text/csv' });

  // Bridge the callback-based progress reporter into a generator queue.
  const queue: ImportProgress[] = [];
  let resolveNext: (() => void) | null = null;
  let done = false;
  let finalResult: { imported: number; skipped: number; errors: string[] } | null = null;
  let runError: unknown = null;

  const push = (event: ImportProgress) => {
    queue.push(event);
    if (resolveNext) {
      const r = resolveNext;
      resolveNext = null;
      r();
    }
  };

  const onProgress = (p: ImportProgressCount) => {
    push({
      type: 'progress',
      processed: p.processed,
      imported: p.imported,
      skipped: p.skipped,
      errors: p.errors,
      estimatedTotal: p.estimatedTotal,
    });
  };

  const runner =
    params.mode === 'replace'
      ? migrateDataFromFile(adapter, blob, params.sourceCEK, encryption, onProgress)
      : importDataFromFile(adapter, blob, params.sourceCEK, encryption, onProgress);

  // Kick off the importer; collect the result and signal completion via the
  // shared queue. Errors are surfaced as a thrown exception from the loop
  // below so the transport wraps them as `stream_end {error}`.
  runner
    .then(result => {
      finalResult = result;
      done = true;
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r();
      }
    })
    .catch(err => {
      runError = err;
      done = true;
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r();
      }
    });

  while (true) {
    if (queue.length > 0) {
      yield queue.shift()!;
      continue;
    }
    if (done) break;
    await new Promise<void>(resolve => {
      resolveNext = resolve;
    });
  }

  if (runError) {
    throw runError;
  }

  // `runner` resolved without throwing, so finalResult is guaranteed.
  const result = finalResult!;

  // Re-stamp the CEK oracle — replace-mode cleared it, and the imported
  // bundle may carry a source oracle encrypted with a different key.
  await storage.createCekOracle();

  // ------------------------------------------------------------------
  // VFS migration phase
  // ------------------------------------------------------------------
  const vfsMigrationErrors: string[] = [];

  if (!params.skipVfsMigration && deps?.createVfsAdapter) {
    try {
      const migrationErrors = await runVfsMigration(storage, encryption, params, deps, push);
      vfsMigrationErrors.push(...migrationErrors);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      vfsMigrationErrors.push(`VFS migration failed: ${msg}`);
    }
  }

  yield {
    type: 'done',
    imported: result.imported,
    skipped: result.skipped,
    errors: [...result.errors, ...vfsMigrationErrors],
  };
}

// ============================================================================
// VFS migration orchestrator
// ============================================================================

async function runVfsMigration(
  storage: UnifiedStorage,
  encryption: EncryptionCore,
  params: ImportDataParams,
  deps: BackendDeps,
  push: (event: ImportProgress) => void
): Promise<string[]> {
  const projects = await storage.getProjects();
  if (projects.length === 0) {
    console.debug('[importRunner] VFS migration: no projects, skipping');
    return [];
  }

  console.debug('[importRunner] VFS migration: scanning', projects.length, 'projects');
  const errors: string[] = [];

  // --- Scenario 2 & 3: Remote VFS migration ---
  const remoteTasks = detectRemoteVfsTasks(projects);
  console.debug(
    '[importRunner] Remote VFS tasks:',
    remoteTasks.length,
    remoteTasks.map(t => `${t.projectName} (${t.projectId})`)
  );
  if (remoteTasks.length > 0) {
    const remoteErrors = await migrateRemoteVfsTasks(
      storage,
      encryption,
      params,
      deps,
      remoteTasks,
      push
    );
    errors.push(...remoteErrors);
  }

  // --- Scenario 4: Table-to-filesystem migration ---
  if (deps.vfsMode === 'filesystem') {
    const tableToFsTasks = await detectTableToFilesystemTasks(projects, storage.getAdapter());
    console.debug(
      '[importRunner] Table→filesystem tasks:',
      tableToFsTasks.length,
      tableToFsTasks.map(t => `${t.projectName} (${t.projectId})`)
    );
    for (const task of tableToFsTasks) {
      try {
        await migrateTableToFilesystem(storage, encryption, deps, task, push);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`VFS table→filesystem for "${task.projectName}": ${msg}`);
        push({
          type: 'warning',
          message: `Failed to migrate VFS to filesystem for "${task.projectName}": ${msg}`,
        });
      }
    }
  }

  return errors;
}

/**
 * Migrate remote VFS files for imported projects (scenarios 2 & 3).
 */
async function migrateRemoteVfsTasks(
  storage: UnifiedStorage,
  encryption: EncryptionCore,
  params: ImportDataParams,
  deps: BackendDeps,
  tasks: ReturnType<typeof detectRemoteVfsTasks>,
  push: (event: ImportProgress) => void
): Promise<string[]> {
  if (!deps.buildMigrationSourceAdapter) {
    for (const task of tasks) {
      push({
        type: 'vfs_migration_skipped',
        projectId: task.projectId,
        projectName: task.projectName,
        reason: 'No migration source adapter available',
      });
    }
    return [];
  }

  // Build a disposable source encryption from the import's source CEK
  const sourceEncryption = new EncryptionCore();
  await sourceEncryption.initializeWithCEK(params.sourceCEK);

  // Same CEK → remote VFS is already accessible at the same userId.
  // Only valid in worker mode where createVfsAdapter returns a
  // RemoteVfsAdapter for projects with remoteVfsUrl. Server backends
  // (vfsMode set) always use local adapters — must migrate regardless.
  if (sourceEncryption.hasSameKeyAs(encryption) && !deps.vfsMode) {
    for (const task of tasks) {
      push({
        type: 'vfs_migration_skipped',
        projectId: task.projectId,
        projectName: task.projectName,
        reason: 'CEKs match — remote VFS accessible with current key',
      });
    }
    return [];
  }

  const targetUserId = await encryption.deriveUserId();
  const errors: string[] = [];

  for (const task of tasks) {
    try {
      // Reconstruct the Project object from the task for adapter factories
      const project = (await storage.getProjects()).find(p => p.id === task.projectId);
      if (!project) {
        errors.push(`Project "${task.projectName}" not found after import`);
        continue;
      }

      const sourceAdapter = await deps.buildMigrationSourceAdapter(project, sourceEncryption);
      const targetAdapter = deps.createVfsAdapter!(deps, project, targetUserId);

      const result = await migrateProjectVfs(sourceAdapter, targetAdapter, progress => {
        push({
          type: 'vfs_migration_progress',
          projectId: task.projectId,
          projectName: task.projectName,
          ...progress,
        });
      });

      if (result.errors.length > 0) {
        errors.push(...result.errors.map(e => `"${task.projectName}": ${e}`));
      }

      // Strip remote VFS fields from the project record
      project.remoteVfsUrl = undefined;
      project.remoteVfsPassword = undefined;
      project.remoteVfsEncrypt = undefined;
      await storage.saveProject(project);

      console.debug(
        '[importRunner] VFS migration for',
        task.projectName,
        '— files:',
        result.filesCopied,
        'versions:',
        result.versionsCopied
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`Remote VFS migration for "${task.projectName}": ${msg}`);
      push({
        type: 'warning',
        message: `Failed to migrate remote VFS for "${task.projectName}": ${msg}`,
      });
    }
  }

  return errors;
}

/**
 * Migrate VFS table records to the filesystem adapter (scenario 4).
 *
 * Uses the bulk migration path: reads all files from VFS tables in a
 * single pass with parallel decryption (readAllForMigration), then
 * writes them to the target adapter with bounded concurrency.
 */
async function migrateTableToFilesystem(
  storage: UnifiedStorage,
  encryption: EncryptionCore,
  deps: BackendDeps,
  task: { projectId: string; projectName: string },
  push: (event: ImportProgress) => void
): Promise<void> {
  const vfsService = createVfsService(storage, encryption);

  // Check if source actually has files
  const hasData = await vfsService.hasVfs(task.projectId);
  if (!hasData) {
    console.debug(
      '[importRunner] VFS table→fs:',
      task.projectName,
      `(${task.projectId})`,
      '— no VFS data, skipping'
    );
    return;
  }

  console.debug(
    '[importRunner] VFS table→fs:',
    task.projectName,
    `(${task.projectId})`,
    '— starting bulk migration'
  );

  // Bulk read: single tree load, batch DB fetch, parallel decrypt
  const files = await vfsService.readAllForMigration(task.projectId);
  if (files.length === 0) {
    throw new Error('No files were found — VFS table records preserved for retry');
  }

  const targetUserId = await encryption.deriveUserId();
  const project = (await storage.getProjects()).find(p => p.id === task.projectId);
  if (!project) {
    console.debug(
      '[importRunner] VFS table→fs:',
      task.projectName,
      '— project not found, skipping'
    );
    return;
  }

  const targetAdapter = deps.createVfsAdapter!(deps, project, targetUserId);

  const result = await migrateProjectVfsBulk(files, targetAdapter, progress => {
    push({
      type: 'vfs_migration_progress',
      projectId: task.projectId,
      projectName: task.projectName,
      ...progress,
    });
  });

  if (result.errors.length > 0) {
    push({
      type: 'warning',
      message: `Partial VFS table→filesystem migration for "${task.projectName}": ${result.errors.length} errors`,
    });
  }

  // Only clean up VFS table records if migration was fully successful.
  // If there were errors or nothing was copied, keep the table data so
  // the user doesn't lose files permanently.
  if (result.errors.length > 0 || result.filesCopied === 0) {
    console.debug(
      '[importRunner] VFS table→filesystem for',
      task.projectName,
      '— skipping clearVfs:',
      result.filesCopied,
      'files,',
      result.errors.length,
      'errors'
    );
    if (result.filesCopied === 0) {
      throw new Error('No files were copied — VFS table records preserved for retry');
    }
    return;
  }

  // Use LocalVfsAdapter only for clearVfs
  const sourceAdapter = new LocalVfsAdapter(vfsService, task.projectId);
  await sourceAdapter.clearVfs();

  console.debug(
    '[importRunner] VFS table→filesystem for',
    task.projectName,
    '— files:',
    result.filesCopied,
    'versions:',
    result.versionsCopied
  );
}
