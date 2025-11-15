/**
 * Memory Storage Service
 *
 * Handles persistent storage for the memory tool filesystem.
 * Uses compression + encryption (same as messages) for space efficiency.
 * Keyed by projectId - one memory filesystem per project.
 */

import { encryptionService } from '../encryption/encryptionService';
import { storage } from '../storage';
import { Tables } from '../storage/StorageAdapter';
import { generateUniqueId } from '../../utils/idGenerator';

/**
 * A single file in the memory filesystem
 */
export interface MemoryFile {
  content: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * The entire memory filesystem for a project
 */
export interface MemoryFileSystem {
  files: Record<string, MemoryFile>;
}

/**
 * Create an empty memory filesystem
 */
export function createEmptyFileSystem(): MemoryFileSystem {
  return { files: {} };
}

/**
 * Load memory filesystem for a project
 * @param projectId - Project ID (used as key)
 * @returns The memory filesystem, or empty if none exists
 */
export async function loadMemory(projectId: string): Promise<MemoryFileSystem> {
  const adapter = storage.getAdapter();
  const record = await adapter.get(Tables.MEMORIES, projectId);

  if (!record) {
    return createEmptyFileSystem();
  }

  try {
    // Use decompression (same pattern as messages)
    const json = await encryptionService.decryptWithDecompression(record.encryptedData);
    const data = JSON.parse(json) as MemoryFileSystem;

    // Validate structure
    if (!data.files || typeof data.files !== 'object') {
      console.error('[memoryStorage] Invalid memory structure, returning empty');
      return createEmptyFileSystem();
    }

    return data;
  } catch (error) {
    console.error('[memoryStorage] Failed to load memory:', error);
    return createEmptyFileSystem();
  }
}

/**
 * Save memory filesystem for a project
 * @param projectId - Project ID (used as key)
 * @param fs - The memory filesystem to save
 */
export async function saveMemory(projectId: string, fs: MemoryFileSystem): Promise<void> {
  const adapter = storage.getAdapter();

  // Use compression + encryption (same pattern as messages)
  const encrypted = await encryptionService.encryptWithCompression(JSON.stringify(fs), true);

  await adapter.save(Tables.MEMORIES, projectId, encrypted, {
    timestamp: new Date().toISOString(),
  });
}

/**
 * Clear memory filesystem for a project
 * @param projectId - Project ID
 */
export async function clearMemory(projectId: string): Promise<void> {
  const adapter = storage.getAdapter();
  await adapter.delete(Tables.MEMORIES, projectId);
}

/**
 * Check if a project has any memory data
 * @param projectId - Project ID
 * @returns true if memory exists
 */
export async function hasMemory(projectId: string): Promise<boolean> {
  const adapter = storage.getAdapter();
  const record = await adapter.get(Tables.MEMORIES, projectId);
  return record !== null;
}

// ============================================================================
// Journal Storage
// ============================================================================

/**
 * Journal entry - raw tool call parameters stored per write operation
 */
export type JournalEntry = Record<string, unknown>;

/**
 * Journal entry with metadata (returned from loadJournal)
 */
export interface JournalEntryWithMeta {
  id: string;
  timestamp: string;
  entry: JournalEntry;
}

/**
 * Save a journal entry for a memory write operation
 * @param projectId - Project ID (parentId for the journal)
 * @param entry - Raw tool call parameters
 */
export async function saveJournalEntry(projectId: string, entry: JournalEntry): Promise<void> {
  const adapter = storage.getAdapter();
  const id = generateUniqueId('jrnl');
  const timestamp = new Date().toISOString();

  const encrypted = await encryptionService.encryptWithCompression(JSON.stringify(entry), true);

  await adapter.save(Tables.MEMORY_JOURNALS, id, encrypted, {
    timestamp,
    parentId: projectId,
  });
}

/**
 * Load all journal entries for a project, sorted by timestamp
 * @param projectId - Project ID
 * @returns Journal entries in chronological order (oldest first)
 */
export async function loadJournal(projectId: string): Promise<JournalEntryWithMeta[]> {
  const adapter = storage.getAdapter();
  const entries: JournalEntryWithMeta[] = [];

  // Use exportPaginated to get IDs and timestamps along with encrypted data
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
        console.error('[memoryStorage] Failed to decrypt journal entry:', row.id, error);
      }
    }

    hasMore = page.hasMore;
    if (page.rows.length > 0) {
      afterId = page.rows[page.rows.length - 1].id;
    } else {
      hasMore = false;
    }
  }

  // Sort by timestamp (should already be sorted, but ensure it)
  entries.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  return entries;
}

/**
 * Get the current version number (count of journal entries)
 * @param projectId - Project ID
 * @returns Version number (0 if no entries)
 */
export async function getJournalVersion(projectId: string): Promise<number> {
  const adapter = storage.getAdapter();
  return adapter.count(Tables.MEMORY_JOURNALS, { parentId: projectId });
}

/**
 * Clear all journal entries for a project
 * @param projectId - Project ID
 */
export async function clearJournal(projectId: string): Promise<void> {
  const adapter = storage.getAdapter();
  await adapter.deleteMany(Tables.MEMORY_JOURNALS, { parentId: projectId });
}
