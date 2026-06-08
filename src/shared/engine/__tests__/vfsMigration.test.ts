import { describe, it, expect, vi, beforeEach } from 'vitest';
import { migrateProjectVfs, migrateProjectVfsBulk } from '../vfsMigration';
import type { VfsAdapter } from '../../services/vfs/vfsAdapter';
import type { DirEntry, MigrationFileData, ReadFileResult } from '../../services/vfs/vfsService';

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

describe('migrateProjectVfs', () => {
  let source: VfsAdapter;
  let target: VfsAdapter;

  beforeEach(() => {
    source = createMockAdapter();
    target = createMockAdapter();
  });

  it('copies files from source to target', async () => {
    const entries: DirEntry[] = [
      { name: 'hello.txt', type: 'file', deleted: false, createdAt: 1000, updatedAt: 2000 },
    ];
    vi.mocked(source.readDir).mockResolvedValue(entries);
    vi.mocked(source.getFileId).mockResolvedValue('file_1');
    vi.mocked(source.listVersions).mockResolvedValue([]);
    vi.mocked(source.readFileWithMeta).mockResolvedValue({
      content: 'hello world',
      isBinary: false,
      mime: 'text/plain',
    } as ReadFileResult);
    vi.mocked(target.isDirectory).mockResolvedValue(false);

    const result = await migrateProjectVfs(source, target);

    expect(result.filesCopied).toBe(1);
    expect(result.errors).toHaveLength(0);
    expect(target.writeFileWithHistory).toHaveBeenCalledWith(
      '/hello.txt',
      [],
      'hello world',
      false
    );
  });

  it('copies version history oldest-to-newest before current content', async () => {
    const entries: DirEntry[] = [
      { name: 'doc.txt', type: 'file', deleted: false, createdAt: 1000, updatedAt: 3000 },
    ];
    vi.mocked(source.readDir).mockResolvedValue(entries);
    vi.mocked(source.getFileId).mockResolvedValue('/doc.txt');
    vi.mocked(source.listVersions).mockResolvedValue([
      { version: 3, createdAt: 3000 },
      { version: 1, createdAt: 1000 },
      { version: 2, createdAt: 2000 },
    ]);
    vi.mocked(source.getVersion)
      .mockResolvedValueOnce('v1 content') // version 1
      .mockResolvedValueOnce('v2 content'); // version 2
    vi.mocked(source.readFileWithMeta).mockResolvedValue({
      content: 'v3 current',
      isBinary: false,
      mime: 'text/plain',
    } as ReadFileResult);
    vi.mocked(target.isDirectory).mockResolvedValue(false);

    const result = await migrateProjectVfs(source, target);

    expect(result.filesCopied).toBe(1);
    expect(result.versionsCopied).toBe(2);

    // All versions + current written in one writeFileWithHistory call
    expect(target.writeFileWithHistory).toHaveBeenCalledWith(
      '/doc.txt',
      [
        { content: 'v1 content', createdAt: 1000 },
        { content: 'v2 content', createdAt: 2000 },
      ],
      'v3 current',
      false
    );
  });

  it('creates directories on target before writing files', async () => {
    vi.mocked(source.readDir)
      .mockResolvedValueOnce([
        { name: 'sub', type: 'dir', deleted: false, createdAt: 1000, updatedAt: 1000 },
      ])
      .mockResolvedValueOnce([
        { name: 'file.txt', type: 'file', deleted: false, createdAt: 1000, updatedAt: 2000 },
      ]);
    vi.mocked(source.getFileId).mockResolvedValue('file_1');
    vi.mocked(source.listVersions).mockResolvedValue([]);
    vi.mocked(source.readFileWithMeta).mockResolvedValue({
      content: 'nested content',
      isBinary: false,
      mime: 'text/plain',
    } as ReadFileResult);
    vi.mocked(target.isDirectory).mockResolvedValue(false);

    const result = await migrateProjectVfs(source, target);

    expect(result.filesCopied).toBe(1);
    expect(target.mkdir).toHaveBeenCalledWith('/sub');
    expect(target.writeFileWithHistory).toHaveBeenCalledWith(
      '/sub/file.txt',
      [],
      'nested content',
      false
    );
  });

  it('handles binary files with buffer', async () => {
    const buffer = new ArrayBuffer(4);
    new Uint8Array(buffer).set([0x89, 0x50, 0x4e, 0x47]); // PNG header

    vi.mocked(source.readDir).mockResolvedValue([
      { name: 'image.png', type: 'file', deleted: false, createdAt: 1000, updatedAt: 2000 },
    ]);
    vi.mocked(source.getFileId).mockResolvedValue('file_1');
    vi.mocked(source.listVersions).mockResolvedValue([]);
    vi.mocked(source.readFileWithMeta).mockResolvedValue({
      content: 'base64data',
      isBinary: true,
      mime: 'image/png',
      buffer,
    } as ReadFileResult);
    vi.mocked(target.isDirectory).mockResolvedValue(false);

    const result = await migrateProjectVfs(source, target);

    expect(result.filesCopied).toBe(1);
    expect(target.writeFileWithHistory).toHaveBeenCalledWith('/image.png', [], buffer, true);
  });

  it('skips deleted entries', async () => {
    vi.mocked(source.readDir).mockResolvedValue([
      { name: 'deleted.txt', type: 'file', deleted: true, createdAt: 1000, updatedAt: 2000 },
      { name: 'alive.txt', type: 'file', deleted: false, createdAt: 1000, updatedAt: 2000 },
    ]);
    vi.mocked(source.getFileId).mockResolvedValue('file_1');
    vi.mocked(source.listVersions).mockResolvedValue([]);
    vi.mocked(source.readFileWithMeta).mockResolvedValue({
      content: 'alive',
      isBinary: false,
      mime: 'text/plain',
    } as ReadFileResult);
    vi.mocked(target.isDirectory).mockResolvedValue(false);

    const result = await migrateProjectVfs(source, target);

    expect(result.filesCopied).toBe(1);
    expect(target.writeFileWithHistory).toHaveBeenCalledTimes(1);
    expect(target.writeFileWithHistory).toHaveBeenCalledWith('/alive.txt', [], 'alive', false);
  });

  it('reports per-file errors without aborting', async () => {
    vi.mocked(source.readDir).mockResolvedValue([
      { name: 'good.txt', type: 'file', deleted: false, createdAt: 1000, updatedAt: 2000 },
      { name: 'bad.txt', type: 'file', deleted: false, createdAt: 1000, updatedAt: 2000 },
    ]);
    vi.mocked(source.getFileId).mockResolvedValue('file_1');
    vi.mocked(source.listVersions).mockResolvedValue([]);
    vi.mocked(source.readFileWithMeta)
      .mockResolvedValueOnce({
        content: 'good',
        isBinary: false,
        mime: 'text/plain',
      } as ReadFileResult)
      .mockRejectedValueOnce(new Error('read failed'));
    vi.mocked(target.isDirectory).mockResolvedValue(false);

    const result = await migrateProjectVfs(source, target);

    expect(result.filesCopied).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('bad.txt');
    expect(result.errors[0]).toContain('read failed');
  });

  it('reports progress via callback', async () => {
    vi.mocked(source.readDir).mockResolvedValue([
      { name: 'a.txt', type: 'file', deleted: false, createdAt: 1000, updatedAt: 2000 },
      { name: 'b.txt', type: 'file', deleted: false, createdAt: 1000, updatedAt: 2000 },
    ]);
    vi.mocked(source.getFileId).mockResolvedValue('file_1');
    vi.mocked(source.listVersions).mockResolvedValue([]);
    vi.mocked(source.readFileWithMeta).mockResolvedValue({
      content: 'content',
      isBinary: false,
      mime: 'text/plain',
    } as ReadFileResult);
    vi.mocked(target.isDirectory).mockResolvedValue(false);

    const onProgress = vi.fn();
    await migrateProjectVfs(source, target, onProgress);

    expect(onProgress).toHaveBeenCalledTimes(2);
    expect(onProgress).toHaveBeenCalledWith({
      filesProcessed: 1,
      totalFiles: 2,
      versionsProcessed: 0,
    });
    expect(onProgress).toHaveBeenCalledWith({
      filesProcessed: 2,
      totalFiles: 2,
      versionsProcessed: 0,
    });
  });

  it('handles empty VFS gracefully', async () => {
    vi.mocked(source.readDir).mockResolvedValue([]);

    const result = await migrateProjectVfs(source, target);

    expect(result.filesCopied).toBe(0);
    expect(result.versionsCopied).toBe(0);
    expect(result.errors).toHaveLength(0);
    expect(target.writeFileWithHistory).not.toHaveBeenCalled();
  });
});

