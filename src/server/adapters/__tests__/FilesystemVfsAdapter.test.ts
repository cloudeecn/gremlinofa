import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FilesystemVfsAdapter } from '../FilesystemVfsAdapter';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('FilesystemVfsAdapter', () => {
  let adapter: FilesystemVfsAdapter;
  let tmpDir: string;
  const projectId = 'test-project';

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsvfs-test-'));
    adapter = new FilesystemVfsAdapter(tmpDir, projectId);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // --------------------------------------------------------------------------
  // Basic CRUD
  // --------------------------------------------------------------------------

  describe('writeFile / readFile', () => {
    it('should write and read a file', async () => {
      await adapter.writeFile('/hello.txt', 'world');
      const content = await adapter.readFile('/hello.txt');
      expect(content).toBe('world');
    });

    it('should create parent directories automatically', async () => {
      await adapter.writeFile('/a/b/c.txt', 'nested');
      expect(await adapter.readFile('/a/b/c.txt')).toBe('nested');
    });

    it('should overwrite existing file', async () => {
      await adapter.writeFile('/f.txt', 'v1');
      await adapter.writeFile('/f.txt', 'v2');
      expect(await adapter.readFile('/f.txt')).toBe('v2');
    });
  });

  describe('createFile', () => {
    it('should create a new file', async () => {
      await adapter.createFile('/new.txt', 'content');
      expect(await adapter.readFile('/new.txt')).toBe('content');
    });

    it('should throw if file already exists', async () => {
      await adapter.writeFile('/existing.txt', 'data');
      await expect(adapter.createFile('/existing.txt', 'data')).rejects.toThrow('already exists');
    });
  });

  describe('deleteFile', () => {
    it('should delete a file and its version directory', async () => {
      await adapter.writeFile('/f.txt', 'data');
      // Verify version dir was created
      const projectRoot = path.join(tmpDir, projectId);
      expect(fs.existsSync(path.join(projectRoot, '.f.txt.ver'))).toBe(true);

      await adapter.deleteFile('/f.txt');
      expect(await adapter.exists('/f.txt')).toBe(false);
      expect(fs.existsSync(path.join(projectRoot, '.f.txt.ver'))).toBe(false);
    });
  });

  describe('readDir', () => {
    it('should list directory entries', async () => {
      await adapter.writeFile('/a.txt', 'aaa');
      await adapter.writeFile('/b.txt', 'bbb');
      await adapter.mkdir('/sub');

      const entries = await adapter.readDir('/');
      const names = entries.map(e => e.name).sort();
      expect(names).toEqual(['a.txt', 'b.txt', 'sub']);
    });

    it('should exclude version directories', async () => {
      await adapter.writeFile('/file.txt', 'data');
      const entries = await adapter.readDir('/');
      const names = entries.map(e => e.name);
      expect(names).not.toContain('.file.txt.ver');
    });
  });

  describe('exists / isFile / isDirectory', () => {
    it('should detect file existence', async () => {
      expect(await adapter.exists('/nope.txt')).toBe(false);
      await adapter.writeFile('/yes.txt', 'data');
      expect(await adapter.exists('/yes.txt')).toBe(true);
    });

    it('should distinguish files and directories', async () => {
      await adapter.writeFile('/f.txt', 'data');
      await adapter.mkdir('/d');

      expect(await adapter.isFile('/f.txt')).toBe(true);
      expect(await adapter.isDirectory('/f.txt')).toBe(false);
      expect(await adapter.isFile('/d')).toBe(false);
      expect(await adapter.isDirectory('/d')).toBe(true);
    });
  });

  describe('stat', () => {
    it('should return file stats', async () => {
      await adapter.writeFile('/f.txt', 'hello');
      const st = await adapter.stat('/f.txt');
      expect(st.isFile).toBe(true);
      expect(st.isDirectory).toBe(false);
      expect(st.size).toBeGreaterThan(0);
      expect(st.isBinary).toBe(false);
      expect(st.mime).toBe('text/plain');
    });
  });

  // --------------------------------------------------------------------------
  // Directory operations
  // --------------------------------------------------------------------------

  describe('mkdir / rmdir', () => {
    it('should create and remove directories', async () => {
      await adapter.mkdir('/mydir');
      expect(await adapter.isDirectory('/mydir')).toBe(true);

      await adapter.rmdir('/mydir');
      expect(await adapter.exists('/mydir')).toBe(false);
    });

    it('should remove recursively', async () => {
      await adapter.writeFile('/parent/child/f.txt', 'data');
      await adapter.rmdir('/parent', true);
      expect(await adapter.exists('/parent')).toBe(false);
    });
  });

  describe('rename', () => {
    it('should rename a file', async () => {
      await adapter.writeFile('/old.txt', 'data');
      await adapter.rename('/old.txt', '/new.txt');
      expect(await adapter.exists('/old.txt')).toBe(false);
      expect(await adapter.readFile('/new.txt')).toBe('data');
    });

    it('should move version directory on rename', async () => {
      await adapter.writeFile('/old.txt', 'v1');
      await adapter.rename('/old.txt', '/new.txt');

      const projectRoot = path.join(tmpDir, projectId);
      expect(fs.existsSync(path.join(projectRoot, '.old.txt.ver'))).toBe(false);
      expect(fs.existsSync(path.join(projectRoot, '.new.txt.ver'))).toBe(true);
    });

    it('should throw if target exists and overwrite not set', async () => {
      await adapter.writeFile('/a.txt', 'data1');
      await adapter.writeFile('/b.txt', 'data2');
      await expect(adapter.rename('/a.txt', '/b.txt')).rejects.toThrow('already exists');
    });
  });

  // --------------------------------------------------------------------------
  // Text editing
  // --------------------------------------------------------------------------

  describe('strReplace', () => {
    it('should replace a string in a file', async () => {
      await adapter.writeFile('/f.txt', 'hello world');
      const result = await adapter.strReplace('/f.txt', 'world', 'there');
      expect(result.editLine).toBe(1);
      expect(await adapter.readFile('/f.txt')).toBe('hello there');
    });

    it('should throw if string not found', async () => {
      await adapter.writeFile('/f.txt', 'hello');
      await expect(adapter.strReplace('/f.txt', 'missing', 'x')).rejects.toThrow('not found');
    });

    it('should throw if string is not unique', async () => {
      await adapter.writeFile('/f.txt', 'aaa bbb aaa');
      await expect(adapter.strReplace('/f.txt', 'aaa', 'ccc')).rejects.toThrow('not unique');
    });
  });

  describe('insert', () => {
    it('should insert text at a line number', async () => {
      await adapter.writeFile('/f.txt', 'line1\nline3');
      const result = await adapter.insert('/f.txt', 2, 'line2');
      expect(result.insertedAt).toBe(2);
      expect(await adapter.readFile('/f.txt')).toBe('line1\nline2\nline3');
    });
  });

  describe('appendFile', () => {
    it('should append text to existing file', async () => {
      await adapter.writeFile('/f.txt', 'hello');
      const result = await adapter.appendFile('/f.txt', ' world');
      expect(result.created).toBe(false);
      expect(await adapter.readFile('/f.txt')).toBe('hello world');
    });

    it('should create file if it does not exist', async () => {
      const result = await adapter.appendFile('/new.txt', 'content');
      expect(result.created).toBe(true);
      expect(await adapter.readFile('/new.txt')).toBe('content');
    });
  });

  // --------------------------------------------------------------------------
  // Versioning
  // --------------------------------------------------------------------------

  describe('versioning', () => {
    it('should create versions on write', async () => {
      await adapter.writeFile('/f.txt', 'v1');
      await adapter.writeFile('/f.txt', 'v2');
      await adapter.writeFile('/f.txt', 'v3');

      const meta = await adapter.getFileMeta('/f.txt');
      expect(meta).not.toBeNull();
      expect(meta!.version).toBe(3);
      expect(meta!.storedVersionCount).toBe(3);
    });

    it('should list versions', async () => {
      await adapter.writeFile('/f.txt', 'v1');
      await adapter.writeFile('/f.txt', 'v2');

      const fileId = await adapter.getFileId('/f.txt');
      expect(fileId).toBe('/f.txt');

      const versions = await adapter.listVersions(fileId!);
      expect(versions).toHaveLength(2);
      expect(versions[0].version).toBe(1);
      expect(versions[1].version).toBe(2);
    });

    it('should retrieve a specific version', async () => {
      await adapter.writeFile('/f.txt', 'version-one');
      await adapter.writeFile('/f.txt', 'version-two');

      const v1 = await adapter.getVersion('/f.txt', 1);
      expect(v1).toBe('version-one');

      const v2 = await adapter.getVersion('/f.txt', 2);
      expect(v2).toBe('version-two');
    });

    it('should return null for nonexistent version', async () => {
      await adapter.writeFile('/f.txt', 'data');
      const result = await adapter.getVersion('/f.txt', 999);
      expect(result).toBeNull();
    });

    it('should drop old versions', async () => {
      await adapter.writeFile('/f.txt', 'v1');
      await adapter.writeFile('/f.txt', 'v2');
      await adapter.writeFile('/f.txt', 'v3');
      await adapter.writeFile('/f.txt', 'v4');

      const dropped = await adapter.dropOldVersions('/f.txt', 2);
      expect(dropped).toBe(2); // dropped v1 and v2

      const versions = await adapter.listVersions('/f.txt');
      expect(versions).toHaveLength(2);
      expect(versions[0].version).toBe(3);
      expect(versions[1].version).toBe(4);
    });
  });

  describe('getFileMeta for nonexistent file', () => {
    it('should return null', async () => {
      const meta = await adapter.getFileMeta('/nope.txt');
      expect(meta).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // Compound operations
  // --------------------------------------------------------------------------

  describe('copyFile', () => {
    it('should copy a file', async () => {
      await adapter.writeFile('/src.txt', 'original');
      await adapter.copyFile('/src.txt', '/dst.txt');
      expect(await adapter.readFile('/dst.txt')).toBe('original');
    });

    it('should throw if target exists and overwrite not set', async () => {
      await adapter.writeFile('/a.txt', 'd1');
      await adapter.writeFile('/b.txt', 'd2');
      await expect(adapter.copyFile('/a.txt', '/b.txt')).rejects.toThrow('already exists');
    });
  });

  describe('deletePath', () => {
    it('should delete a file', async () => {
      await adapter.writeFile('/f.txt', 'data');
      await adapter.deletePath('/f.txt');
      expect(await adapter.exists('/f.txt')).toBe(false);
    });

    it('should delete a directory recursively', async () => {
      await adapter.writeFile('/dir/f.txt', 'data');
      await adapter.deletePath('/dir');
      expect(await adapter.exists('/dir')).toBe(false);
    });

    it('should no-op for nonexistent path', async () => {
      await adapter.deletePath('/nope');
      // Should not throw
    });
  });

  describe('ensureDirAndWrite', () => {
    it('should create dir and write files', async () => {
      await adapter.ensureDirAndWrite('/mydir', [
        { name: 'a.txt', content: 'aaa' },
        { name: 'b.txt', content: 'bbb' },
      ]);
      expect(await adapter.readFile('/mydir/a.txt')).toBe('aaa');
      expect(await adapter.readFile('/mydir/b.txt')).toBe('bbb');
    });
  });

  // --------------------------------------------------------------------------
  // Compact
  // --------------------------------------------------------------------------

  describe('compactProject', () => {
    it('should prune old versions', async () => {
      // Write 10 versions
      for (let i = 0; i < 10; i++) {
        await adapter.writeFile('/f.txt', `version ${i}`);
      }

      const meta = await adapter.getFileMeta('/f.txt');
      expect(meta!.storedVersionCount).toBe(10);

      const result = await adapter.compactProject();
      expect(result.prunedRevisions).toBe(5); // default keeps 5
      expect(result.fileCount).toBe(1);

      const metaAfter = await adapter.getFileMeta('/f.txt');
      expect(metaAfter!.storedVersionCount).toBe(5);
    });
  });

  // --------------------------------------------------------------------------
  // hasVfs / clearVfs
  // --------------------------------------------------------------------------

  describe('hasVfs / clearVfs', () => {
    it('should report VFS existence', async () => {
      // Before any write, the project root may not exist
      await adapter.writeFile('/f.txt', 'data');
      expect(await adapter.hasVfs()).toBe(true);

      await adapter.clearVfs();
      expect(await adapter.hasVfs()).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // Path traversal protection
  // --------------------------------------------------------------------------

  describe('path traversal', () => {
    it('should reject path traversal attempts', async () => {
      await expect(adapter.readFile('/../../../etc/passwd')).rejects.toThrow('traversal');
    });
  });

  // --------------------------------------------------------------------------
  // Orphan management (no-op for filesystem)
  // --------------------------------------------------------------------------

  describe('orphan management', () => {
    it('should return empty orphan list', async () => {
      expect(await adapter.listOrphans()).toEqual([]);
    });

    it('should throw on restoreOrphan', async () => {
      await expect(adapter.restoreOrphan('id', '/path')).rejects.toThrow('not supported');
    });

    it('should throw on purgeOrphan', async () => {
      await expect(adapter.purgeOrphan('id')).rejects.toThrow('not supported');
    });
  });

  // --------------------------------------------------------------------------
  // readFileWithMeta
  // --------------------------------------------------------------------------

  describe('readFileWithMeta', () => {
    it('should return content with metadata', async () => {
      await adapter.writeFile('/f.txt', 'hello world');
      const result = await adapter.readFileWithMeta('/f.txt');
      expect(result.content).toBe('hello world');
      expect(result.isBinary).toBe(false);
      expect(result.mime).toBe('text/plain');
    });
  });

  // --------------------------------------------------------------------------
  // writeFileWithHistory (bulk migration)
  // --------------------------------------------------------------------------

  describe('writeFileWithHistory', () => {
    it('should write file with version history', async () => {
      await adapter.writeFileWithHistory(
        '/doc.txt',
        [
          { content: 'version 1', createdAt: 1000 },
          { content: 'version 2', createdAt: 2000 },
        ],
        'current content',
        false
      );

      // Current content is correct
      expect(await adapter.readFile('/doc.txt')).toBe('current content');

      // Version metadata is correct
      const meta = await adapter.getFileMeta('/doc.txt');
      expect(meta).not.toBeNull();
      expect(meta!.version).toBe(3); // 2 historical + 1 current
      expect(meta!.storedVersionCount).toBe(3);
      expect(meta!.createdAt).toBe(1000);

      // Historical versions are retrievable
      expect(await adapter.getVersion('/doc.txt', 1)).toBe('version 1');
      expect(await adapter.getVersion('/doc.txt', 2)).toBe('version 2');
      expect(await adapter.getVersion('/doc.txt', 3)).toBe('current content');
    });

    it('should handle file with no historical versions', async () => {
      await adapter.writeFileWithHistory('/fresh.txt', [], 'only version', false);

      expect(await adapter.readFile('/fresh.txt')).toBe('only version');
      const meta = await adapter.getFileMeta('/fresh.txt');
      expect(meta!.version).toBe(1);
      expect(meta!.storedVersionCount).toBe(1);
    });

    it('should create parent directories', async () => {
      await adapter.writeFileWithHistory('/deep/nested/file.txt', [], 'nested content', false);

      expect(await adapter.readFile('/deep/nested/file.txt')).toBe('nested content');
    });
  });
});
