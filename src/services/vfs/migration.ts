/**
 * VFS Migration Service
 *
 * Migrates data from the old flat memory system (memories + memory_journals tables)
 * to the new VFS tree-structured filesystem with per-file versioning.
 *
 * Migration strategy:
 * 1. Replay journal entries using VFS operations (auto-versions)
 * 2. Compare final VFS state with current memories table
 * 3. Sync differences (create/update/delete)
 * 4. Delete old memories + memory_journals records
 */

import type { StorageAdapter } from '../storage/StorageAdapter';
import { Tables } from '../storage/StorageAdapter';
import { encryptionService } from '../encryption/encryptionService';
import * as vfs from './vfsService';
import { VfsError, VfsErrorCode } from './vfsService';

const MEMORIES_ROOT = '/memories';

// ============================================================================
// Old Data Types (from deleted memoryStorage.ts)
// ============================================================================

interface MemoryFile {
  content: string;
  createdAt: string;
  updatedAt: string;
}

interface MemoryFileSystem {
  files: Record<string, MemoryFile>;
}

interface JournalEntry {
  command?: string;
  path?: string;
  file_text?: string;
  old_str?: string;
  new_str?: string;
  insert_line?: number;
  insert_text?: string;
  old_path?: string;
  new_path?: string;
}

