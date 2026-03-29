import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { memoryTool } from '../memoryTool';
import * as vfs from '../../vfs';
import { VfsError } from '../../vfs';
import type {
  ToolContext,
  ToolOptions,
  ToolResult,
  BooleanToolOption,
  SystemPromptContext,
} from '../../../types';

// Mock vfs facade
vi.mock('../../vfs', async importOriginal => {
  const actual = await importOriginal<typeof import('../../vfs')>();
  return {
    ...actual,
    exists: vi.fn(),
    readDir: vi.fn(),
    readFile: vi.fn(),
    isDirectory: vi.fn(),
    createFile: vi.fn(),
    updateFile: vi.fn(),
    writeFile: vi.fn(),
    deleteFile: vi.fn(),
    rmdir: vi.fn(),
    mkdir: vi.fn(),
    rename: vi.fn(),
    strReplace: vi.fn(),
    insert: vi.fn(),
    deletePath: vi.fn(),
    copyFile: vi.fn(),
    appendFile: vi.fn(),
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

    it('has optionDefinitions with useSystemPrompt and noHandHolding', () => {
      expect(memoryTool.optionDefinitions).toBeDefined();
      expect(memoryTool.optionDefinitions?.length).toBe(2);
      const syspromptOpt = memoryTool.optionDefinitions?.[0] as BooleanToolOption;
      expect(syspromptOpt.id).toBe('useSystemPrompt');
      expect(syspromptOpt.default).toBe(false);
      const noHandHoldingOpt = memoryTool.optionDefinitions?.[1] as BooleanToolOption;
      expect(noHandHoldingOpt.id).toBe('noHandHolding');
      expect(noHandHoldingOpt.default).toBe(false);
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

  describe('systemPrompt (getMemorySystemPrompt)', () => {
    const sysCtx: SystemPromptContext = {
      projectId: 'test-project',
      apiDefinitionId: 'test-api',
      modelId: 'test-model',
      apiType: 'chatgpt',
    };

    it('includes usage manual by default', async () => {
      (vfs.exists as Mock).mockResolvedValue(false);
      const systemPrompt = memoryTool.systemPrompt as (
        ctx: SystemPromptContext,
        opts: ToolOptions
      ) => Promise<string>;

      const result = await systemPrompt(sysCtx, {});

      expect(result).toContain('## Memory');
      expect(result).toContain('persistent memory system');
      expect(result).toContain('The /memories directory is empty.');
    });

    it('includes usage manual when noHandHolding is false', async () => {
      (vfs.exists as Mock).mockResolvedValue(true);
      (vfs.readDir as Mock).mockResolvedValue([
        { name: 'notes.md', type: 'file', deleted: false, createdAt: 0, updatedAt: 0, size: 10 },
      ]);

      const systemPrompt = memoryTool.systemPrompt as (
        ctx: SystemPromptContext,
        opts: ToolOptions
      ) => Promise<string>;

      const result = await systemPrompt(sysCtx, { noHandHolding: false });

      expect(result).toContain('persistent memory system');
      expect(result).toContain('notes.md');
    });

    it('omits usage manual when noHandHolding is true', async () => {
      (vfs.exists as Mock).mockResolvedValue(true);
      (vfs.readDir as Mock).mockResolvedValue([
        { name: 'notes.md', type: 'file', deleted: false, createdAt: 0, updatedAt: 0, size: 10 },
      ]);

      const systemPrompt = memoryTool.systemPrompt as (
        ctx: SystemPromptContext,
        opts: ToolOptions
      ) => Promise<string>;

      const result = await systemPrompt(sysCtx, { noHandHolding: true });

      expect(result).toContain('## Memory');
      expect(result).toContain('notes.md');
      expect(result).not.toContain('persistent memory system');
      expect(result).not.toContain('record your progress');
    });

    it('omits usage manual for empty directory when noHandHolding is true', async () => {
      (vfs.exists as Mock).mockResolvedValue(false);

      const systemPrompt = memoryTool.systemPrompt as (
        ctx: SystemPromptContext,
        opts: ToolOptions
      ) => Promise<string>;

      const result = await systemPrompt(sysCtx, { noHandHolding: true });

      expect(result).toContain('## Memory');
      expect(result).toContain('The /memories directory is empty.');
      expect(result).not.toContain('persistent memory system');
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

    it('returns error when file exists', async () => {
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

    it('overwrites existing file when overwrite is true', async () => {
      (vfs.writeFile as Mock).mockResolvedValue(undefined);

      const result = await executeMemory({
        command: 'create',
        path: '/memories/existing.md',
        file_text: 'overwritten content',
        overwrite: true,
      });

      expect(result.content).toBe('File created successfully at: /memories/existing.md');
      expect(result.isError).toBeFalsy();
      expect(vfs.writeFile).toHaveBeenCalledWith(
        projectId,
        '/memories/existing.md',
        'overwritten content',
        undefined
      );
      expect(vfs.createFile).not.toHaveBeenCalled();
    });
  });

  describe('str_replace command', () => {
    it('replaces string in file and returns snippet', async () => {
      (vfs.strReplace as Mock).mockResolvedValue({
        editLine: 1,
        snippet: '     1\tHello universe',
      });

      const result = await executeMemory({
        command: 'str_replace',
        path: '/memories/test.md',
        old_str: 'world',
        new_str: 'universe',
      });

      expect(result.content).toContain('The memory file has been edited.');
      expect(result.content).toContain('Hello universe');
      expect(result.isError).toBeFalsy();
      expect(vfs.strReplace).toHaveBeenCalledWith(
        projectId,
        '/memories/test.md',
        'world',
        'universe',
        undefined
      );
    });

    it('returns error when old_str not found', async () => {
      (vfs.strReplace as Mock).mockRejectedValue(
        new VfsError('String not found', 'STRING_NOT_FOUND')
      );

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
      (vfs.strReplace as Mock).mockRejectedValue(
        new VfsError('String not unique', 'STRING_NOT_UNIQUE')
      );

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
      (vfs.insert as Mock).mockResolvedValue({ editLine: 0 });

      const result = await executeMemory({
        command: 'insert',
        path: '/memories/test.md',
        insert_line: 0,
        insert_text: 'New first line',
      });

      expect(result.content).toBe('The file /memories/test.md has been edited.');
      expect(result.isError).toBeFalsy();
      expect(vfs.insert).toHaveBeenCalledWith(
        projectId,
        '/memories/test.md',
        0,
        'New first line',
        undefined
      );
    });

    it('inserts text in middle of file', async () => {
      (vfs.insert as Mock).mockResolvedValue({ editLine: 2 });

      const result = await executeMemory({
        command: 'insert',
        path: '/memories/test.md',
        insert_line: 2,
        insert_text: 'Inserted line',
      });

      expect(result.isError).toBeFalsy();
      expect(vfs.insert).toHaveBeenCalledWith(
        projectId,
        '/memories/test.md',
        2,
        'Inserted line',
        undefined
      );
    });

    it('inserts text at end of file', async () => {
      (vfs.insert as Mock).mockResolvedValue({ editLine: 2 });

      const result = await executeMemory({
        command: 'insert',
        path: '/memories/test.md',
        insert_line: 2,
        insert_text: 'Last line',
      });

      expect(result.isError).toBeFalsy();
      expect(vfs.insert).toHaveBeenCalledWith(
        projectId,
        '/memories/test.md',
        2,
        'Last line',
        undefined
      );
    });

    it('inserts multi-line text', async () => {
      (vfs.insert as Mock).mockResolvedValue({ editLine: 1 });

      const result = await executeMemory({
        command: 'insert',
        path: '/memories/test.md',
        insert_line: 1,
        insert_text: 'Line 2a\nLine 2b',
      });

      expect(result.isError).toBeFalsy();
      expect(vfs.insert).toHaveBeenCalledWith(
        projectId,
        '/memories/test.md',
        1,
        'Line 2a\nLine 2b',
        undefined
      );
    });

    it('returns error for invalid line number (negative)', async () => {
      (vfs.insert as Mock).mockRejectedValue(new VfsError('Invalid line', 'INVALID_LINE'));

      const result = await executeMemory({
        command: 'insert',
        path: '/memories/test.md',
        insert_line: -1,
        insert_text: 'text',
      });

      expect(result.content).toContain('Error: Invalid `insert_line` parameter: -1');
      expect(result.isError).toBe(true);
    });

    it('returns error for invalid line number (too large)', async () => {
      (vfs.insert as Mock).mockRejectedValue(new VfsError('Invalid line', 'INVALID_LINE'));

      const result = await executeMemory({
        command: 'insert',
        path: '/memories/test.md',
        insert_line: 5,
        insert_text: 'text',
      });

      expect(result.content).toContain('Error: Invalid `insert_line` parameter: 5');
      expect(result.isError).toBe(true);
    });

    it('returns error for non-existent file', async () => {
      (vfs.insert as Mock).mockRejectedValue(new VfsError('Path not found', 'PATH_NOT_FOUND'));

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
      (vfs.deletePath as Mock).mockResolvedValue(undefined);

      const result = await executeMemory({
        command: 'delete',
        path: '/memories/test.md',
      });

      expect(result.content).toBe('Successfully deleted /memories/test.md');
      expect(result.isError).toBeFalsy();
      expect(vfs.deletePath).toHaveBeenCalledWith(projectId, '/memories/test.md', undefined);
    });

    it('returns error for non-existent file', async () => {
      (vfs.deletePath as Mock).mockRejectedValue(new VfsError('Path not found', 'PATH_NOT_FOUND'));

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

    it('deletes directory via deletePath', async () => {
      (vfs.deletePath as Mock).mockResolvedValue(undefined);

      const result = await executeMemory({
        command: 'delete',
        path: '/memories/subdir',
      });

      expect(result.content).toBe('Successfully deleted /memories/subdir');
      expect(result.isError).toBeFalsy();
      expect(vfs.deletePath).toHaveBeenCalledWith(projectId, '/memories/subdir', undefined);
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
        undefined,
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

      expect(result.content).toBe(
        'Error: The destination /memories/new.md already exists. Set overwrite to true to replace.'
      );
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

  describe('mkdir command', () => {
    it('creates directory successfully', async () => {
      (vfs.mkdir as Mock).mockResolvedValue(undefined);

      const result = await executeMemory({ command: 'mkdir', path: '/memories/subdir' });

      expect(result.content).toBe('Directory created successfully at: /memories/subdir');
      expect(result.isError).toBeFalsy();
      expect(vfs.mkdir).toHaveBeenCalledWith(projectId, '/memories/subdir', undefined);
    });

    it('returns error when directory already exists', async () => {
      (vfs.mkdir as Mock).mockRejectedValue(new VfsError('Dir exists', 'DIR_EXISTS'));

      const result = await executeMemory({ command: 'mkdir', path: '/memories/subdir' });

      expect(result.content).toBe('Error: Directory /memories/subdir already exists');
      expect(result.isError).toBe(true);
    });

    it('returns error when file exists at path', async () => {
      (vfs.mkdir as Mock).mockRejectedValue(new VfsError('File exists', 'FILE_EXISTS'));

      const result = await executeMemory({ command: 'mkdir', path: '/memories/subdir' });

      expect(result.content).toBe('Error: A file already exists at /memories/subdir');
      expect(result.isError).toBe(true);
    });

    it('returns error when creating at root path', async () => {
      const result = await executeMemory({ command: 'mkdir', path: '/memories' });

      expect(result.content).toContain('Cannot create directory at the root path');
      expect(result.isError).toBe(true);
    });
  });

  describe('append command', () => {
    it('appends to existing file', async () => {
      (vfs.appendFile as Mock).mockResolvedValue({ created: false });

      const result = await executeMemory({
        command: 'append',
        path: '/memories/log.md',
        file_text: '\nnew line',
      });

      expect(result.content).toBe('Content appended to /memories/log.md');
      expect(result.isError).toBeFalsy();
      expect(vfs.appendFile).toHaveBeenCalledWith(
        projectId,
        '/memories/log.md',
        '\nnew line',
        undefined
      );
    });

    it('creates file when it does not exist', async () => {
      (vfs.appendFile as Mock).mockResolvedValue({ created: true });

      const result = await executeMemory({
        command: 'append',
        path: '/memories/new.md',
        file_text: 'initial content',
      });

      expect(result.content).toBe('File created successfully at: /memories/new.md');
      expect(result.isError).toBeFalsy();
      expect(vfs.appendFile).toHaveBeenCalledWith(
        projectId,
        '/memories/new.md',
        'initial content',
        undefined
      );
    });

    it('returns error when path is a directory', async () => {
      (vfs.appendFile as Mock).mockRejectedValue(new VfsError('Not a file', 'NOT_A_FILE'));

      const result = await executeMemory({
        command: 'append',
        path: '/memories/subdir',
        file_text: 'content',
      });

      expect(result.content).toBe('Error: /memories/subdir is a directory, not a file.');
      expect(result.isError).toBe(true);
    });

    it('returns error when appending at root path', async () => {
      const result = await executeMemory({
        command: 'append',
        path: '/memories',
        file_text: 'content',
      });

      expect(result.content).toContain('Cannot append to the root path');
      expect(result.isError).toBe(true);
    });
  });

  describe('view-all command', () => {
    it('returns concatenated content for multiple valid files', async () => {
      (vfs.readFile as Mock)
        .mockResolvedValueOnce('File one content')
        .mockResolvedValueOnce('File two content');

      const result = await executeMemory({
        command: 'view-all',
        paths: ['/memories/a.md', '/memories/b.md'],
      });

      expect(result.content).toContain('=== /memories/a.md ===');
      expect(result.content).toContain('=== /memories/b.md ===');
      expect(result.content).toContain('File one content');
      expect(result.content).toContain('File two content');
      expect(result.isError).toBe(false);
    });

    it('returns partial success when some paths fail', async () => {
      (vfs.readFile as Mock)
        .mockResolvedValueOnce('Good content')
        .mockRejectedValueOnce(new VfsError('Path not found', 'PATH_NOT_FOUND'));

      const result = await executeMemory({
        command: 'view-all',
        paths: ['/memories/good.md', '/memories/missing.md'],
      });

      expect(result.content).toContain('=== /memories/good.md ===');
      expect(result.content).toContain('=== /memories/missing.md [ERROR] ===');
      expect(result.isError).toBe(false);
    });

    it('returns isError true when all paths fail', async () => {
      (vfs.readFile as Mock)
        .mockRejectedValueOnce(new VfsError('Path not found', 'PATH_NOT_FOUND'))
        .mockRejectedValueOnce(new VfsError('Path not found', 'PATH_NOT_FOUND'));

      const result = await executeMemory({
        command: 'view-all',
        paths: ['/memories/missing1.md', '/memories/missing2.md'],
      });

      expect(result.content).toContain('[ERROR]');
      expect(result.isError).toBe(true);
    });

    it('returns error for empty paths array', async () => {
      const result = await executeMemory({
        command: 'view-all',
        paths: [],
      });

      expect(result.content).toContain('paths array is required and must not be empty');
      expect(result.isError).toBe(true);
    });
  });

  describe('copy command', () => {
    it('copies a file to a new path', async () => {
      (vfs.copyFile as Mock).mockResolvedValue(undefined);

      const result = await executeMemory({
        command: 'copy',
        old_path: '/memories/src.md',
        new_path: '/memories/dst.md',
      });

      expect(result.isError).toBeFalsy();
      expect(result.content).toContain('Successfully copied /memories/src.md to /memories/dst.md');
      expect(vfs.copyFile).toHaveBeenCalledWith(
        'test-project',
        '/memories/src.md',
        '/memories/dst.md',
        undefined,
        undefined
      );
    });

    it('returns error when destination is a directory', async () => {
      (vfs.copyFile as Mock).mockRejectedValue(new VfsError('Not a file', 'NOT_A_FILE'));

      const result = await executeMemory({
        command: 'copy',
        old_path: '/memories/src.md',
        new_path: '/memories/subdir',
      });

      expect(result.isError).toBe(true);
      expect(result.content).toContain('is a directory');
    });

    it('returns error when source does not exist', async () => {
      (vfs.copyFile as Mock).mockRejectedValue(new VfsError('Path not found', 'PATH_NOT_FOUND'));

      const result = await executeMemory({
        command: 'copy',
        old_path: '/memories/missing.md',
        new_path: '/memories/dst.md',
      });

      expect(result.isError).toBe(true);
      expect(result.content).toContain('does not exist');
    });

    it('normalizes source path outside /memories into /memories', async () => {
      (vfs.copyFile as Mock).mockResolvedValue(undefined);

      const result = await executeMemory({
        command: 'copy',
        old_path: '/outside/src.md',
        new_path: '/memories/dst.md',
      });

      expect(result.isError).toBeFalsy();
      // normalizeToVfsPath strips leading / and prepends /memories
      expect(vfs.copyFile).toHaveBeenCalledWith(
        'test-project',
        '/memories/outside/src.md',
        '/memories/dst.md',
        undefined,
        undefined
      );
    });

    it('normalizes dest path outside /memories into /memories', async () => {
      (vfs.copyFile as Mock).mockResolvedValue(undefined);

      const result = await executeMemory({
        command: 'copy',
        old_path: '/memories/src.md',
        new_path: '/outside/dst.md',
      });

      expect(result.isError).toBeFalsy();
      expect(vfs.copyFile).toHaveBeenCalledWith(
        'test-project',
        '/memories/src.md',
        '/memories/outside/dst.md',
        undefined,
        undefined
      );
    });

    it('returns error when source is root path', async () => {
      const result = await executeMemory({
        command: 'copy',
        old_path: '/memories',
        new_path: '/memories/dst.md',
      });

      expect(result.isError).toBe(true);
      expect(result.content).toContain('is a directory');
    });

    it('returns error when destination is root path', async () => {
      const result = await executeMemory({
        command: 'copy',
        old_path: '/memories/src.md',
        new_path: '/memories',
      });

      expect(result.isError).toBe(true);
      expect(result.content).toContain('Cannot copy to the root path');
    });
  });

  describe('str_replace undefined fix', () => {
    it('omitting new_str passes empty string to strReplace instead of "undefined"', async () => {
      (vfs.strReplace as Mock).mockResolvedValue({
        editLine: 1,
        snippet: '     1\tHello',
      });

      const result = await executeMemory({
        command: 'str_replace',
        path: '/memories/test.md',
        old_str: ' world',
        // new_str intentionally omitted
      });

      expect(result.isError).toBeFalsy();
      expect(vfs.strReplace).toHaveBeenCalledWith(
        'test-project',
        '/memories/test.md',
        ' world',
        '',
        undefined
      );
    });
  });

  describe('copy overwrite behavior', () => {
    it('errors when destination exists without overwrite', async () => {
      (vfs.copyFile as Mock).mockRejectedValue(
        new VfsError('Destination exists', 'DESTINATION_EXISTS')
      );

      const result = await executeMemory({
        command: 'copy',
        old_path: '/memories/src.md',
        new_path: '/memories/dst.md',
      });

      expect(result.isError).toBe(true);
      expect(result.content).toContain('already exists');
    });

    it('succeeds with overwrite: true when destination exists', async () => {
      (vfs.copyFile as Mock).mockResolvedValue(undefined);

      const result = await executeMemory({
        command: 'copy',
        old_path: '/memories/src.md',
        new_path: '/memories/dst.md',
        overwrite: true,
      });

      expect(result.isError).toBeFalsy();
      expect(result.content).toContain('Successfully copied');
      expect(vfs.copyFile).toHaveBeenCalledWith(
        'test-project',
        '/memories/src.md',
        '/memories/dst.md',
        true,
        undefined
      );
    });
  });

  describe('rename overwrite behavior', () => {
    it('passes overwrite to vfs.rename', async () => {
      (vfs.rename as Mock).mockResolvedValue(undefined);

      const result = await executeMemory({
        command: 'rename',
        old_path: '/memories/old.md',
        new_path: '/memories/new.md',
        overwrite: true,
      });

      expect(result.isError).toBeFalsy();
      expect(vfs.rename).toHaveBeenCalledWith(
        'test-project',
        '/memories/old.md',
        '/memories/new.md',
        undefined,
        true
      );
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

  describe('input validation', () => {
    it('returns error when command is missing', async () => {
      const result = await executeMemory({});
      expect(result.content).toBe('Error: command is required');
      expect(result.isError).toBe(true);
    });

    it('returns error when path is missing for create', async () => {
      const result = await executeMemory({ command: 'create', file_text: 'hello' });
      expect(result.content).toBe('Error: path is required for create command');
      expect(result.isError).toBe(true);
    });

    it('returns error when path is null for create', async () => {
      const result = await executeMemory({ command: 'create', path: null, file_text: 'hello' });
      expect(result.content).toBe('Error: path is required for create command');
      expect(result.isError).toBe(true);
    });

    it('returns error when path is missing for view', async () => {
      const result = await executeMemory({ command: 'view' });
      expect(result.content).toBe('Error: path is required for view command');
      expect(result.isError).toBe(true);
    });

    it('returns error when old_path is missing for rename', async () => {
      const result = await executeMemory({ command: 'rename', new_path: '/memories/b.md' });
      expect(result.content).toBe('Error: old_path and new_path are required for rename command');
      expect(result.isError).toBe(true);
    });

    it('returns error when new_path is missing for copy', async () => {
      const result = await executeMemory({ command: 'copy', old_path: '/memories/a.md' });
      expect(result.content).toBe('Error: old_path and new_path are required for copy command');
      expect(result.isError).toBe(true);
    });

    it('returns error when old_str is missing for str_replace', async () => {
      const result = await executeMemory({
        command: 'str_replace',
        path: '/memories/test.md',
      });
      expect(result.content).toBe('Error: old_str is required for str_replace command');
      expect(result.isError).toBe(true);
    });

    it('returns error when insert_line is missing for insert', async () => {
      const result = await executeMemory({
        command: 'insert',
        path: '/memories/test.md',
      });
      expect(result.content).toBe('Error: insert_line (number) is required for insert command');
      expect(result.isError).toBe(true);
    });

    it('returns error when insert_line is a string for insert', async () => {
      const result = await executeMemory({
        command: 'insert',
        path: '/memories/test.md',
        insert_line: '5',
      });
      expect(result.content).toBe('Error: insert_line (number) is required for insert command');
      expect(result.isError).toBe(true);
    });

    it('returns error when paths is missing for view-all', async () => {
      const result = await executeMemory({ command: 'view-all' });
      expect(result.content).toBe('Error: paths (array) is required for view-all command');
      expect(result.isError).toBe(true);
    });

    it('returns error when paths is a string for view-all', async () => {
      const result = await executeMemory({ command: 'view-all', paths: '/memories/a.md' });
      expect(result.content).toBe('Error: paths (array) is required for view-all command');
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
