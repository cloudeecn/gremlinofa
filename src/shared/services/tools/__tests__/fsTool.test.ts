import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { fsTool } from '../fsTool';
import { VfsError } from '../../vfs';
import type { DirEntry } from '../../vfs';
import type { ToolContext, ToolOptions, ToolResult } from '../../../protocol/types';
import type { VfsAdapter } from '../../vfs/vfsAdapter';
import { stubBackendDeps } from './testStubs';

// Mock VfsAdapter with vi.fn() stubs for each method used in fsTool
function createMockAdapter(): VfsAdapter {
  return {
    readDir: vi.fn(),
    readFile: vi.fn(),
    readFileWithMeta: vi.fn(),
    writeFile: vi.fn(),
    createFile: vi.fn(),
    deleteFile: vi.fn(),
    mkdir: vi.fn(),
    rmdir: vi.fn(),
    rename: vi.fn(),
    exists: vi.fn(),
    isFile: vi.fn(),
    isDirectory: vi.fn(),
    stat: vi.fn(),
    hasVfs: vi.fn(),
    clearVfs: vi.fn(),
    strReplace: vi.fn(),
    insert: vi.fn(),
    appendFile: vi.fn(),
    getFileMeta: vi.fn(),
    getFileId: vi.fn(),
    listVersions: vi.fn(),
    getVersion: vi.fn(),
    dropOldVersions: vi.fn(),
    listOrphans: vi.fn(),
    restoreOrphan: vi.fn(),
    purgeOrphan: vi.fn(),
    copyFile: vi.fn(),
    deletePath: vi.fn(),
    createFileGuarded: vi.fn(),
    ensureDirAndWrite: vi.fn(),
    writeFileWithHistory: vi.fn(),
    compactProject: vi.fn(),
  } as VfsAdapter;
}

let mockAdapter: VfsAdapter;

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
  toolOptions: ToolOptions = {},
  contextOverrides: Partial<ToolContext> = {}
) {
  const context: ToolContext = {
    projectId,
    vfsAdapter: mockAdapter,
    createVfsAdapter: () => createMockAdapter(),
    signal: new AbortController().signal,
    ...stubBackendDeps,
    ...contextOverrides,
  };
  return collectToolResult(fsTool.execute(input, toolOptions, context));
}

