import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { fsTool } from '../fsTool';
import * as vfs from '../../vfs';
import { VfsError } from '../../vfs';
import type { ToolContext, ToolOptions, ToolResult } from '../../../types';

// Mock the vfs barrel
vi.mock('../../vfs', async importOriginal => {
  const actual = await importOriginal<typeof import('../../vfs')>();
  return {
    ...actual,
    exists: vi.fn(),
    readDir: vi.fn(),
    readFile: vi.fn(),
    readFileWithMeta: vi.fn(),
    isDirectory: vi.fn(),
    stat: vi.fn(),
    writeFile: vi.fn(),
    createFile: vi.fn(),
    createFileGuarded: vi.fn(),
    updateFile: vi.fn(),
    deleteFile: vi.fn(),
    deletePath: vi.fn(),
    rmdir: vi.fn(),
    mkdir: vi.fn(),
    rename: vi.fn(),
    strReplace: vi.fn(),
    insert: vi.fn(),
    appendFile: vi.fn(),
    copyFile: vi.fn(),
  };
});

/** Consume an async generator to get the final ToolResult */
async function collectToolResult(gen: ReturnType<typeof fsTool.execute>): Promise<ToolResult> {
  if (gen instanceof Promise) return gen;
  let result = await gen.next();
  while (!result.done) result = await gen.next();
  return result.value;
}

/** Helper to execute fs tool with context */
async function executeFs(
  input: Record<string, unknown>,
  projectId = 'test-project',
  toolOptions: ToolOptions = {}
) {
  const context: ToolContext = { projectId };
  return collectToolResult(fsTool.execute(input, toolOptions, context));
}

describe('fsTool view-all command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns concatenated content for multiple valid files', async () => {
    (vfs.isDirectory as Mock).mockResolvedValue(false);
    (vfs.readFileWithMeta as Mock)
      .mockResolvedValueOnce({ content: 'File one content', isBinary: false })
      .mockResolvedValueOnce({ content: 'File two content', isBinary: false });

    const result = await executeFs({
      command: 'view-all',
      paths: ['/data/a.md', '/data/b.md'],
    });

    expect(result.content).toContain('=== /data/a.md ===');
    expect(result.content).toContain('=== /data/b.md ===');
    expect(result.content).toContain('File one content');
    expect(result.content).toContain('File two content');
    expect(result.isError).toBe(false);
  });

  it('returns partial success when some paths fail', async () => {
    (vfs.isDirectory as Mock)
      .mockResolvedValueOnce(false)
      .mockRejectedValueOnce(new VfsError('Path not found', 'PATH_NOT_FOUND'));
    (vfs.readFileWithMeta as Mock).mockResolvedValueOnce({
      content: 'Good content',
      isBinary: false,
    });

    const result = await executeFs({
      command: 'view-all',
      paths: ['/data/good.md', '/data/missing.md'],
    });

    expect(result.content).toContain('=== /data/good.md ===');
    expect(result.content).toContain('=== /data/missing.md [ERROR] ===');
    expect(result.isError).toBe(false);
  });

  it('returns isError true when all paths fail', async () => {
    (vfs.isDirectory as Mock)
      .mockRejectedValueOnce(new VfsError('Path not found', 'PATH_NOT_FOUND'))
      .mockRejectedValueOnce(new VfsError('Path not found', 'PATH_NOT_FOUND'));

    const result = await executeFs({
      command: 'view-all',
      paths: ['/data/missing1.md', '/data/missing2.md'],
    });

    expect(result.content).toContain('[ERROR]');
    expect(result.isError).toBe(true);
  });

  it('returns error for empty paths array', async () => {
    const result = await executeFs({
      command: 'view-all',
      paths: [],
    });

    expect(result.content).toContain('paths array is required and must not be empty');
    expect(result.isError).toBe(true);
  });
});

