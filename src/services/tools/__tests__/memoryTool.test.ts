import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MemoryToolInstance, disposeMemoryTool } from '../memoryTool';
import type { MemoryFileSystem } from '../../memory/memoryStorage';

// Mock memoryStorage to prevent actual storage calls
vi.mock('../../memory/memoryStorage', async importOriginal => {
  const actual = await importOriginal<typeof import('../../memory/memoryStorage')>();
  return {
    ...actual,
    saveMemory: vi.fn().mockResolvedValue(undefined),
    loadMemory: vi.fn().mockResolvedValue({ files: {} }),
    saveJournalEntry: vi.fn().mockResolvedValue(undefined),
  };
});

describe('MemoryToolInstance', () => {
  let instance: MemoryToolInstance;

  beforeEach(() => {
    instance = new MemoryToolInstance('test-project');
  });

  describe('view command', () => {
    it('returns empty directory listing with correct header', async () => {
      const result = await instance.execute({
        command: 'view',
        path: '/memories',
      });

      expect(result.content).toContain(
        "Here're the files and directories up to 2 levels deep in /memories, excluding hidden items and node_modules:"
      );
      expect(result.content).toContain('(empty)');
      expect(result.isError).toBeFalsy();
    });

    it('returns directory listing with files and sizes', async () => {
      const fs: MemoryFileSystem = {
        files: {
          'notes.md': { content: 'test content here', createdAt: '', updatedAt: '' },
          'tasks.md': { content: 'more content', createdAt: '', updatedAt: '' },
        },
      };
      instance = new MemoryToolInstance('test-project', fs);

      const result = await instance.execute({
        command: 'view',
        path: '/memories',
      });

      expect(result.content).toContain('notes.md');
      expect(result.content).toContain('tasks.md');
      // Should have size and path format
      expect(result.content).toMatch(/\d+\t\/memories\/notes\.md/);
      expect(result.isError).toBeFalsy();
    });

    it('returns file content with line numbers', async () => {
      const fs: MemoryFileSystem = {
        files: {
          'test.md': {
            content: 'Line 1\nLine 2\nLine 3',
            createdAt: '',
            updatedAt: '',
          },
        },
      };
      instance = new MemoryToolInstance('test-project', fs);

      const result = await instance.execute({
        command: 'view',
        path: '/memories/test.md',
      });

      expect(result.content).toContain("Here's the content of /memories/test.md");
      // Line numbers should be 6-char right-aligned with tab
      expect(result.content).toContain('     1\tLine 1');
      expect(result.content).toContain('     2\tLine 2');
      expect(result.content).toContain('     3\tLine 3');
      expect(result.isError).toBeFalsy();
    });

    it('supports view_range parameter', async () => {
      const fs: MemoryFileSystem = {
        files: {
          'test.md': {
            content: 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5',
            createdAt: '',
            updatedAt: '',
          },
        },
      };
      instance = new MemoryToolInstance('test-project', fs);

      const result = await instance.execute({
        command: 'view',
        path: '/memories/test.md',
        view_range: [2, 4],
      });

      expect(result.content).toContain('     2\tLine 2');
      expect(result.content).toContain('     3\tLine 3');
      expect(result.content).toContain('     4\tLine 4');
      expect(result.content).not.toContain('Line 1');
      expect(result.content).not.toContain('Line 5');
      expect(result.isError).toBeFalsy();
    });

    it('returns error for non-existent file', async () => {
      const result = await instance.execute({
        command: 'view',
        path: '/memories/nonexistent.md',
      });

      expect(result.content).toBe(
        'The path /memories/nonexistent.md does not exist. Please provide a valid path.'
      );
      expect(result.isError).toBe(true);
    });

    it('handles path without /memories prefix', async () => {
      const fs: MemoryFileSystem = {
        files: {
          'test.md': { content: 'content', createdAt: '', updatedAt: '' },
        },
      };
      instance = new MemoryToolInstance('test-project', fs);

      const result = await instance.execute({
        command: 'view',
        path: 'test.md',
      });

      expect(result.content).toContain("Here's the content of /memories/test.md");
      expect(result.isError).toBeFalsy();
    });

    it('returns error when file exceeds 999,999 line limit', async () => {
      // Create content with 1,000,001 lines (exceeds limit)
      const lines = new Array(1000001).fill('line');
      const fs: MemoryFileSystem = {
        files: {
          'huge.txt': { content: lines.join('\n'), createdAt: '', updatedAt: '' },
        },
      };
      instance = new MemoryToolInstance('test-project', fs);

      const result = await instance.execute({
        command: 'view',
        path: '/memories/huge.txt',
      });

      expect(result.content).toBe(
        'File /memories/huge.txt exceeds maximum line limit of 999999 lines.'
      );
      expect(result.isError).toBe(true);
    });
  });

  describe('create command', () => {
    it('creates new file successfully', async () => {
      const result = await instance.execute({
        command: 'create',
        path: '/memories/new.md',
        file_text: 'New content',
      });

      expect(result.content).toBe('File created successfully at: /memories/new.md');
      expect(result.isError).toBeFalsy();

      // Verify file exists
      const fs = instance.getFileSystem();
      expect(fs.files['new.md']).toBeDefined();
      expect(fs.files['new.md'].content).toBe('New content');
    });

    it('returns error when file exists', async () => {
      const fs: MemoryFileSystem = {
        files: {
          'existing.md': { content: 'old', createdAt: '', updatedAt: '' },
        },
      };
      instance = new MemoryToolInstance('test-project', fs);

      const result = await instance.execute({
        command: 'create',
        path: '/memories/existing.md',
        file_text: 'new content',
      });

      expect(result.content).toBe('Error: File /memories/existing.md already exists');
      expect(result.isError).toBe(true);
    });

    it('returns error when creating at root path', async () => {
      const result = await instance.execute({
        command: 'create',
        path: '/memories',
        file_text: 'content',
      });

      expect(result.content).toContain('Cannot create a file at the root path');
      expect(result.isError).toBe(true);
    });

    it('sets dirty flag after create', async () => {
      expect(instance.isDirty()).toBe(false);

      await instance.execute({
        command: 'create',
        path: '/memories/test.md',
        file_text: 'content',
      });

      // Dirty flag is cleared after auto-save
      expect(instance.isDirty()).toBe(false);
    });
  });

  describe('str_replace command', () => {
    it('replaces string in file and returns snippet', async () => {
      const fs: MemoryFileSystem = {
        files: {
          'test.md': {
            content: 'Hello world',
            createdAt: '2024-01-01',
            updatedAt: '2024-01-01',
          },
        },
      };
      instance = new MemoryToolInstance('test-project', fs);

      const result = await instance.execute({
        command: 'str_replace',
        path: '/memories/test.md',
        old_str: 'world',
        new_str: 'universe',
      });

      expect(result.content).toContain('The memory file has been edited.');
      // Should include snippet with line numbers
      expect(result.content).toContain('Hello universe');
      expect(result.isError).toBeFalsy();

      const updatedFs = instance.getFileSystem();
      expect(updatedFs.files['test.md'].content).toBe('Hello universe');
    });

    it('returns snippet with 6-char right-aligned line numbers after replacement', async () => {
      const fs: MemoryFileSystem = {
        files: {
          'test.md': {
            content: 'Line 1\nLine 2\nTarget line\nLine 4\nLine 5',
            createdAt: '',
            updatedAt: '',
          },
        },
      };
      instance = new MemoryToolInstance('test-project', fs);

      const result = await instance.execute({
        command: 'str_replace',
        path: '/memories/test.md',
        old_str: 'Target line',
        new_str: 'Replaced line',
      });

      expect(result.content).toContain('The memory file has been edited.');
      // Verify snippet has 6-char padded line numbers with tab separator
      expect(result.content).toMatch(/\s+1\tLine 1/);
      expect(result.content).toMatch(/\s+3\tReplaced line/);
      expect(result.isError).toBeFalsy();
    });

    it('returns error when old_str not found', async () => {
      const fs: MemoryFileSystem = {
        files: {
          'test.md': { content: 'Hello world', createdAt: '', updatedAt: '' },
        },
      };
      instance = new MemoryToolInstance('test-project', fs);

      const result = await instance.execute({
        command: 'str_replace',
        path: '/memories/test.md',
        old_str: 'nonexistent',
        new_str: 'replacement',
      });

      expect(result.content).toBe(
        'No replacement was performed, old_str `nonexistent` did not appear verbatim in /memories/test.md.'
      );
      expect(result.isError).toBe(true);
    });

    it('returns error when multiple occurrences found', async () => {
      const fs: MemoryFileSystem = {
        files: {
          'test.md': {
            content: 'foo bar foo',
            createdAt: '',
            updatedAt: '',
          },
        },
      };
      instance = new MemoryToolInstance('test-project', fs);

      const result = await instance.execute({
        command: 'str_replace',
        path: '/memories/test.md',
        old_str: 'foo',
        new_str: 'baz',
      });

      expect(result.content).toContain('No replacement was performed');
      expect(result.content).toContain('Multiple occurrences');
      expect(result.content).toContain('Please ensure it is unique');
      expect(result.isError).toBe(true);

      // Content should be unchanged
      const updatedFs = instance.getFileSystem();
      expect(updatedFs.files['test.md'].content).toBe('foo bar foo');
    });

    it('returns error for non-existent file', async () => {
      const result = await instance.execute({
        command: 'str_replace',
        path: '/memories/nonexistent.md',
        old_str: 'old',
        new_str: 'new',
      });

      expect(result.content).toBe(
        'Error: The path /memories/nonexistent.md does not exist. Please provide a valid path.'
      );
      expect(result.isError).toBe(true);
    });

    it('returns error for root path (directory)', async () => {
      const result = await instance.execute({
        command: 'str_replace',
        path: '/memories',
        old_str: 'old',
        new_str: 'new',
      });

      expect(result.content).toBe(
        'Error: The path /memories does not exist. Please provide a valid path.'
      );
      expect(result.isError).toBe(true);
    });
  });

  describe('insert command', () => {
    it('inserts text at beginning of file (line 0)', async () => {
      const fs: MemoryFileSystem = {
        files: {
          'test.md': {
            content: 'Line 1\nLine 2',
            createdAt: '',
            updatedAt: '',
          },
        },
      };
      instance = new MemoryToolInstance('test-project', fs);

      const result = await instance.execute({
        command: 'insert',
        path: '/memories/test.md',
        insert_line: 0,
        insert_text: 'New first line',
      });

      expect(result.content).toBe('The file /memories/test.md has been edited.');
      expect(result.isError).toBeFalsy();

      const updatedFs = instance.getFileSystem();
      expect(updatedFs.files['test.md'].content).toBe('New first line\nLine 1\nLine 2');
    });

    it('inserts text in middle of file', async () => {
      const fs: MemoryFileSystem = {
        files: {
          'test.md': {
            content: 'Line 1\nLine 2\nLine 3',
            createdAt: '',
            updatedAt: '',
          },
        },
      };
      instance = new MemoryToolInstance('test-project', fs);

      const result = await instance.execute({
        command: 'insert',
        path: '/memories/test.md',
        insert_line: 2,
        insert_text: 'Inserted line',
      });

      expect(result.isError).toBeFalsy();

      const updatedFs = instance.getFileSystem();
      expect(updatedFs.files['test.md'].content).toBe('Line 1\nLine 2\nInserted line\nLine 3');
    });

    it('inserts text at end of file', async () => {
      const fs: MemoryFileSystem = {
        files: {
          'test.md': {
            content: 'Line 1\nLine 2',
            createdAt: '',
            updatedAt: '',
          },
        },
      };
      instance = new MemoryToolInstance('test-project', fs);

      const result = await instance.execute({
        command: 'insert',
        path: '/memories/test.md',
        insert_line: 2,
        insert_text: 'Last line',
      });

      expect(result.isError).toBeFalsy();

      const updatedFs = instance.getFileSystem();
      expect(updatedFs.files['test.md'].content).toBe('Line 1\nLine 2\nLast line');
    });

    it('inserts multi-line text', async () => {
      const fs: MemoryFileSystem = {
        files: {
          'test.md': {
            content: 'Line 1\nLine 3',
            createdAt: '',
            updatedAt: '',
          },
        },
      };
      instance = new MemoryToolInstance('test-project', fs);

      const result = await instance.execute({
        command: 'insert',
        path: '/memories/test.md',
        insert_line: 1,
        insert_text: 'Line 2a\nLine 2b',
      });

      expect(result.isError).toBeFalsy();

      const updatedFs = instance.getFileSystem();
      expect(updatedFs.files['test.md'].content).toBe('Line 1\nLine 2a\nLine 2b\nLine 3');
    });

    it('returns error for invalid line number (negative)', async () => {
      const fs: MemoryFileSystem = {
        files: {
          'test.md': { content: 'content', createdAt: '', updatedAt: '' },
        },
      };
      instance = new MemoryToolInstance('test-project', fs);

      const result = await instance.execute({
        command: 'insert',
        path: '/memories/test.md',
        insert_line: -1,
        insert_text: 'text',
      });

      expect(result.content).toContain('Error: Invalid `insert_line` parameter: -1');
      expect(result.content).toContain('[0, 1]');
      expect(result.isError).toBe(true);
    });

    it('returns error for invalid line number (too large)', async () => {
      const fs: MemoryFileSystem = {
        files: {
          'test.md': { content: 'Line 1\nLine 2', createdAt: '', updatedAt: '' },
        },
      };
      instance = new MemoryToolInstance('test-project', fs);

      const result = await instance.execute({
        command: 'insert',
        path: '/memories/test.md',
        insert_line: 5,
        insert_text: 'text',
      });

      expect(result.content).toContain('Error: Invalid `insert_line` parameter: 5');
      expect(result.content).toContain('[0, 2]');
      expect(result.isError).toBe(true);
    });

    it('returns error for non-existent file', async () => {
      const result = await instance.execute({
        command: 'insert',
        path: '/memories/nonexistent.md',
        insert_line: 0,
        insert_text: 'text',
      });

      expect(result.content).toBe('Error: The path /memories/nonexistent.md does not exist');
      expect(result.isError).toBe(true);
    });

    it('returns error for root path (directory)', async () => {
      const result = await instance.execute({
        command: 'insert',
        path: '/memories',
        insert_line: 0,
        insert_text: 'text',
      });

      expect(result.content).toBe('Error: The path /memories does not exist');
      expect(result.isError).toBe(true);
    });
  });

  describe('delete command', () => {
    it('deletes existing file', async () => {
      const fs: MemoryFileSystem = {
        files: {
          'test.md': { content: 'content', createdAt: '', updatedAt: '' },
        },
      };
      instance = new MemoryToolInstance('test-project', fs);

      const result = await instance.execute({
        command: 'delete',
        path: '/memories/test.md',
      });

      expect(result.content).toBe('Successfully deleted /memories/test.md');
      expect(result.isError).toBeFalsy();

      const updatedFs = instance.getFileSystem();
      expect(updatedFs.files['test.md']).toBeUndefined();
    });

    it('returns error for non-existent file', async () => {
      const result = await instance.execute({
        command: 'delete',
        path: '/memories/nonexistent.md',
      });

      expect(result.content).toBe('Error: The path /memories/nonexistent.md does not exist');
      expect(result.isError).toBe(true);
    });

    it('returns error when deleting root directory', async () => {
      const result = await instance.execute({
        command: 'delete',
        path: '/memories',
      });

      expect(result.content).toBe('Error: The path /memories does not exist');
      expect(result.isError).toBe(true);
    });
  });

  describe('rename command', () => {
    it('renames file successfully', async () => {
      const fs: MemoryFileSystem = {
        files: {
          'old.md': { content: 'content', createdAt: '2024-01-01', updatedAt: '2024-01-01' },
        },
      };
      instance = new MemoryToolInstance('test-project', fs);

      const result = await instance.execute({
        command: 'rename',
        old_path: '/memories/old.md',
        new_path: '/memories/new.md',
      });

      expect(result.content).toBe('Successfully renamed /memories/old.md to /memories/new.md');
      expect(result.isError).toBeFalsy();

      const updatedFs = instance.getFileSystem();
      expect(updatedFs.files['old.md']).toBeUndefined();
      expect(updatedFs.files['new.md']).toBeDefined();
      expect(updatedFs.files['new.md'].content).toBe('content');
    });

    it('returns error when source does not exist', async () => {
      const result = await instance.execute({
        command: 'rename',
        old_path: '/memories/nonexistent.md',
        new_path: '/memories/new.md',
      });

      expect(result.content).toBe('Error: The path /memories/nonexistent.md does not exist');
      expect(result.isError).toBe(true);
    });

    it('returns error when destination already exists', async () => {
      const fs: MemoryFileSystem = {
        files: {
          'old.md': { content: 'old content', createdAt: '', updatedAt: '' },
          'new.md': { content: 'new content', createdAt: '', updatedAt: '' },
        },
      };
      instance = new MemoryToolInstance('test-project', fs);

      const result = await instance.execute({
        command: 'rename',
        old_path: '/memories/old.md',
        new_path: '/memories/new.md',
      });

      expect(result.content).toBe('Error: The destination /memories/new.md already exists');
      expect(result.isError).toBe(true);

      // Files should be unchanged
      const updatedFs = instance.getFileSystem();
      expect(updatedFs.files['old.md'].content).toBe('old content');
      expect(updatedFs.files['new.md'].content).toBe('new content');
    });

    it('returns error when source is root path', async () => {
      const result = await instance.execute({
        command: 'rename',
        old_path: '/memories',
        new_path: '/memories/new.md',
      });

      expect(result.content).toBe('Error: The path /memories does not exist');
      expect(result.isError).toBe(true);
    });

    it('returns error when destination is root path', async () => {
      const fs: MemoryFileSystem = {
        files: {
          'test.md': { content: 'content', createdAt: '', updatedAt: '' },
        },
      };
      instance = new MemoryToolInstance('test-project', fs);

      const result = await instance.execute({
        command: 'rename',
        old_path: '/memories/test.md',
        new_path: '/memories',
      });

      expect(result.content).toBe('Error: The destination /memories already exists');
      expect(result.isError).toBe(true);
    });
  });

  describe('unknown command', () => {
    it('returns error for unknown command', async () => {
      const result = await instance.execute({
        command: 'unknown' as 'view',
        path: '/memories',
      });

      expect(result.content).toContain('Unknown memory command');
      expect(result.isError).toBe(true);
    });
  });
});

describe('path normalization', () => {
  let instance: MemoryToolInstance;

  beforeEach(() => {
    const fs: MemoryFileSystem = {
      files: {
        'test.md': { content: 'test content', createdAt: '', updatedAt: '' },
      },
    };
    instance = new MemoryToolInstance('test-project', fs);
  });

  it('handles /memories/file.md', async () => {
    const result = await instance.execute({ command: 'view', path: '/memories/test.md' });
    expect(result.isError).toBeFalsy();
  });

  it('handles file.md (no prefix)', async () => {
    const result = await instance.execute({ command: 'view', path: 'test.md' });
    expect(result.isError).toBeFalsy();
  });

  it('handles /file.md (leading slash)', async () => {
    const result = await instance.execute({ command: 'view', path: '/test.md' });
    expect(result.isError).toBeFalsy();
  });

  it('handles paths with whitespace', async () => {
    const result = await instance.execute({ command: 'view', path: '  /memories/test.md  ' });
    expect(result.isError).toBeFalsy();
  });
});

describe('disposeMemoryTool', () => {
  it('removes instance from cache', () => {
    // Just verify it doesn't throw
    disposeMemoryTool('nonexistent-project');
  });
});