describe('fsTool view-all command', () => {
  beforeEach(() => {
    mockAdapter = createMockAdapter();
  });

  it('returns concatenated content for multiple valid files', async () => {
    (mockAdapter.isDirectory as Mock).mockResolvedValue(false);
    (mockAdapter.readFileWithMeta as Mock)
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
    (mockAdapter.isDirectory as Mock)
      .mockResolvedValueOnce(false)
      .mockRejectedValueOnce(new VfsError('Path not found', 'PATH_NOT_FOUND'));
    (mockAdapter.readFileWithMeta as Mock).mockResolvedValueOnce({
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
    (mockAdapter.isDirectory as Mock)
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

describe('fsTool view directory listing', () => {
  /** Build a DirEntry; files carry a size, dirs do not */
  function entry(name: string, type: 'file' | 'dir', size?: number): DirEntry {
    return { name, type, deleted: false, createdAt: 0, updatedAt: 0, size };
  }

  /** Back readDir with an in-memory tree keyed by absolute path */
  function mountTree(tree: Record<string, DirEntry[]>) {
    (mockAdapter.isDirectory as Mock).mockResolvedValue(true);
    (mockAdapter.readDir as Mock).mockImplementation(async (p: string) => {
      const node = tree[p];
      if (!node) throw new VfsError(`Path not found: ${p}`, 'PATH_NOT_FOUND');
      return node;
    });
  }

  beforeEach(() => {
    mockAdapter = createMockAdapter();
  });

  it('lists only immediate children by default (depth 1)', async () => {
    mountTree({
      '/proj': [entry('a.txt', 'file', 10), entry('sub', 'dir')],
      '/proj/sub': [entry('child.txt', 'file', 5)],
    });

    const result = await executeFs({ command: 'view', path: '/proj' });

    expect(result.content).toContain('directly in /proj');
    expect(result.content).toContain('/proj/a.txt');
    expect(result.content).toContain('/proj/sub');
    expect(result.content).not.toContain('/proj/sub/child.txt');
  });

  it('descends one extra level with depth 2 (legacy behavior)', async () => {
    mountTree({
      '/proj': [entry('sub', 'dir')],
      '/proj/sub': [entry('child.txt', 'file', 5)],
    });

    const result = await executeFs({ command: 'view', path: '/proj', depth: 2 });

    expect(result.content).toContain('up to 2 levels deep in /proj');
    expect(result.content).toContain('/proj/sub/child.txt');
  });

  it('recurses depth 3 in depth-first pre-order', async () => {
    mountTree({
      '/proj': [entry('a', 'dir')],
      '/proj/a': [entry('b', 'dir')],
      '/proj/a/b': [entry('c.txt', 'file', 3)],
    });

    const result = await executeFs({ command: 'view', path: '/proj', depth: 3 });
    const content = result.content!;

    expect(content).toContain('/proj/a/b/c.txt');
    // Pre-order: each ancestor appears before its descendant
    expect(content.indexOf('/proj/a\n')).toBeLessThan(content.indexOf('/proj/a/b\n'));
    expect(content.indexOf('/proj/a/b\n')).toBeLessThan(content.indexOf('/proj/a/b/c.txt'));
  });

  it('renders file children with human-readable size and full path', async () => {
    mountTree({
      '/proj': [entry('sub', 'dir')],
      '/proj/sub': [entry('big.bin', 'file', 2048)],
    });

    const result = await executeFs({ command: 'view', path: '/proj', depth: 2 });

    expect(result.content).toContain('2.0K\t/proj/sub/big.bin');
  });

  it('clamps depth 0 and negative depth to 1', async () => {
    const tree = {
      '/proj': [entry('sub', 'dir')],
      '/proj/sub': [entry('child.txt', 'file', 5)],
    };

    mountTree(tree);
    const zero = await executeFs({ command: 'view', path: '/proj', depth: 0 });
    expect(zero.content).toContain('directly in /proj');
    expect(zero.content).not.toContain('/proj/sub/child.txt');

    mockAdapter = createMockAdapter();
    mountTree(tree);
    const negative = await executeFs({ command: 'view', path: '/proj', depth: -3 });
    expect(negative.content).toContain('directly in /proj');
    expect(negative.content).not.toContain('/proj/sub/child.txt');
  });

  it('clamps depth above the max to 5', async () => {
    mountTree({
      '/proj': [entry('l1', 'dir')],
      '/proj/l1': [entry('l2', 'dir')],
      '/proj/l1/l2': [entry('l3', 'dir')],
      '/proj/l1/l2/l3': [entry('l4', 'dir')],
      '/proj/l1/l2/l3/l4': [entry('l5', 'dir')],
      '/proj/l1/l2/l3/l4/l5': [entry('l6.txt', 'file', 1)],
    });

    const result = await executeFs({ command: 'view', path: '/proj', depth: 99 });

    expect(result.content).toContain('up to 5 levels deep in /proj');
    expect(result.content).toContain('/proj/l1/l2/l3/l4/l5');
    expect(result.content).not.toContain('/proj/l1/l2/l3/l4/l5/l6.txt');
  });

  it('floors a non-integer depth', async () => {
    mountTree({
      '/proj': [entry('sub', 'dir')],
      '/proj/sub': [entry('child', 'dir')],
      '/proj/sub/child': [entry('deep.txt', 'file', 1)],
    });

    const result = await executeFs({ command: 'view', path: '/proj', depth: 2.7 });

    expect(result.content).toContain('up to 2 levels deep in /proj');
    expect(result.content).toContain('/proj/sub/child');
    expect(result.content).not.toContain('/proj/sub/child/deep.txt');
  });

  it('reports an empty directory with depth-appropriate header', async () => {
    mountTree({ '/proj': [] });

    const result = await executeFs({ command: 'view', path: '/proj' });

    expect(result.content).toContain('directly in /proj');
    expect(result.content).toContain('(empty)');
  });

  it('skips an inaccessible child directory without failing the listing', async () => {
    (mockAdapter.isDirectory as Mock).mockResolvedValue(true);
    (mockAdapter.readDir as Mock).mockImplementation(async (p: string) => {
      if (p === '/proj') return [entry('ok', 'dir'), entry('locked', 'dir')];
      if (p === '/proj/ok') return [entry('keep.txt', 'file', 4)];
      throw new VfsError('boom', 'PATH_NOT_FOUND');
    });

    const result = await executeFs({ command: 'view', path: '/proj', depth: 2 });

    expect(result.content).toContain('/proj/ok/keep.txt');
    expect(result.content).toContain('/proj/locked');
    expect(result.isError).toBeFalsy();
  });
});

describe('fsTool copy command', () => {
  beforeEach(() => {
    mockAdapter = createMockAdapter();
  });

  it('copies a file via adapter.copyFile', async () => {
    (mockAdapter.copyFile as Mock).mockResolvedValue(undefined);

    const result = await executeFs({
      command: 'copy',
      old_path: '/data/src.txt',
      new_path: '/data/dst.txt',
    });

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('Successfully copied /data/src.txt to /data/dst.txt');
    expect(mockAdapter.copyFile).toHaveBeenCalledWith('/data/src.txt', '/data/dst.txt', undefined);
  });

  it('returns error when destination is a directory', async () => {
    (mockAdapter.copyFile as Mock).mockRejectedValue(
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
    (mockAdapter.copyFile as Mock).mockRejectedValue(
      new VfsError('Path not found', 'PATH_NOT_FOUND')
    );

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
    mockAdapter = createMockAdapter();
  });

  it('creates a text file using createFileGuarded', async () => {
    (mockAdapter.createFileGuarded as Mock).mockResolvedValue(undefined);

    const result = await executeFs({
      command: 'create',
      path: '/data/new.txt',
      file_text: 'hello',
    });

    expect(result.content).toBe('File created successfully at: /data/new.txt');
    expect(result.isError).toBeFalsy();
    expect(mockAdapter.createFileGuarded).toHaveBeenCalledWith('/data/new.txt', 'hello', undefined);
  });

  it('returns error when file already exists without overwrite', async () => {
    (mockAdapter.createFileGuarded as Mock).mockRejectedValue(
      new VfsError('File exists', 'FILE_EXISTS')
    );

    const result = await executeFs({
      command: 'create',
      path: '/data/existing.txt',
      file_text: 'content',
    });

    expect(result.content).toBe('Error: File /data/existing.txt already exists');
    expect(result.isError).toBe(true);
  });

  it('overwrites existing text file when overwrite is true', async () => {
    (mockAdapter.createFileGuarded as Mock).mockResolvedValue(undefined);

    const result = await executeFs({
      command: 'create',
      path: '/data/existing.txt',
      file_text: 'new content',
      overwrite: true,
    });

    expect(result.content).toBe('File created successfully at: /data/existing.txt');
    expect(result.isError).toBeFalsy();
    expect(mockAdapter.createFileGuarded).toHaveBeenCalledWith(
      '/data/existing.txt',
      'new content',
      true
    );
  });

  it('returns error for binary file when it exists without overwrite', async () => {
    (mockAdapter.createFileGuarded as Mock).mockRejectedValue(
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
    (mockAdapter.createFileGuarded as Mock).mockResolvedValue(undefined);

    const result = await executeFs({
      command: 'create',
      path: '/data/img.png',
      file_text: 'data:image/png;base64,iVBORw0KGgo=',
    });

    expect(result.content).toBe('Binary file created successfully at: /data/img.png');
    expect(result.isError).toBeFalsy();
    expect(mockAdapter.createFileGuarded).toHaveBeenCalled();
  });

  it('overwrites existing binary file when overwrite is true', async () => {
    (mockAdapter.createFileGuarded as Mock).mockResolvedValue(undefined);

    const result = await executeFs({
      command: 'create',
      path: '/data/img.png',
      file_text: 'data:image/png;base64,iVBORw0KGgo=',
      overwrite: true,
    });

    expect(result.content).toBe('Binary file created successfully at: /data/img.png');
    expect(result.isError).toBeFalsy();
    expect(mockAdapter.createFileGuarded).toHaveBeenCalledWith(
      '/data/img.png',
      expect.any(ArrayBuffer),
      true
    );
  });
});

describe('fsTool str_replace command', () => {
  beforeEach(() => {
    mockAdapter = createMockAdapter();
  });

  it('omitting new_str deletes matched text instead of inserting "undefined"', async () => {
    (mockAdapter.strReplace as Mock).mockResolvedValue({
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
    expect(mockAdapter.strReplace).toHaveBeenCalledWith('/data/test.txt', ' world', '');
  });

  it('returns snippet on successful replacement', async () => {
    (mockAdapter.strReplace as Mock).mockResolvedValue({
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
    (mockAdapter.strReplace as Mock).mockRejectedValue(
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
    (mockAdapter.strReplace as Mock).mockRejectedValue(
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
    (mockAdapter.strReplace as Mock).mockRejectedValue(new VfsError('Binary file', 'BINARY_FILE'));

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
    mockAdapter = createMockAdapter();
  });

  it('inserts text at a line via adapter.insert', async () => {
    (mockAdapter.insert as Mock).mockResolvedValue({ insertedAt: 2 });

    const result = await executeFs({
      command: 'insert',
      path: '/data/test.txt',
      insert_line: 2,
      insert_text: 'new line',
    });

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('has been edited');
    expect(mockAdapter.insert).toHaveBeenCalledWith('/data/test.txt', 2, 'new line');
  });

  it('returns error for invalid line number', async () => {
    (mockAdapter.insert as Mock).mockRejectedValue(
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
    (mockAdapter.insert as Mock).mockRejectedValue(new VfsError('Binary file', 'BINARY_FILE'));

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
    mockAdapter = createMockAdapter();
  });

  it('appends to existing file with trailing newline', async () => {
    (mockAdapter.appendFile as Mock).mockResolvedValue({ created: false });

    const result = await executeFs({
      command: 'append',
      path: '/data/test.txt',
      file_text: 'appended text',
    });

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('Content appended to');
    expect(mockAdapter.appendFile).toHaveBeenCalledWith('/data/test.txt', 'appended text\n');
  });

  it('does not double-add newline when text already ends with one', async () => {
    (mockAdapter.appendFile as Mock).mockResolvedValue({ created: false });

    await executeFs({
      command: 'append',
      path: '/data/test.txt',
      file_text: 'appended text\n',
    });

    expect(mockAdapter.appendFile).toHaveBeenCalledWith('/data/test.txt', 'appended text\n');
  });

  it('creates file when it does not exist', async () => {
    (mockAdapter.appendFile as Mock).mockResolvedValue({ created: true });

    const result = await executeFs({
      command: 'append',
      path: '/data/new.txt',
      file_text: 'initial text',
    });

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('File created successfully at');
  });

  it('omitting file_text appends nothing instead of "undefined"', async () => {
    (mockAdapter.appendFile as Mock).mockResolvedValue({ created: false });

    const result = await executeFs({
      command: 'append',
      path: '/data/test.txt',
      // file_text intentionally omitted
    });

    expect(result.isError).toBeFalsy();
    expect(mockAdapter.appendFile).toHaveBeenCalledWith('/data/test.txt', '');
  });

  it('returns error for binary files', async () => {
    (mockAdapter.appendFile as Mock).mockRejectedValue(
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

describe('fsTool append_raw command', () => {
  beforeEach(() => {
    mockAdapter = createMockAdapter();
  });

  it('appends verbatim without trailing newline', async () => {
    (mockAdapter.appendFile as Mock).mockResolvedValue({ created: false });

    await executeFs({
      command: 'append_raw',
      path: '/data/test.txt',
      file_text: 'raw text',
    });

    expect(mockAdapter.appendFile).toHaveBeenCalledWith('/data/test.txt', 'raw text');
  });

  it('creates file when it does not exist', async () => {
    (mockAdapter.appendFile as Mock).mockResolvedValue({ created: true });

    const result = await executeFs({
      command: 'append_raw',
      path: '/data/new.txt',
      file_text: 'initial',
    });

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('File created successfully at');
  });
});

describe('fsTool delete command', () => {
  beforeEach(() => {
    mockAdapter = createMockAdapter();
  });

  it('deletes via adapter.deletePath', async () => {
    (mockAdapter.deletePath as Mock).mockResolvedValue(undefined);

    const result = await executeFs({
      command: 'delete',
      path: '/data/file.txt',
    });

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('Successfully deleted');
    expect(mockAdapter.deletePath).toHaveBeenCalledWith('/data/file.txt');
  });

  it('returns error when path does not exist', async () => {
    (mockAdapter.deletePath as Mock).mockRejectedValue(
      new VfsError('Path not found', 'PATH_NOT_FOUND')
    );

    const result = await executeFs({
      command: 'delete',
      path: '/data/missing.txt',
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain('does not exist');
  });

  it('returns generic error for unexpected failures', async () => {
    (mockAdapter.deletePath as Mock).mockRejectedValue(new Error('unexpected'));

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
    mockAdapter = createMockAdapter();
  });

  it('errors when destination exists without overwrite', async () => {
    (mockAdapter.copyFile as Mock).mockRejectedValue(
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
    (mockAdapter.copyFile as Mock).mockResolvedValue(undefined);

    const result = await executeFs({
      command: 'copy',
      old_path: '/data/src.txt',
      new_path: '/data/dst.txt',
      overwrite: true,
    });

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('Successfully copied');
    expect(mockAdapter.copyFile).toHaveBeenCalledWith('/data/src.txt', '/data/dst.txt', true);
  });
});

describe('fsTool rename overwrite behavior', () => {
  beforeEach(() => {
    mockAdapter = createMockAdapter();
  });

  it('passes overwrite to adapter.rename', async () => {
    (mockAdapter.rename as Mock).mockResolvedValue(undefined);

    const result = await executeFs({
      command: 'rename',
      old_path: '/data/old.txt',
      new_path: '/data/new.txt',
      overwrite: true,
    });

    expect(result.isError).toBeFalsy();
    expect(mockAdapter.rename).toHaveBeenCalledWith('/data/old.txt', '/data/new.txt', true);
  });

  it('errors when destination exists without overwrite', async () => {
    (mockAdapter.rename as Mock).mockRejectedValue(
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
  beforeEach(() => {
    mockAdapter = createMockAdapter();
  });

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

describe('fsTool view line-number precedence', () => {
  beforeEach(() => {
    mockAdapter = createMockAdapter();
    (mockAdapter.isDirectory as Mock).mockResolvedValue(false);
    (mockAdapter.readFileWithMeta as Mock).mockResolvedValue({
      content: 'alpha\nbeta',
      isBinary: false,
    });
  });

  it('per-call withLineNumbers:true shows numbers even when project strips them', async () => {
    const result = await executeFs(
      { command: 'view', path: '/f.txt', withLineNumbers: true },
      'p',
      {},
      {
        noLineNumbers: true,
      }
    );
    expect(result.content).toContain('with line numbers');
    expect(result.content).toContain('     1\talpha');
  });

  it('per-call withLineNumbers:false strips numbers even when the default shows them', async () => {
    const result = await executeFs({ command: 'view', path: '/f.txt', withLineNumbers: false });
    expect(result.content).not.toContain('with line numbers');
    expect(result.content).toContain('alpha\nbeta');
    expect(result.content).not.toContain('     1\talpha');
  });

  it('loop-level fileLineNumbers overrides project noLineNumbers when no per-call value', async () => {
    const result = await executeFs(
      { command: 'view', path: '/f.txt' },
      'p',
      {},
      {
        noLineNumbers: true,
        fileLineNumbers: true,
      }
    );
    expect(result.content).toContain('     1\talpha');
  });

  it('falls back to project noLineNumbers when nothing else is set', async () => {
    const result = await executeFs(
      { command: 'view', path: '/f.txt' },
      'p',
      {},
      {
        noLineNumbers: true,
      }
    );
    expect(result.content).not.toContain('     1\talpha');
    expect(result.content).toContain('alpha\nbeta');
  });
});
