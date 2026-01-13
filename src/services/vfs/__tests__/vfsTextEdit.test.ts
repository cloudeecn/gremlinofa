/**
 * VFS Text Editing Tests
 *
 * Tests for LLM-style edit operations:
 * - strReplace (unique string replacement)
 * - insert (line-based insertion)
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
  createFile,
  readFile,
  strReplace,
  insert,
  getFileMeta,
  formatSnippet,
} from '../vfsService';

describe('VFS Text Editing', () => {
  const projectId = 'test-project';

  beforeEach(() => {
    mockStorage.clear();
  });

  describe('formatSnippet', () => {
    it('formats content with line numbers', () => {
      const content = 'line1\nline2\nline3\nline4\nline5';
      const snippet = formatSnippet(content, 3, 1);

      expect(snippet).toContain('2\t');
      expect(snippet).toContain('line2');
      expect(snippet).toContain('3\t');
      expect(snippet).toContain('line3');
      expect(snippet).toContain('4\t');
      expect(snippet).toContain('line4');
    });

    it('respects content boundaries', () => {
      const content = 'line1\nline2';
      const snippet = formatSnippet(content, 1, 5);

      // Should include all lines since context extends beyond file
      expect(snippet).toContain('line1');
      expect(snippet).toContain('line2');
    });
  });

  describe('strReplace', () => {
    it('replaces unique string and returns edit info', async () => {
      await createFile(projectId, '/test.txt', 'hello world\nfoo bar\nbaz qux');

      const result = await strReplace(projectId, '/test.txt', 'foo', 'FOO');

      expect(result.editLine).toBe(2);
      expect(result.snippet).toContain('FOO bar');

      const content = await readFile(projectId, '/test.txt');
      expect(content).toBe('hello world\nFOO bar\nbaz qux');
    });

    it('creates a new version on replace', async () => {
      await createFile(projectId, '/test.txt', 'original content');

      let meta = await getFileMeta(projectId, '/test.txt');
      expect(meta?.version).toBe(1);

      await strReplace(projectId, '/test.txt', 'original', 'modified');

      meta = await getFileMeta(projectId, '/test.txt');
      expect(meta?.version).toBe(2);
    });

    it('throws STRING_NOT_FOUND when string missing', async () => {
      await createFile(projectId, '/test.txt', 'hello world');

      await expect(strReplace(projectId, '/test.txt', 'nonexistent', 'x')).rejects.toMatchObject({
        code: 'STRING_NOT_FOUND',
      });
    });

    it('throws STRING_NOT_UNIQUE when multiple occurrences', async () => {
      await createFile(projectId, '/test.txt', 'foo bar foo baz foo');

      await expect(strReplace(projectId, '/test.txt', 'foo', 'FOO')).rejects.toMatchObject({
        code: 'STRING_NOT_UNIQUE',
      });
    });

    it('includes line numbers in STRING_NOT_UNIQUE error', async () => {
      await createFile(projectId, '/test.txt', 'line1 foo\nline2\nline3 foo');

      try {
        await strReplace(projectId, '/test.txt', 'foo', 'bar');
        expect.fail('Should have thrown');
      } catch (e) {
        expect((e as Error).message).toMatch(/lines.*1.*3/);
      }
    });

    it('handles multi-line replacement', async () => {
      await createFile(projectId, '/test.txt', 'start\nmiddle\nend');

      await strReplace(projectId, '/test.txt', 'middle', 'new\nlines\nhere');

      const content = await readFile(projectId, '/test.txt');
      expect(content).toBe('start\nnew\nlines\nhere\nend');
    });

    it('handles multi-line search string', async () => {
      await createFile(projectId, '/test.txt', 'header\nold line1\nold line2\nfooter');

      await strReplace(projectId, '/test.txt', 'old line1\nold line2', 'new content');

      const content = await readFile(projectId, '/test.txt');
      expect(content).toBe('header\nnew content\nfooter');
    });

    it('throws for non-existent file', async () => {
      await expect(strReplace(projectId, '/nonexistent.txt', 'a', 'b')).rejects.toMatchObject({
        code: 'PATH_NOT_FOUND',
      });
    });
  });

  describe('insert', () => {
    it('inserts at beginning (line 0)', async () => {
      await createFile(projectId, '/test.txt', 'line1\nline2');

      await insert(projectId, '/test.txt', 0, 'new first');

      const content = await readFile(projectId, '/test.txt');
      expect(content).toBe('new first\nline1\nline2');
    });

    it('inserts in middle', async () => {
      await createFile(projectId, '/test.txt', 'line1\nline2\nline3');

      await insert(projectId, '/test.txt', 2, 'inserted');

      const content = await readFile(projectId, '/test.txt');
      expect(content).toBe('line1\nline2\ninserted\nline3');
    });

    it('inserts at end', async () => {
      await createFile(projectId, '/test.txt', 'line1\nline2');

      await insert(projectId, '/test.txt', 2, 'new last');

      const content = await readFile(projectId, '/test.txt');
      expect(content).toBe('line1\nline2\nnew last');
    });

    it('creates a new version on insert', async () => {
      await createFile(projectId, '/test.txt', 'content');

      let meta = await getFileMeta(projectId, '/test.txt');
      expect(meta?.version).toBe(1);

      await insert(projectId, '/test.txt', 1, 'more');

      meta = await getFileMeta(projectId, '/test.txt');
      expect(meta?.version).toBe(2);
    });

    it('throws INVALID_LINE for negative line', async () => {
      await createFile(projectId, '/test.txt', 'content');

      await expect(insert(projectId, '/test.txt', -1, 'x')).rejects.toMatchObject({
        code: 'INVALID_LINE',
      });
    });

    it('throws INVALID_LINE for line beyond file', async () => {
      await createFile(projectId, '/test.txt', 'line1\nline2'); // 2 lines

      await expect(insert(projectId, '/test.txt', 5, 'x')).rejects.toMatchObject({
        code: 'INVALID_LINE',
      });
    });

    it('handles multi-line insert text', async () => {
      await createFile(projectId, '/test.txt', 'before\nafter');

      await insert(projectId, '/test.txt', 1, 'line a\nline b\nline c');

      const content = await readFile(projectId, '/test.txt');
      expect(content).toBe('before\nline a\nline b\nline c\nafter');
    });

    it('returns insertion location', async () => {
      await createFile(projectId, '/test.txt', 'line1\nline2');

      const result = await insert(projectId, '/test.txt', 1, 'inserted');

      expect(result.insertedAt).toBe(1);
    });

    it('throws for non-existent file', async () => {
      await expect(insert(projectId, '/nonexistent.txt', 0, 'x')).rejects.toMatchObject({
        code: 'PATH_NOT_FOUND',
      });
    });
  });

  describe('combined operations', () => {
    it('can chain str_replace and insert', async () => {
      await createFile(projectId, '/test.txt', 'function foo() {\n  return 1;\n}');

      // Replace function name
      await strReplace(projectId, '/test.txt', 'foo', 'bar');

      // Insert a comment
      await insert(projectId, '/test.txt', 0, '// This is bar function');

      const content = await readFile(projectId, '/test.txt');
      expect(content).toBe('// This is bar function\nfunction bar() {\n  return 1;\n}');

      // Should be at version 3
      const meta = await getFileMeta(projectId, '/test.txt');
      expect(meta?.version).toBe(3);
    });
  });
});