interface JournalEntryWithMeta {
  id: string;
  timestamp: string;
  entry: JournalEntry;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Load old memory filesystem for a project
 */
async function loadOldMemories(
  adapter: StorageAdapter,
  projectId: string
): Promise<MemoryFileSystem | null> {
  const record = await adapter.get(Tables.MEMORIES, projectId);
  if (!record) return null;

  try {
    const json = await encryptionService.decryptWithDecompression(record.encryptedData);
    const data = JSON.parse(json) as MemoryFileSystem;

    if (!data.files || typeof data.files !== 'object') {
      console.debug('[migration] Invalid memory structure for project', projectId);
      return null;
    }

    return data;
  } catch (error) {
    console.error('[migration] Failed to decrypt memories for project', projectId, error);
    return null;
  }
}

/**
 * Load old journal entries for a project, sorted by timestamp
 */
async function loadOldJournal(
  adapter: StorageAdapter,
  projectId: string
): Promise<JournalEntryWithMeta[]> {
  const entries: JournalEntryWithMeta[] = [];

  let afterId: string | undefined;
  let hasMore = true;

  while (hasMore) {
    const page = await adapter.exportPaginated(Tables.MEMORY_JOURNALS, afterId);

    for (const row of page.rows) {
      if (row.parentId !== projectId) continue;

      try {
        const json = await encryptionService.decryptWithDecompression(row.encryptedData);
        const entry = JSON.parse(json) as JournalEntry;
        entries.push({
          id: row.id,
          timestamp: row.timestamp || '',
          entry,
        });
      } catch (error) {
        console.error('[migration] Failed to decrypt journal entry', row.id, error);
      }
    }

    hasMore = page.hasMore;
    if (page.rows.length > 0) {
      afterId = page.rows[page.rows.length - 1].id;
    } else {
      hasMore = false;
    }
  }

  // Sort by timestamp (chronological order)
  entries.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  return entries;
}

/**
 * Normalize a path from old memory format to VFS path
 * Old paths could be "/memories/file.md" or "file.md" - normalize to "/memories/file.md"
 */
function normalizeMemoryPath(path: string): string {
  let normalized = path.trim();

  // Remove leading /memories/ or /memories prefix
  if (normalized.startsWith(MEMORIES_ROOT + '/')) {
    normalized = normalized.slice(MEMORIES_ROOT.length + 1);
  } else if (normalized === MEMORIES_ROOT) {
    return MEMORIES_ROOT;
  } else if (normalized.startsWith('/')) {
    normalized = normalized.slice(1);
  }

  if (!normalized) {
    return MEMORIES_ROOT;
  }

  return `${MEMORIES_ROOT}/${normalized}`;
}

/**
 * Replay a single journal entry using VFS operations
 */
async function replayJournalEntry(
  projectId: string,
  entry: JournalEntry
): Promise<{ success: boolean; error?: string }> {
  try {
    switch (entry.command) {
      case 'create': {
        if (!entry.path || entry.file_text === undefined) {
          return { success: false, error: 'create: missing path or file_text' };
        }
        const vfsPath = normalizeMemoryPath(entry.path);

        // Ensure /memories directory exists
        const memoriesExists = await vfs.exists(projectId, MEMORIES_ROOT);
        if (!memoriesExists) {
          await vfs.mkdir(projectId, MEMORIES_ROOT);
        }

        // Try to create, ignore if already exists
        try {
          await vfs.createFile(projectId, vfsPath, entry.file_text);
        } catch (error) {
          if (error instanceof VfsError && error.code === VfsErrorCode.FILE_EXISTS) {
            // File already exists, update instead
            await vfs.updateFile(projectId, vfsPath, entry.file_text);
          } else {
            throw error;
          }
        }
        return { success: true };
      }

      case 'str_replace': {
        if (!entry.path || !entry.old_str || entry.new_str === undefined) {
          return { success: false, error: 'str_replace: missing path, old_str, or new_str' };
        }
        const vfsPath = normalizeMemoryPath(entry.path);
        try {
          await vfs.strReplace(projectId, vfsPath, entry.old_str, entry.new_str);
        } catch (error) {
          if (error instanceof VfsError) {
            // Log but continue - file might not exist yet or string not found
            console.debug('[migration] str_replace skipped:', error.message);
          } else {
            throw error;
          }
        }
        return { success: true };
      }

      case 'insert': {
        if (!entry.path || entry.insert_line === undefined || entry.insert_text === undefined) {
          return { success: false, error: 'insert: missing path, insert_line, or insert_text' };
        }
        const vfsPath = normalizeMemoryPath(entry.path);
        try {
          await vfs.insert(projectId, vfsPath, entry.insert_line, entry.insert_text);
        } catch (error) {
          if (error instanceof VfsError) {
            console.debug('[migration] insert skipped:', error.message);
          } else {
            throw error;
          }
        }
        return { success: true };
      }

      case 'delete': {
        if (!entry.path) {
          return { success: false, error: 'delete: missing path' };
        }
        const vfsPath = normalizeMemoryPath(entry.path);
        try {
          await vfs.deleteFile(projectId, vfsPath);
        } catch (error) {
          if (error instanceof VfsError && error.code === VfsErrorCode.PATH_NOT_FOUND) {
            // Already deleted or never existed
            console.debug('[migration] delete skipped: path not found');
          } else {
            throw error;
          }
        }
        return { success: true };
      }

      case 'rename': {
        if (!entry.old_path || !entry.new_path) {
          return { success: false, error: 'rename: missing old_path or new_path' };
        }
        const oldVfsPath = normalizeMemoryPath(entry.old_path);
        const newVfsPath = normalizeMemoryPath(entry.new_path);
        try {
          await vfs.rename(projectId, oldVfsPath, newVfsPath);
        } catch (error) {
          if (error instanceof VfsError) {
            console.debug('[migration] rename skipped:', error.message);
          } else {
            throw error;
          }
        }
        return { success: true };
      }

      case undefined:
      default:
        console.debug('[migration] Unknown or missing journal command:', entry.command);
        return { success: true }; // Skip unknown commands
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { success: false, error: msg };
  }
}

/**
 * Get all file paths currently in VFS under /memories
 */
async function getVfsFilePaths(projectId: string): Promise<Set<string>> {
  const paths = new Set<string>();

  const memoriesExists = await vfs.exists(projectId, MEMORIES_ROOT);
  if (!memoriesExists) return paths;

  try {
    const entries = await vfs.readDir(projectId, MEMORIES_ROOT);
    for (const entry of entries) {
      if (entry.type === 'file' && !entry.deleted) {
        paths.add(`${MEMORIES_ROOT}/${entry.name}`);
      }
    }
  } catch {
    // Directory might not exist
  }

  return paths;
}

// ============================================================================
// Public Migration API
// ============================================================================

export interface MigrationResult {
  projectId: string;
  journalEntriesReplayed: number;
  filesCreated: number;
  filesUpdated: number;
  filesDeleted: number;
  errors: string[];
}

/**
 * Migrate a single project from old memory format to VFS
 * Idempotent: skips if VFS data already exists
 */
export async function migrateProjectMemories(
  adapter: StorageAdapter,
  projectId: string
): Promise<MigrationResult> {
  const result: MigrationResult = {
    projectId,
    journalEntriesReplayed: 0,
    filesCreated: 0,
    filesUpdated: 0,
    filesDeleted: 0,
    errors: [],
  };

  console.debug('[migration] Starting migration for project', projectId);

  // Check if VFS data already exists (idempotent)
  const hasVfsData = await vfs.hasVfs(projectId);
  if (hasVfsData) {
    console.debug('[migration] VFS data already exists, skipping project', projectId);
    return result;
  }

  // Load old memories (current authoritative state)
  const oldMemories = await loadOldMemories(adapter, projectId);

  // Load journal entries
  const journal = await loadOldJournal(adapter, projectId);

  // If no old data at all, nothing to migrate
  if (!oldMemories && journal.length === 0) {
    console.debug('[migration] No old data to migrate for project', projectId);
    return result;
  }

  console.debug(
    '[migration] Found',
    Object.keys(oldMemories?.files || {}).length,
    'files and',
    journal.length,
    'journal entries'
  );

  // Step 1: Replay journal entries (builds version history)
  for (const journalEntry of journal) {
    const { success, error } = await replayJournalEntry(projectId, journalEntry.entry);
    if (success) {
      result.journalEntriesReplayed++;
    } else if (error) {
      result.errors.push(`Journal ${journalEntry.id}: ${error}`);
    }
  }

  console.debug('[migration] Replayed', result.journalEntriesReplayed, 'journal entries');

  // Step 2: Compare VFS state with current memories and sync
  if (oldMemories) {
    const currentVfsPaths = await getVfsFilePaths(projectId);
    const currentMemoryPaths = new Set<string>();

    // Ensure /memories directory exists
    const memoriesExists = await vfs.exists(projectId, MEMORIES_ROOT);
    if (!memoriesExists) {
      await vfs.mkdir(projectId, MEMORIES_ROOT);
    }

    // Sync each file from old memories
    for (const [path, file] of Object.entries(oldMemories.files)) {
      const vfsPath = normalizeMemoryPath(path);
      currentMemoryPaths.add(vfsPath);

      try {
        const vfsExists = await vfs.exists(projectId, vfsPath);

        if (!vfsExists) {
          // File doesn't exist in VFS - create it
          await vfs.createFile(projectId, vfsPath, file.content);
          result.filesCreated++;
        } else {
          // File exists - check if content matches
          const vfsContent = await vfs.readFile(projectId, vfsPath);
          if (vfsContent !== file.content) {
            await vfs.updateFile(projectId, vfsPath, file.content);
            result.filesUpdated++;
          }
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        result.errors.push(`Sync ${vfsPath}: ${msg}`);
      }
    }

    // Delete files that exist in VFS but not in current memories
    for (const vfsPath of currentVfsPaths) {
      if (!currentMemoryPaths.has(vfsPath)) {
        try {
          await vfs.deleteFile(projectId, vfsPath);
          result.filesDeleted++;
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          result.errors.push(`Delete ${vfsPath}: ${msg}`);
        }
      }
    }
  }

  console.debug(
    '[migration] Sync complete:',
    result.filesCreated,
    'created,',
    result.filesUpdated,
    'updated,',
    result.filesDeleted,
    'deleted'
  );

  // Step 3: Cleanup old data
  try {
    // Delete old memories record
    await adapter.delete(Tables.MEMORIES, projectId);
    console.debug('[migration] Deleted old memories record');

    // Delete old journal entries
    await adapter.deleteMany(Tables.MEMORY_JOURNALS, { parentId: projectId });
    console.debug('[migration] Deleted old journal entries');
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    result.errors.push(`Cleanup: ${msg}`);
  }

  console.debug('[migration] Migration complete for project', projectId);
  return result;
}

/**
 * Migrate all projects from old memory format to VFS
 * Called during storage initialization
 */
export async function migrateAllMemories(
  adapter: StorageAdapter
): Promise<{ migrated: number; skipped: number; errors: string[] }> {
  console.debug('[migration] Starting migration of all memory data...');

  const stats = {
    migrated: 0,
    skipped: 0,
    errors: [] as string[],
  };

  // Find all projects that have old memories data
  const projectIds = new Set<string>();

  // Check memories table
  let afterId: string | undefined;
  let hasMore = true;

  while (hasMore) {
    const page = await adapter.exportPaginated(Tables.MEMORIES, afterId, ['id']);

    for (const row of page.rows) {
      if (row.id) {
        projectIds.add(row.id);
      }
    }

    hasMore = page.hasMore;
    if (page.rows.length > 0) {
      afterId = page.rows[page.rows.length - 1].id;
    } else {
      hasMore = false;
    }
  }

  // Also check memory_journals for projectIds (parentId)
  afterId = undefined;
  hasMore = true;

  while (hasMore) {
    const page = await adapter.exportPaginated(Tables.MEMORY_JOURNALS, afterId, ['id', 'parentId']);

    for (const row of page.rows) {
      if (row.parentId) {
        projectIds.add(row.parentId);
      }
    }

    hasMore = page.hasMore;
    if (page.rows.length > 0) {
      afterId = page.rows[page.rows.length - 1].id;
    } else {
      hasMore = false;
    }
  }

  if (projectIds.size === 0) {
    console.debug('[migration] No old memory data found, nothing to migrate');
    return stats;
  }

  console.debug('[migration] Found', projectIds.size, 'projects with old memory data');

  // Migrate each project
  for (const projectId of projectIds) {
    try {
      const result = await migrateProjectMemories(adapter, projectId);

      if (
        result.journalEntriesReplayed > 0 ||
        result.filesCreated > 0 ||
        result.filesUpdated > 0 ||
        result.filesDeleted > 0
      ) {
        stats.migrated++;
      } else if (result.errors.length === 0) {
        stats.skipped++;
      }

      stats.errors.push(...result.errors);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      stats.errors.push(`Project ${projectId}: ${msg}`);
    }
  }

  console.debug(
    '[migration] Migration complete:',
    stats.migrated,
    'migrated,',
    stats.skipped,
    'skipped,',
    stats.errors.length,
    'errors'
  );

  return stats;
}
