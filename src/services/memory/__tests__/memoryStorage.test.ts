import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  loadMemory,
  saveMemory,
  clearMemory,
  hasMemory,
  createEmptyFileSystem,
  saveJournalEntry,
  loadJournal,
  getJournalVersion,
  clearJournal,
  type MemoryFileSystem,
} from '../memoryStorage';
import { Tables } from '../../storage/StorageAdapter';

// Mock the storage module
vi.mock('../../storage', () => ({
  storage: {
    getAdapter: vi.fn(),
  },
}));

// Mock the encryption service
vi.mock('../../encryption/encryptionService', () => ({
  encryptionService: {
    encryptWithCompression: vi.fn(),
    decryptWithDecompression: vi.fn(),
  },
}));

import { storage } from '../../storage';
import { encryptionService } from '../../encryption/encryptionService';

describe('memoryStorage', () => {
  let mockAdapter: {
    get: ReturnType<typeof vi.fn>;
    save: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    mockAdapter = {
      get: vi.fn(),
      save: vi.fn(),
      delete: vi.fn(),
    };
    vi.mocked(storage.getAdapter).mockReturnValue(mockAdapter as any);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('createEmptyFileSystem', () => {
    it('should return empty filesystem structure', () => {
      const fs = createEmptyFileSystem();

      expect(fs).toEqual({ files: {} });
    });
  });

  describe('loadMemory', () => {
    it('should return empty filesystem when no record exists', async () => {
      mockAdapter.get.mockResolvedValue(null);

      const result = await loadMemory('proj_123');

      expect(mockAdapter.get).toHaveBeenCalledWith(Tables.MEMORIES, 'proj_123');
      expect(result).toEqual({ files: {} });
    });

    it('should decrypt and return filesystem from storage', async () => {
      const storedFs: MemoryFileSystem = {
        files: {
          'test.md': {
            content: '# Hello',
            createdAt: '2024-01-01T00:00:00Z',
            updatedAt: '2024-01-01T00:00:00Z',
          },
        },
      };

      mockAdapter.get.mockResolvedValue({ encryptedData: 'encrypted_data' });
      vi.mocked(encryptionService.decryptWithDecompression).mockResolvedValue(
        JSON.stringify(storedFs)
      );

      const result = await loadMemory('proj_123');

      expect(encryptionService.decryptWithDecompression).toHaveBeenCalledWith('encrypted_data');
      expect(result).toEqual(storedFs);
    });

    it('should return empty filesystem on decryption error', async () => {
      mockAdapter.get.mockResolvedValue({ encryptedData: 'corrupted' });
      vi.mocked(encryptionService.decryptWithDecompression).mockRejectedValue(
        new Error('Decryption failed')
      );

      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

      const result = await loadMemory('proj_123');

      expect(result).toEqual({ files: {} });
      expect(consoleError).toHaveBeenCalledWith(
        '[memoryStorage] Failed to load memory:',
        expect.any(Error)
      );

      consoleError.mockRestore();
    });

    it('should return empty filesystem on invalid JSON', async () => {
      mockAdapter.get.mockResolvedValue({ encryptedData: 'encrypted' });
      vi.mocked(encryptionService.decryptWithDecompression).mockResolvedValue('not valid json');

      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

      const result = await loadMemory('proj_123');

      expect(result).toEqual({ files: {} });

      consoleError.mockRestore();
    });

    it('should return empty filesystem when structure is missing files property', async () => {
      mockAdapter.get.mockResolvedValue({ encryptedData: 'encrypted' });
      vi.mocked(encryptionService.decryptWithDecompression).mockResolvedValue(
        JSON.stringify({ invalid: true })
      );

      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

      const result = await loadMemory('proj_123');

      expect(result).toEqual({ files: {} });
      expect(consoleError).toHaveBeenCalledWith(
        '[memoryStorage] Invalid memory structure, returning empty'
      );

      consoleError.mockRestore();
    });

    it('should return empty filesystem when files property is not an object', async () => {
      mockAdapter.get.mockResolvedValue({ encryptedData: 'encrypted' });
      vi.mocked(encryptionService.decryptWithDecompression).mockResolvedValue(
        JSON.stringify({ files: 'not an object' })
      );

      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

      const result = await loadMemory('proj_123');

      expect(result).toEqual({ files: {} });

      consoleError.mockRestore();
    });
  });

  describe('saveMemory', () => {
    it('should encrypt and save filesystem to storage', async () => {
      const fs: MemoryFileSystem = {
        files: {
          'notes.md': {
            content: '# Notes',
            createdAt: '2024-01-01T00:00:00Z',
            updatedAt: '2024-01-02T00:00:00Z',
          },
        },
      };

      vi.mocked(encryptionService.encryptWithCompression).mockResolvedValue('encrypted_blob');
      mockAdapter.save.mockResolvedValue(undefined);

      await saveMemory('proj_456', fs);

      expect(encryptionService.encryptWithCompression).toHaveBeenCalledWith(
        JSON.stringify(fs),
        true
      );
      expect(mockAdapter.save).toHaveBeenCalledWith(
        Tables.MEMORIES,
        'proj_456',
        'encrypted_blob',
        expect.objectContaining({
          timestamp: expect.any(String),
        })
      );
    });

    it('should save empty filesystem', async () => {
      const emptyFs = createEmptyFileSystem();

      vi.mocked(encryptionService.encryptWithCompression).mockResolvedValue('encrypted_empty');
      mockAdapter.save.mockResolvedValue(undefined);

      await saveMemory('proj_789', emptyFs);

      expect(encryptionService.encryptWithCompression).toHaveBeenCalledWith('{"files":{}}', true);
      expect(mockAdapter.save).toHaveBeenCalled();
    });

    it('should save filesystem with multiple files', async () => {
      const fs: MemoryFileSystem = {
        files: {
          'file1.md': {
            content: 'Content 1',
            createdAt: '2024-01-01T00:00:00Z',
            updatedAt: '2024-01-01T00:00:00Z',
          },
          'file2.md': {
            content: 'Content 2',
            createdAt: '2024-01-02T00:00:00Z',
            updatedAt: '2024-01-02T00:00:00Z',
          },
          'subdir/file3.md': {
            content: 'Content 3',
            createdAt: '2024-01-03T00:00:00Z',
            updatedAt: '2024-01-03T00:00:00Z',
          },
        },
      };

      vi.mocked(encryptionService.encryptWithCompression).mockResolvedValue('encrypted_multi');

      await saveMemory('proj_multi', fs);

      expect(encryptionService.encryptWithCompression).toHaveBeenCalledWith(
        expect.stringContaining('file1.md'),
        true
      );
    });
  });

  describe('clearMemory', () => {
    it('should delete memory record from storage', async () => {
      mockAdapter.delete.mockResolvedValue(undefined);

      await clearMemory('proj_to_clear');

      expect(mockAdapter.delete).toHaveBeenCalledWith(Tables.MEMORIES, 'proj_to_clear');
    });
  });

  describe('hasMemory', () => {
    it('should return true when memory record exists', async () => {
      mockAdapter.get.mockResolvedValue({ encryptedData: 'some_data' });

      const result = await hasMemory('proj_with_memory');

      expect(mockAdapter.get).toHaveBeenCalledWith(Tables.MEMORIES, 'proj_with_memory');
      expect(result).toBe(true);
    });

    it('should return false when memory record does not exist', async () => {
      mockAdapter.get.mockResolvedValue(null);

      const result = await hasMemory('proj_without_memory');

      expect(result).toBe(false);
    });
  });

  describe('Tables constant', () => {
    it('should use MEMORIES table', () => {
      expect(Tables.MEMORIES).toBe('memories');
    });

    it('should use MEMORY_JOURNALS table', () => {
      expect(Tables.MEMORY_JOURNALS).toBe('memory_journals');
    });
  });
});

describe('memoryStorage - Journal', () => {
  let mockAdapter: {
    get: ReturnType<typeof vi.fn>;
    save: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    count: ReturnType<typeof vi.fn>;
    deleteMany: ReturnType<typeof vi.fn>;
    exportPaginated: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    mockAdapter = {
      get: vi.fn(),
      save: vi.fn(),
      delete: vi.fn(),
      count: vi.fn(),
      deleteMany: vi.fn(),
      exportPaginated: vi.fn(),
    };
    vi.mocked(storage.getAdapter).mockReturnValue(mockAdapter as any);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('saveJournalEntry', () => {
    it('should encrypt and save journal entry with parentId', async () => {
      const entry = { command: 'create', path: '/memories/test.md', file_text: 'Hello' };
      vi.mocked(encryptionService.encryptWithCompression).mockResolvedValue('encrypted_entry');
      mockAdapter.save.mockResolvedValue(undefined);

      await saveJournalEntry('proj_123', entry);

      expect(encryptionService.encryptWithCompression).toHaveBeenCalledWith(
        JSON.stringify(entry),
        true
      );
      expect(mockAdapter.save).toHaveBeenCalledWith(
        Tables.MEMORY_JOURNALS,
        expect.stringMatching(/^jrnl_/),
        'encrypted_entry',
        expect.objectContaining({
          timestamp: expect.any(String),
          parentId: 'proj_123',
        })
      );
    });
  });

  describe('loadJournal', () => {
    it('should return empty array when no entries exist', async () => {
      mockAdapter.exportPaginated.mockResolvedValue({ rows: [], hasMore: false });

      const result = await loadJournal('proj_123');

      expect(result).toEqual([]);
    });

    it('should decrypt and return journal entries sorted by timestamp', async () => {
      const entry1 = { command: 'create', path: '/memories/a.md', file_text: 'A' };
      const entry2 = { command: 'str_replace', path: '/memories/a.md', old_str: 'A', new_str: 'B' };

      mockAdapter.exportPaginated.mockResolvedValue({
        rows: [
          {
            id: 'jrnl_1',
            parentId: 'proj_123',
            timestamp: '2024-01-01T00:00:00Z',
            encryptedData: 'enc1',
          },
          {
            id: 'jrnl_2',
            parentId: 'proj_123',
            timestamp: '2024-01-02T00:00:00Z',
            encryptedData: 'enc2',
          },
        ],
        hasMore: false,
      });

      vi.mocked(encryptionService.decryptWithDecompression)
        .mockResolvedValueOnce(JSON.stringify(entry1))
        .mockResolvedValueOnce(JSON.stringify(entry2));

      const result = await loadJournal('proj_123');

      expect(result).toHaveLength(2);
      expect(result[0].entry).toEqual(entry1);
      expect(result[1].entry).toEqual(entry2);
      expect(result[0].timestamp).toBe('2024-01-01T00:00:00Z');
    });

    it('should filter entries by parentId', async () => {
      const entry = { command: 'create', path: '/memories/a.md', file_text: 'A' };

      mockAdapter.exportPaginated.mockResolvedValue({
        rows: [
          {
            id: 'jrnl_1',
            parentId: 'proj_123',
            timestamp: '2024-01-01T00:00:00Z',
            encryptedData: 'enc1',
          },
          {
            id: 'jrnl_2',
            parentId: 'other_proj',
            timestamp: '2024-01-02T00:00:00Z',
            encryptedData: 'enc2',
          },
        ],
        hasMore: false,
      });

      vi.mocked(encryptionService.decryptWithDecompression).mockResolvedValue(
        JSON.stringify(entry)
      );

      const result = await loadJournal('proj_123');

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('jrnl_1');
    });

    it('should handle pagination', async () => {
      const entry = { command: 'create', path: '/memories/a.md', file_text: 'A' };

      mockAdapter.exportPaginated
        .mockResolvedValueOnce({
          rows: [
            {
              id: 'jrnl_1',
              parentId: 'proj_123',
              timestamp: '2024-01-01T00:00:00Z',
              encryptedData: 'enc1',
            },
          ],
          hasMore: true,
        })
        .mockResolvedValueOnce({
          rows: [
            {
              id: 'jrnl_2',
              parentId: 'proj_123',
              timestamp: '2024-01-02T00:00:00Z',
              encryptedData: 'enc2',
            },
          ],
          hasMore: false,
        });

      vi.mocked(encryptionService.decryptWithDecompression).mockResolvedValue(
        JSON.stringify(entry)
      );

      const result = await loadJournal('proj_123');

      expect(result).toHaveLength(2);
      expect(mockAdapter.exportPaginated).toHaveBeenCalledTimes(2);
    });

    it('should skip entries with decryption errors', async () => {
      const entry = { command: 'create', path: '/memories/a.md', file_text: 'A' };

      mockAdapter.exportPaginated.mockResolvedValue({
        rows: [
          {
            id: 'jrnl_1',
            parentId: 'proj_123',
            timestamp: '2024-01-01T00:00:00Z',
            encryptedData: 'enc1',
          },
          {
            id: 'jrnl_2',
            parentId: 'proj_123',
            timestamp: '2024-01-02T00:00:00Z',
            encryptedData: 'corrupted',
          },
        ],
        hasMore: false,
      });

      vi.mocked(encryptionService.decryptWithDecompression)
        .mockResolvedValueOnce(JSON.stringify(entry))
        .mockRejectedValueOnce(new Error('Decryption failed'));

      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

      const result = await loadJournal('proj_123');

      expect(result).toHaveLength(1);
      expect(consoleError).toHaveBeenCalledWith(
        '[memoryStorage] Failed to decrypt journal entry:',
        'jrnl_2',
        expect.any(Error)
      );

      consoleError.mockRestore();
    });
  });

  describe('getJournalVersion', () => {
    it('should return count of journal entries for project', async () => {
      mockAdapter.count.mockResolvedValue(5);

      const result = await getJournalVersion('proj_123');

      expect(mockAdapter.count).toHaveBeenCalledWith(Tables.MEMORY_JOURNALS, {
        parentId: 'proj_123',
      });
      expect(result).toBe(5);
    });

    it('should return 0 when no entries exist', async () => {
      mockAdapter.count.mockResolvedValue(0);

      const result = await getJournalVersion('proj_empty');

      expect(result).toBe(0);
    });
  });

  describe('clearJournal', () => {
    it('should delete all journal entries for project', async () => {
      mockAdapter.deleteMany.mockResolvedValue(undefined);

      await clearJournal('proj_123');

      expect(mockAdapter.deleteMany).toHaveBeenCalledWith(Tables.MEMORY_JOURNALS, {
        parentId: 'proj_123',
      });
    });
  });
});