describe('fsTool copy command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('copies a file via vfs.copyFile', async () => {
    (vfs.copyFile as Mock).mockResolvedValue(undefined);

    const result = await executeFs({
      command: 'copy',
      old_path: '/data/src.txt',
      new_path: '/data/dst.txt',
    });

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('Successfully copied /data/src.txt to /data/dst.txt');
    expect(vfs.copyFile).toHaveBeenCalledWith(
      'test-project',
      '/data/src.txt',
      '/data/dst.txt',
      undefined,
      undefined
    );
  });

  it('returns error when destination is a directory', async () => {
    (vfs.copyFile as Mock).mockRejectedValue(
      new VfsError('Destination is a directory: /data/somedir', 'NOT_A_FILE')
    );

    const result = await executeFs({
      command: 'copy',
      old_path: '/data/src.txt',
      new_path: '/data/somedir',
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain('is a directory');
  });

  it('returns error when source does not exist', async () => {
    (vfs.copyFile as Mock).mockRejectedValue(new VfsError('Path not found', 'PATH_NOT_FOUND'));

    const result = await executeFs({
      command: 'copy',
      old_path: '/data/missing.txt',
      new_path: '/data/dst.txt',
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain('does not exist');
  });

  it('returns error when destination is readonly', async () => {
    const result = await executeFs({
      command: 'copy',
      old_path: '/data/src.txt',
      new_path: '/memories/dst.txt',
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain('readonly');
  });
});

describe('fsTool create command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates a text file using createFileGuarded', async () => {
    (vfs.createFileGuarded as Mock).mockResolvedValue(undefined);

    const result = await executeFs({
      command: 'create',
      path: '/data/new.txt',
      file_text: 'hello',
    });

    expect(result.content).toBe('File created successfully at: /data/new.txt');
    expect(result.isError).toBeFalsy();
    expect(vfs.createFileGuarded).toHaveBeenCalledWith(
      'test-project',
      '/data/new.txt',
      'hello',
      undefined,
      undefined
    );
  });

  it('returns error when file already exists without overwrite', async () => {
    (vfs.createFileGuarded as Mock).mockRejectedValue(new VfsError('File exists', 'FILE_EXISTS'));

    const result = await executeFs({
      command: 'create',
      path: '/data/existing.txt',
      file_text: 'content',
    });

    expect(result.content).toBe('Error: File /data/existing.txt already exists');
    expect(result.isError).toBe(true);
  });

  it('overwrites existing text file when overwrite is true', async () => {
    (vfs.createFileGuarded as Mock).mockResolvedValue(undefined);

    const result = await executeFs({
      command: 'create',
      path: '/data/existing.txt',
      file_text: 'new content',
      overwrite: true,
    });

    expect(result.content).toBe('File created successfully at: /data/existing.txt');
    expect(result.isError).toBeFalsy();
    expect(vfs.createFileGuarded).toHaveBeenCalledWith(
      'test-project',
      '/data/existing.txt',
      'new content',
      true,
      undefined
    );
  });

  it('returns error for binary file when it exists without overwrite', async () => {
    (vfs.createFileGuarded as Mock).mockRejectedValue(
      new VfsError('File already exists: /data/img.png', 'FILE_EXISTS')
    );

    const result = await executeFs({
      command: 'create',
      path: '/data/img.png',
      file_text: 'data:image/png;base64,iVBORw0KGgo=',
    });

    expect(result.content).toBe('Error: File /data/img.png already exists');
    expect(result.isError).toBe(true);
  });

  it('creates binary file when it does not exist', async () => {
    (vfs.createFileGuarded as Mock).mockResolvedValue(undefined);

    const result = await executeFs({
      command: 'create',
      path: '/data/img.png',
      file_text: 'data:image/png;base64,iVBORw0KGgo=',
    });

    expect(result.content).toBe('Binary file created successfully at: /data/img.png');
    expect(result.isError).toBeFalsy();
    expect(vfs.createFileGuarded).toHaveBeenCalled();
  });

  it('overwrites existing binary file when overwrite is true', async () => {
    (vfs.createFileGuarded as Mock).mockResolvedValue(undefined);

    const result = await executeFs({
      command: 'create',
      path: '/data/img.png',
      file_text: 'data:image/png;base64,iVBORw0KGgo=',
      overwrite: true,
    });

    expect(result.content).toBe('Binary file created successfully at: /data/img.png');
    expect(result.isError).toBeFalsy();
    expect(vfs.createFileGuarded).toHaveBeenCalledWith(
      'test-project',
      '/data/img.png',
      expect.any(ArrayBuffer),
      true,
      undefined
    );
  });
});

describe('fsTool str_replace command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('omitting new_str deletes matched text instead of inserting "undefined"', async () => {
    (vfs.strReplace as Mock).mockResolvedValue({
      editLine: 1,
      snippet: '     1\tHello',
    });

    const result = await executeFs({
      command: 'str_replace',
      path: '/data/test.txt',
      old_str: ' world',
      // new_str intentionally omitted
    });

    expect(result.isError).toBeFalsy();
    expect(vfs.strReplace).toHaveBeenCalledWith(
      'test-project',
      '/data/test.txt',
      ' world',
      '',
      undefined
    );
  });

  it('returns snippet on successful replacement', async () => {
    (vfs.strReplace as Mock).mockResolvedValue({
      editLine: 2,
      snippet: '     1\tline one\n     2\tnew text\n     3\tline three',
    });

    const result = await executeFs({
      command: 'str_replace',
      path: '/data/test.txt',
      old_str: 'old text',
      new_str: 'new text',
    });

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('The file has been edited.');
    expect(result.content).toContain('new text');
  });

  it('returns error when string not found', async () => {
    (vfs.strReplace as Mock).mockRejectedValue(
      new VfsError('String not found', 'STRING_NOT_FOUND')
    );

    const result = await executeFs({
      command: 'str_replace',
      path: '/data/test.txt',
      old_str: 'nonexistent',
      new_str: 'replacement',
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain('did not appear verbatim');
  });

  it('returns error when string is not unique', async () => {
    (vfs.strReplace as Mock).mockRejectedValue(
      new VfsError('Multiple occurrences (2) found in lines: 3, 7', 'STRING_NOT_UNIQUE')
    );

    const result = await executeFs({
      command: 'str_replace',
      path: '/data/test.txt',
      old_str: 'duplicate',
      new_str: 'replacement',
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain('Multiple occurrences');
    expect(result.content).toContain('3, 7');
  });

  it('returns error for binary files', async () => {
    (vfs.strReplace as Mock).mockRejectedValue(new VfsError('Binary file', 'BINARY_FILE'));

    const result = await executeFs({
      command: 'str_replace',
      path: '/data/img.png',
      old_str: 'text',
      new_str: 'other',
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain('binary file');
  });
});

describe('fsTool insert command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('inserts text at a line via vfs.insert', async () => {
    (vfs.insert as Mock).mockResolvedValue({ insertedAt: 2 });

    const result = await executeFs({
      command: 'insert',
      path: '/data/test.txt',
      insert_line: 2,
      insert_text: 'new line',
    });

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('has been edited');
    expect(vfs.insert).toHaveBeenCalledWith(
      'test-project',
      '/data/test.txt',
      2,
      'new line',
      undefined
    );
  });

  it('returns error for invalid line number', async () => {
    (vfs.insert as Mock).mockRejectedValue(
      new VfsError('Invalid line 99 in /data/test.txt. Valid range: [0, 5]', 'INVALID_LINE')
    );

    const result = await executeFs({
      command: 'insert',
      path: '/data/test.txt',
      insert_line: 99,
      insert_text: 'text',
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain('Invalid');
    expect(result.content).toContain('insert_line');
  });

  it('returns error for binary files', async () => {
    (vfs.insert as Mock).mockRejectedValue(new VfsError('Binary file', 'BINARY_FILE'));

    const result = await executeFs({
      command: 'insert',
      path: '/data/img.png',
      insert_line: 0,
      insert_text: 'text',
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain('binary file');
  });
});

describe('fsTool append command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('appends to existing file', async () => {
    (vfs.appendFile as Mock).mockResolvedValue({ created: false });

    const result = await executeFs({
      command: 'append',
      path: '/data/test.txt',
      file_text: 'appended text',
    });

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('Content appended to');
    expect(vfs.appendFile).toHaveBeenCalledWith(
      'test-project',
      '/data/test.txt',
      'appended text',
      undefined
    );
  });

  it('creates file when it does not exist', async () => {
    (vfs.appendFile as Mock).mockResolvedValue({ created: true });

    const result = await executeFs({
      command: 'append',
      path: '/data/new.txt',
      file_text: 'initial text',
    });

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('File created successfully at');
  });

  it('omitting file_text appends nothing instead of "undefined"', async () => {
    (vfs.appendFile as Mock).mockResolvedValue({ created: false });

    const result = await executeFs({
      command: 'append',
      path: '/data/test.txt',
      // file_text intentionally omitted
    });

    expect(result.isError).toBeFalsy();
    expect(vfs.appendFile).toHaveBeenCalledWith('test-project', '/data/test.txt', '', undefined);
  });

  it('returns error for binary files', async () => {
    (vfs.appendFile as Mock).mockRejectedValue(
      new VfsError('Cannot append to binary file', 'BINARY_FILE')
    );

    const result = await executeFs({
      command: 'append',
      path: '/data/img.png',
      file_text: 'text',
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain('binary file');
  });
});

describe('fsTool delete command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('deletes via vfs.deletePath', async () => {
    (vfs.deletePath as Mock).mockResolvedValue(undefined);

    const result = await executeFs({
      command: 'delete',
      path: '/data/file.txt',
    });

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('Successfully deleted');
    expect(vfs.deletePath).toHaveBeenCalledWith('test-project', '/data/file.txt', undefined);
  });

  it('returns error when path does not exist', async () => {
    (vfs.deletePath as Mock).mockRejectedValue(new VfsError('Path not found', 'PATH_NOT_FOUND'));

    const result = await executeFs({
      command: 'delete',
      path: '/data/missing.txt',
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain('does not exist');
  });

  it('returns generic error for unexpected failures', async () => {
    (vfs.deletePath as Mock).mockRejectedValue(new Error('unexpected'));

    const result = await executeFs({
      command: 'delete',
      path: '/data/file.txt',
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain('could not be deleted');
  });
});

describe('fsTool copy overwrite behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('errors when destination exists without overwrite', async () => {
    (vfs.copyFile as Mock).mockRejectedValue(
      new VfsError('Destination already exists', 'DESTINATION_EXISTS')
    );

    const result = await executeFs({
      command: 'copy',
      old_path: '/data/src.txt',
      new_path: '/data/dst.txt',
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain('already exists');
  });

  it('overwrites when destination exists with overwrite: true', async () => {
    (vfs.copyFile as Mock).mockResolvedValue(undefined);

    const result = await executeFs({
      command: 'copy',
      old_path: '/data/src.txt',
      new_path: '/data/dst.txt',
      overwrite: true,
    });

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('Successfully copied');
    expect(vfs.copyFile).toHaveBeenCalledWith(
      'test-project',
      '/data/src.txt',
      '/data/dst.txt',
      true,
      undefined
    );
  });
});

describe('fsTool rename overwrite behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes overwrite to vfs.rename', async () => {
    (vfs.rename as Mock).mockResolvedValue(undefined);

    const result = await executeFs({
      command: 'rename',
      old_path: '/data/old.txt',
      new_path: '/data/new.txt',
      overwrite: true,
    });

    expect(result.isError).toBeFalsy();
    expect(vfs.rename).toHaveBeenCalledWith(
      'test-project',
      '/data/old.txt',
      '/data/new.txt',
      undefined,
      true
    );
  });

  it('errors when destination exists without overwrite', async () => {
    (vfs.rename as Mock).mockRejectedValue(
      new VfsError('Destination exists', 'DESTINATION_EXISTS')
    );

    const result = await executeFs({
      command: 'rename',
      old_path: '/data/old.txt',
      new_path: '/data/new.txt',
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain('already exists');
  });
});

describe('fsTool input validation', () => {
  it('returns error when command is missing', async () => {
    const result = await executeFs({});
    expect(result.content).toBe('Error: command is required');
    expect(result.isError).toBe(true);
  });

  it('returns error when command is not a string', async () => {
    const result = await executeFs({ command: 123 });
    expect(result.content).toBe('Error: command is required');
    expect(result.isError).toBe(true);
  });

  it('returns error when path is missing for delete', async () => {
    const result = await executeFs({ command: 'delete' });
    expect(result.content).toBe('Error: path is required for delete command');
    expect(result.isError).toBe(true);
  });

  it('returns error when path is null for delete', async () => {
    const result = await executeFs({ command: 'delete', path: null });
    expect(result.content).toBe('Error: path is required for delete command');
    expect(result.isError).toBe(true);
  });

  it('returns error when path is missing for view', async () => {
    const result = await executeFs({ command: 'view' });
    expect(result.content).toBe('Error: path is required for view command');
    expect(result.isError).toBe(true);
  });

  it('returns error when path is missing for create', async () => {
    const result = await executeFs({ command: 'create', file_text: 'hello' });
    expect(result.content).toBe('Error: path is required for create command');
    expect(result.isError).toBe(true);
  });

  it('returns error when path is missing for str_replace', async () => {
    const result = await executeFs({ command: 'str_replace', old_str: 'x' });
    expect(result.content).toBe('Error: path is required for str_replace command');
    expect(result.isError).toBe(true);
  });

  it('returns error when path is missing for mkdir', async () => {
    const result = await executeFs({ command: 'mkdir' });
    expect(result.content).toBe('Error: path is required for mkdir command');
    expect(result.isError).toBe(true);
  });

  it('returns error when old_path is missing for rename', async () => {
    const result = await executeFs({ command: 'rename', new_path: '/b' });
    expect(result.content).toBe('Error: old_path and new_path are required for rename command');
    expect(result.isError).toBe(true);
  });

  it('returns error when new_path is missing for copy', async () => {
    const result = await executeFs({ command: 'copy', old_path: '/a' });
    expect(result.content).toBe('Error: old_path and new_path are required for copy command');
    expect(result.isError).toBe(true);
  });

  it('returns error when old_str is missing for str_replace', async () => {
    const result = await executeFs({ command: 'str_replace', path: '/data/test.txt' });
    expect(result.content).toBe('Error: old_str is required for str_replace command');
    expect(result.isError).toBe(true);
  });

  it('returns error when insert_line is missing for insert', async () => {
    const result = await executeFs({ command: 'insert', path: '/data/test.txt' });
    expect(result.content).toBe('Error: insert_line (number) is required for insert command');
    expect(result.isError).toBe(true);
  });

  it('returns error when insert_line is a string for insert', async () => {
    const result = await executeFs({
      command: 'insert',
      path: '/data/test.txt',
      insert_line: '5',
    });
    expect(result.content).toBe('Error: insert_line (number) is required for insert command');
    expect(result.isError).toBe(true);
  });

  it('returns error when paths is missing for view-all', async () => {
    const result = await executeFs({ command: 'view-all' });
    expect(result.content).toBe('Error: paths (array) is required for view-all command');
    expect(result.isError).toBe(true);
  });

  it('returns error when paths is a string for view-all', async () => {
    const result = await executeFs({ command: 'view-all', paths: '/data/test.txt' });
    expect(result.content).toBe('Error: paths (array) is required for view-all command');
    expect(result.isError).toBe(true);
  });
});
