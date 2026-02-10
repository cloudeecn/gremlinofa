import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { memoryTool } from '../memoryTool';
import * as vfs from '../../vfs/vfsService';
import { VfsError } from '../../vfs/vfsService';
import type { ToolContext, ToolOptions, ToolResult, BooleanToolOption } from '../../../types';

// Mock vfsService
vi.mock('../../vfs/vfsService', async importOriginal => {
  const actual = await importOriginal<typeof import('../../vfs/vfsService')>();
  return {
    ...actual,
    exists: vi.fn(),
    readDir: vi.fn(),
    readFile: vi.fn(),
    createFile: vi.fn(),
    updateFile: vi.fn(),
    deleteFile: vi.fn(),
    rmdir: vi.fn(),
    mkdir: vi.fn(),
    rename: vi.fn(),
  };
});
describe('memoryTool', () => {
  const projectId = 'test-project';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('tool definition', () => {
    it('has correct name and displayName', () => {
      expect(memoryTool.name).toBe('memory');
      expect(memoryTool.displayName).toBe('Memory');
    });

    it('has optionDefinitions with useSystemPrompt', () => {
      expect(memoryTool.optionDefinitions).toBeDefined();
      expect(memoryTool.optionDefinitions?.length).toBe(1);
      const opt = memoryTool.optionDefinitions?.[0] as BooleanToolOption;
      expect(opt.id).toBe('useSystemPrompt');
      expect(opt.default).toBe(false);
    });

    it('getApiOverride returns native tool for Anthropic without useSystemPrompt', () => {
      const override = memoryTool.getApiOverride?.('anthropic', {});
      expect(override).toEqual({ type: 'memory_20250818', name: 'memory' });
    });

    it('getApiOverride returns undefined for Anthropic with useSystemPrompt', () => {
      const override = memoryTool.getApiOverride?.('anthropic', { useSystemPrompt: true });
      expect(override).toBeUndefined();
    });

    it('getApiOverride returns undefined for non-Anthropic APIs', () => {
      expect(memoryTool.getApiOverride?.('chatgpt', {})).toBeUndefined();
      expect(memoryTool.getApiOverride?.('responses_api', {})).toBeUndefined();
      expect(memoryTool.getApiOverride?.('webllm', {})).toBeUndefined();
    });
  });

  describe('view command', () => {
    it('returns empty directory listing with correct header', async () => {
      (vfs.exists as Mock).mockResolvedValue(false);

      const result = await executeMemory({ command: 'view', path: '/memories' });

      expect(result.content).toContain(
        "Here're the files and directories up to 2 levels deep in /memories, excluding hidden items and node_modules:"
      );
      expect(result.content).toContain('(empty)');
      expect(result.isError).toBeFalsy();
    });

    it('returns directory listing with files and sizes', async () => {
      (vfs.exists as Mock).mockResolvedValue(true);
      (vfs.readDir as Mock).mockResolvedValue([
        { name: 'notes.md', type: 'file', deleted: false, createdAt: 0, updatedAt: 0, size: 17 },
        { name: 'tasks.md', type: 'file', deleted: false, createdAt: 0, updatedAt: 0, size: 12 },
      ]);

      const result = await executeMemory({ command: 'view', path: '/memories' });

      expect(result.content).toContain('notes.md');
      expect(result.content).toContain('tasks.md');
      expect(result.content).toMatch(/\d+\t\/memories\/notes\.md/);
      expect(result.isError).toBeFalsy();
    });

    it('returns file content with line numbers', async () => {
      (vfs.readFile as Mock).mockResolvedValue('Line 1\nLine 2\nLine 3');

      const result = await executeMemory({ command: 'view', path: '/memories/test.md' });

      expect(result.content).toContain("Here's the content of /memories/test.md");
      expect(result.content).toContain('     1\tLine 1');
      expect(result.content).toContain('     2\tLine 2');
      expect(result.content).toContain('     3\tLine 3');
      expect(result.isError).toBeFalsy();
    });

    it('supports view_range parameter', async () => {
      (vfs.readFile as Mock).mockResolvedValue('Line 1\nLine 2\nLine 3\nLine 4\nLine 5');

      const result = await executeMemory({
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
      (vfs.readFile as Mock).mockRejectedValue(new VfsError('Path not found', 'PATH_NOT_FOUND'));

      const result = await executeMemory({ command: 'view', path: '/memories/nonexistent.md' });

      expect(result.content).toBe(
        'The path /memories/nonexistent.md does not exist. Please provide a valid path.'
      );
      expect(result.isError).toBe(true);
    });

    it('handles path without /memories prefix', async () => {
      (vfs.readFile as Mock).mockResolvedValue('content');

      const result = await executeMemory({ command: 'view', path: 'test.md' });

      expect(result.content).toContain("Here's the content of /memories/test.md");
      expect(result.isError).toBeFalsy();
      expect(vfs.readFile).toHaveBeenCalledWith(projectId, '/memories/test.md', undefined);
    });

    it('returns error when file exceeds 999,999 line limit', async () => {
      const lines = new Array(1000001).fill('line');
      (vfs.readFile as Mock).mockResolvedValue(lines.join('\n'));

      const result = await executeMemory({ command: 'view', path: '/memories/huge.txt' });

      expect(result.content).toBe(
        'File /memories/huge.txt exceeds maximum line limit of 999999 lines.'
      );
      expect(result.isError).toBe(true);
    });
  });

  describe('create command', () => {
    it('creates new file successfully', async () => {
      (vfs.exists as Mock).mockResolvedValue(true);
      (vfs.createFile as Mock).mockResolvedValue(undefined);

      const result = await executeMemory({
        command: 'create',
        path: '/memories/new.md',
        file_text: 'New content',
      });

      expect(result.content).toBe('File created successfully at: /memories/new.md');
      expect(result.isError).toBeFalsy();
      expect(vfs.createFile).toHaveBeenCalledWith(
        projectId,
        '/memories/new.md',
        'New content',
        undefined
      );
    });

    it('creates /memories directory if it does not exist', async () => {
      (vfs.exists as Mock).mockResolvedValue(false);
      (vfs.mkdir as Mock).mockResolvedValue(undefined);
      (vfs.createFile as Mock).mockResolvedValue(undefined);

      const result = await executeMemory({
        command: 'create',
        path: '/memories/new.md',
        file_text: 'New content',
      });

      expect(result.content).toBe('File created successfully at: /memories/new.md');
      expect(vfs.mkdir).toHaveBeenCalledWith(projectId, '/memories', undefined);
    });

    it('returns error when file exists', async () => {
      (vfs.exists as Mock).mockResolvedValue(true);
      (vfs.createFile as Mock).mockRejectedValue(new VfsError('File exists', 'FILE_EXISTS'));

      const result = await executeMemory({
        command: 'create',
        path: '/memories/existing.md',
        file_text: 'new content',
      });

      expect(result.content).toBe('Error: File /memories/existing.md already exists');
      expect(result.isError).toBe(true);
    });

    it('returns error when creating at root path', async () => {
      const result = await executeMemory({ command: 'create', path: '/memories', file_text: 'x' });

      expect(result.content).toContain('Cannot create a file at the root path');
      expect(result.isError).toBe(true);
    });
  });

  describe('str_replace command', () => {
    it('replaces string in file and returns snippet', async () => {
      (vfs.readFile as Mock).mockResolvedValue('Hello world');
      (vfs.updateFile as Mock).mockResolvedValue(undefined);

      const result = await executeMemory({
        command: 'str_replace',
        path: '/memories/test.md',
        old_str: 'world',
        new_str: 'universe',
      });

      expect(result.content).toContain('The memory file has been edited.');
      expect(result.content).toContain('Hello universe');
      expect(result.isError).toBeFalsy();
      expect(vfs.updateFile).toHaveBeenCalledWith(
        projectId,
        '/memories/test.md',
        'Hello universe',
        undefined
      );
    });

    it('returns error when old_str not found', async () => {
      (vfs.readFile as Mock).mockResolvedValue('Hello world');

      const result = await executeMemory({
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
      (vfs.readFile as Mock).mockResolvedValue('foo bar foo');

      const result = await executeMemory({
        command: 'str_replace',
        path: '/memories/test.md',
        old_str: 'foo',
        new_str: 'baz',
      });

      expect(result.content).toContain('No replacement was performed');
      expect(result.content).toContain('Multiple occurrences');
      expect(result.isError).toBe(true);
    });

    it('returns error for root path (directory)', async () => {
      const result = await executeMemory({
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
      (vfs.readFile as Mock).mockResolvedValue('Line 1\nLine 2');
      (vfs.updateFile as Mock).mockResolvedValue(undefined);

      const result = await executeMemory({
        command: 'insert',
        path: '/memories/test.md',
        insert_line: 0,
        insert_text: 'New first line',
      });

      expect(result.content).toBe('The file /memories/test.md has been edited.');
      expect(result.isError).toBeFalsy();
      expect(vfs.updateFile).toHaveBeenCalledWith(
        projectId,
        '/memories/test.md',
        'New first line\nLine 1\nLine 2',
        undefined
      );
    });

    it('inserts text in middle of file', async () => {
      (vfs.readFile as Mock).mockResolvedValue('Line 1\nLine 2\nLine 3');
      (vfs.updateFile as Mock).mockResolvedValue(undefined);

      const result = await executeMemory({
        command: 'insert',
        path: '/memories/test.md',
        insert_line: 2,
        insert_text: 'Inserted line',
      });

      expect(result.isError).toBeFalsy();
      expect(vfs.updateFile).toHaveBeenCalledWith(
        projectId,
        '/memories/test.md',
        'Line 1\nLine 2\nInserted line\nLine 3',
        undefined
      );
    });

    it('inserts text at end of file', async () => {
      (vfs.readFile as Mock).mockResolvedValue('Line 1\nLine 2');
      (vfs.updateFile as Mock).mockResolvedValue(undefined);

      const result = await executeMemory({
        command: 'insert',
        path: '/memories/test.md',
        insert_line: 2,
        insert_text: 'Last line',
      });

      expect(result.isError).toBeFalsy();
      expect(vfs.updateFile).toHaveBeenCalledWith(
        projectId,
        '/memories/test.md',
        'Line 1\nLine 2\nLast line',
        undefined
      );
    });

    it('inserts multi-line text', async () => {
      (vfs.readFile as Mock).mockResolvedValue('Line 1\nLine 3');
      (vfs.updateFile as Mock).mockResolvedValue(undefined);

      const result = await executeMemory({
        command: 'insert',
        path: '/memories/test.md',
        insert_line: 1,
        insert_text: 'Line 2a\nLine 2b',
      });

      expect(result.isError).toBeFalsy();
      expect(vfs.updateFile).toHaveBeenCalledWith(
        projectId,
        '/memories/test.md',
        'Line 1\nLine 2a\nLine 2b\nLine 3',
        undefined
      );
    });

    it('returns error for invalid line number (negative)', async () => {
      (vfs.readFile as Mock).mockResolvedValue('content');

      const result = await executeMemory({
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
      (vfs.readFile as Mock).mockResolvedValue('Line 1\nLine 2');

      const result = await executeMemory({
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
      (vfs.readFile as Mock).mockRejectedValue(new VfsError('Path not found', 'PATH_NOT_FOUND'));

      const result = await executeMemory({
        command: 'insert',
        path: '/memories/nonexistent.md',
        insert_line: 0,
        insert_text: 'text',
      });

      expect(result.content).toBe('Error: The path /memories/nonexistent.md does not exist');
      expect(result.isError).toBe(true);
    });

    it('returns error for root path (directory)', async () => {
      const result = await executeMemory({
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
      (vfs.deleteFile as Mock).mockResolvedValue(undefined);

      const result = await executeMemory({
        command: 'delete',
        path: '/memories/test.md',
      });

      expect(result.content).toBe('Successfully deleted /memories/test.md');
      expect(result.isError).toBeFalsy();
      expect(vfs.deleteFile).toHaveBeenCalledWith(projectId, '/memories/test.md', undefined);
    });

    it('returns error for non-existent file', async () => {
      (vfs.deleteFile as Mock).mockRejectedValue(new VfsError('Path not found', 'PATH_NOT_FOUND'));

      const result = await executeMemory({
        command: 'delete',
        path: '/memories/nonexistent.md',
      });

      expect(result.content).toBe('Error: The path /memories/nonexistent.md does not exist');
      expect(result.isError).toBe(true);
    });

    it('returns error when deleting root directory', async () => {
      const result = await executeMemory({
        command: 'delete',
        path: '/memories',
      });

      expect(result.content).toBe('Error: The path /memories does not exist');
      expect(result.isError).toBe(true);
    });

    it('deletes directory when target is not a file', async () => {
      (vfs.deleteFile as Mock).mockRejectedValue(new VfsError('Not a file', 'NOT_A_FILE'));
      (vfs.rmdir as Mock).mockResolvedValue(undefined);

      const result = await executeMemory({
        command: 'delete',
        path: '/memories/subdir',
      });

      expect(result.content).toBe('Successfully deleted /memories/subdir');
      expect(result.isError).toBeFalsy();
      expect(vfs.rmdir).toHaveBeenCalledWith(projectId, '/memories/subdir', true, undefined);
    });
  });

  describe('rename command', () => {
    it('renames file successfully', async () => {
      (vfs.rename as Mock).mockResolvedValue(undefined);

      const result = await executeMemory({
        command: 'rename',
        old_path: '/memories/old.md',
        new_path: '/memories/new.md',
      });

      expect(result.content).toBe('Successfully renamed /memories/old.md to /memories/new.md');
      expect(result.isError).toBeFalsy();
      expect(vfs.rename).toHaveBeenCalledWith(
        projectId,
        '/memories/old.md',
        '/memories/new.md',
        undefined
      );
    });

    it('returns error when source does not exist', async () => {
      (vfs.rename as Mock).mockRejectedValue(new VfsError('Path not found', 'PATH_NOT_FOUND'));

      const result = await executeMemory({
        command: 'rename',
        old_path: '/memories/nonexistent.md',
        new_path: '/memories/new.md',
      });

      expect(result.content).toBe('Error: The path /memories/nonexistent.md does not exist');
      expect(result.isError).toBe(true);
    });

    it('returns error when destination already exists', async () => {
      (vfs.rename as Mock).mockRejectedValue(
        new VfsError('Destination exists', 'DESTINATION_EXISTS')
      );

      const result = await executeMemory({
        command: 'rename',
        old_path: '/memories/old.md',
        new_path: '/memories/new.md',
      });

      expect(result.content).toBe('Error: The destination /memories/new.md already exists');
      expect(result.isError).toBe(true);
    });

    it('returns error when source is root path', async () => {
      const result = await executeMemory({
        command: 'rename',
        old_path: '/memories',
        new_path: '/memories/new.md',
      });

      expect(result.content).toBe('Error: The path /memories does not exist');
      expect(result.isError).toBe(true);
    });

    it('returns error when destination is root path', async () => {
      const result = await executeMemory({
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
      const result = await executeMemory({
        command: 'unknown' as 'view',
        path: '/memories',
      });

      expect(result.content).toContain('Unknown memory command');
      expect(result.isError).toBe(true);
    });
  });

  describe('context validation', () => {
    it('returns error when projectId is missing', async () => {
      const result = await collectToolResult(
        memoryTool.execute({ command: 'view', path: '/memories' }, {}, { projectId: '' })
      );

      expect(result.content).toBe('Error: projectId is required in context');
      expect(result.isError).toBe(true);
    });

    it('returns error when context is undefined', async () => {
      const result = await collectToolResult(
        memoryTool.execute({ command: 'view', path: '/memories' }, {})
      );

      expect(result.content).toBe('Error: projectId is required in context');
      expect(result.isError).toBe(true);
    });
  });
});

describe('path normalization', () => {
  const projectId = 'test-project';

  beforeEach(() => {
    vi.clearAllMocks();
    (vfs.readFile as Mock).mockResolvedValue('test content');
  });

  it('handles /memories/file.md', async () => {
    const result = await executeMemory({ command: 'view', path: '/memories/test.md' });
    expect(result.isError).toBeFalsy();
    expect(vfs.readFile).toHaveBeenCalledWith(projectId, '/memories/test.md', undefined);
  });

  it('handles file.md (no prefix)', async () => {
    const result = await executeMemory({ command: 'view', path: 'test.md' });
    expect(result.isError).toBeFalsy();
    expect(vfs.readFile).toHaveBeenCalledWith(projectId, '/memories/test.md', undefined);
  });

  it('handles /file.md (leading slash)', async () => {
    const result = await executeMemory({ command: 'view', path: '/test.md' });
    expect(result.isError).toBeFalsy();
    expect(vfs.readFile).toHaveBeenCalledWith(projectId, '/memories/test.md', undefined);
  });

  it('handles paths with whitespace', async () => {
    const result = await executeMemory({ command: 'view', path: '  /memories/test.md  ' });
    expect(result.isError).toBeFalsy();
    expect(vfs.readFile).toHaveBeenCalledWith(projectId, '/memories/test.md', undefined);
  });
});

/** Consume an async generator to get the final ToolResult */
async function collectToolResult(gen: ReturnType<typeof memoryTool.execute>): Promise<ToolResult> {
  if (gen instanceof Promise) return gen;
  let result = await gen.next();
  while (!result.done) result = await gen.next();
  return result.value;
}

/** Helper to execute memory tool with context */
async function executeMemory(
  input: Record<string, unknown>,
  projectId = 'test-project',
  toolOptions: ToolOptions = {}
) {
  const context: ToolContext = { projectId };
  return collectToolResult(memoryTool.execute(input, toolOptions, context));
}