describe('migrateProjectVfsBulk', () => {
  let target: VfsAdapter;

  beforeEach(() => {
    target = createMockAdapter();
    vi.mocked(target.isDirectory).mockResolvedValue(false);
  });

  it('writes files via writeFileWithHistory', async () => {
    const files: MigrationFileData[] = [
      {
        path: '/hello.txt',
        content: 'current',
        isBinary: false,
        mime: 'text/plain',
        versions: [
          { version: 1, content: 'v1', createdAt: 1000 },
          { version: 2, content: 'v2', createdAt: 2000 },
        ],
      },
    ];

    const result = await migrateProjectVfsBulk(files, target);

    expect(result.filesCopied).toBe(1);
    expect(result.versionsCopied).toBe(2);
    expect(result.errors).toHaveLength(0);
    expect(target.writeFileWithHistory).toHaveBeenCalledWith(
      '/hello.txt',
      [
        { version: 1, content: 'v1', createdAt: 1000 },
        { version: 2, content: 'v2', createdAt: 2000 },
      ],
      'current',
      false
    );
  });

  it('creates parent directories before writing', async () => {
    const files: MigrationFileData[] = [
      {
        path: '/a/b/file.txt',
        content: 'nested',
        isBinary: false,
        mime: 'text/plain',
        versions: [],
      },
    ];

    await migrateProjectVfsBulk(files, target);

    expect(target.mkdir).toHaveBeenCalledWith('/a');
    expect(target.mkdir).toHaveBeenCalledWith('/a/b');
  });

  it('handles per-file errors without aborting', async () => {
    vi.mocked(target.writeFileWithHistory)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('disk full'))
      .mockResolvedValueOnce(undefined);

    const files: MigrationFileData[] = [
      { path: '/a.txt', content: 'a', isBinary: false, mime: 'text/plain', versions: [] },
      { path: '/b.txt', content: 'b', isBinary: false, mime: 'text/plain', versions: [] },
      { path: '/c.txt', content: 'c', isBinary: false, mime: 'text/plain', versions: [] },
    ];

    const result = await migrateProjectVfsBulk(files, target, undefined, 1);

    expect(result.filesCopied).toBe(2);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('b.txt');
    expect(result.errors[0]).toContain('disk full');
  });

  it('reports progress', async () => {
    const files: MigrationFileData[] = [
      { path: '/a.txt', content: 'a', isBinary: false, mime: 'text/plain', versions: [] },
      { path: '/b.txt', content: 'b', isBinary: false, mime: 'text/plain', versions: [] },
    ];

    const onProgress = vi.fn();
    await migrateProjectVfsBulk(files, target, onProgress, 1);

    expect(onProgress).toHaveBeenCalledTimes(2);
    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({ filesProcessed: 1, totalFiles: 2 })
    );
    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({ filesProcessed: 2, totalFiles: 2 })
    );
  });

  it('processes multiple files concurrently', async () => {
    // Track concurrent execution
    let maxConcurrent = 0;
    let currentConcurrent = 0;

    vi.mocked(target.writeFileWithHistory).mockImplementation(async () => {
      currentConcurrent++;
      if (currentConcurrent > maxConcurrent) maxConcurrent = currentConcurrent;
      await new Promise(r => setTimeout(r, 10));
      currentConcurrent--;
    });

    const files: MigrationFileData[] = Array.from({ length: 8 }, (_, i) => ({
      path: `/file${i}.txt`,
      content: `content${i}`,
      isBinary: false,
      mime: 'text/plain',
      versions: [],
    }));

    await migrateProjectVfsBulk(files, target, undefined, 4);

    expect(maxConcurrent).toBeGreaterThan(1);
    expect(maxConcurrent).toBeLessThanOrEqual(4);
    expect(target.writeFileWithHistory).toHaveBeenCalledTimes(8);
  });

  it('handles empty file list', async () => {
    const result = await migrateProjectVfsBulk([], target);

    expect(result.filesCopied).toBe(0);
    expect(result.versionsCopied).toBe(0);
    expect(result.errors).toHaveLength(0);
    expect(target.writeFileWithHistory).not.toHaveBeenCalled();
  });
});
