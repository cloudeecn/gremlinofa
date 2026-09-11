import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FilesystemVfsAdapter } from '../FilesystemVfsAdapter';
import { VfsError } from '../../../shared/services/vfs/vfsService';
import type { VfsAccessConfig } from '../../vfsEngine/accessConfig';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DEFAULT_ACCESS_CONFIG: VfsAccessConfig = {
  followSymlinks: false,
  globalAllowedRoots: [],
  projectAllowedRoots: new Map(),
};

describe('FilesystemVfsAdapter', () => {
  let adapter: FilesystemVfsAdapter;
  let tmpDir: string;
  const projectId = 'test-project';

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsvfs-test-'));
    adapter = new FilesystemVfsAdapter(tmpDir, projectId, DEFAULT_ACCESS_CONFIG);
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

    it('should populate size for files and leave dirs without size', async () => {
      await adapter.writeFile('/sized.txt', 'hello world');
      await adapter.mkdir('/subdir');

      const entries = await adapter.readDir('/');
      const file = entries.find(e => e.name === 'sized.txt');
      const dir = entries.find(e => e.name === 'subdir');

      expect(file?.size).toBe(Buffer.byteLength('hello world'));
      expect(dir?.size).toBeUndefined();
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

    it('creates missing parents, and reports DIR_EXISTS unless recursive', async () => {
      await adapter.mkdir('/a/b/c');
      expect(await adapter.isDirectory('/a/b/c')).toBe(true);
      await expect(adapter.mkdir('/a/b/c')).rejects.toMatchObject({ code: 'DIR_EXISTS' });
      await expect(adapter.mkdir('/a/b/c', { recursive: true })).resolves.toBeUndefined();
    });

    it('reports FILE_EXISTS when a file is in the way', async () => {
      await adapter.writeFile('/f', 'x');
      await expect(adapter.mkdir('/f', { recursive: true })).rejects.toMatchObject({
        code: 'FILE_EXISTS',
      });
    });

    it('refuses to rmdir the project root', async () => {
      await adapter.writeFile('/keep.txt', 'k');
      await expect(adapter.rmdir('/', true)).rejects.toMatchObject({ code: 'INVALID_PATH' });
      expect(await adapter.readFile('/keep.txt')).toBe('k');
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
      await expect(adapter.rename('/a.txt', '/b.txt')).rejects.toMatchObject({
        code: 'DESTINATION_EXISTS',
      });
    });

    it('should throw PATH_NOT_FOUND when source is missing', async () => {
      await expect(adapter.rename('/nope.txt', '/b.txt')).rejects.toMatchObject({
        code: 'PATH_NOT_FOUND',
      });
    });

    it('overwrite replaces the destination history with the source history', async () => {
      await adapter.writeFile('/a.txt', 'a1');
      await adapter.writeFile('/a.txt', 'a2');
      await adapter.writeFile('/b.txt', 'b1');
      await adapter.writeFile('/b.txt', 'b2');
      await adapter.writeFile('/b.txt', 'b3');

      await adapter.rename('/a.txt', '/b.txt', true);

      expect(await adapter.readFile('/b.txt')).toBe('a2');
      const fileId = await adapter.getFileId('/b.txt');
      const versions = await adapter.listVersions(fileId!);
      expect(versions.map(v => v.version)).toEqual([1, 2]);
      expect(await adapter.getVersion(fileId!, 1)).toBe('a1');

      const projectRoot = path.join(tmpDir, projectId);
      expect(fs.existsSync(path.join(projectRoot, '.a.txt.ver'))).toBe(false);
      expect(await adapter.exists('/a.txt')).toBe(false);
    });

    it('overwrite onto a destination with history when the source has none', async () => {
      const projectRoot = path.join(tmpDir, projectId);
      await adapter.writeFile('/b.txt', 'b1');
      fs.writeFileSync(path.join(projectRoot, 'raw.txt'), 'raw');

      await adapter.rename('/raw.txt', '/b.txt', true);

      expect(await adapter.readFile('/b.txt')).toBe('raw');
      expect(fs.existsSync(path.join(projectRoot, '.b.txt.ver'))).toBe(false);
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
      await expect(adapter.copyFile('/a.txt', '/b.txt')).rejects.toMatchObject({
        code: 'DESTINATION_EXISTS',
      });
    });

    it('should throw NOT_A_FILE when destination is a directory', async () => {
      await adapter.writeFile('/a.txt', 'd1');
      await adapter.mkdir('/dir');
      await expect(adapter.copyFile('/a.txt', '/dir', true)).rejects.toMatchObject({
        code: 'NOT_A_FILE',
      });
    });

    it('should throw PATH_NOT_FOUND when source is missing', async () => {
      await expect(adapter.copyFile('/nope.txt', '/b.txt')).rejects.toMatchObject({
        code: 'PATH_NOT_FOUND',
      });
    });

    it('overwrites an existing destination in place', async () => {
      await adapter.writeFile('/a.txt', 'new');
      await adapter.writeFile('/b.txt', 'old and longer');
      const bPath = path.join(tmpDir, projectId, 'b.txt');
      const inodeBefore = fs.statSync(bPath).ino;

      await adapter.copyFile('/a.txt', '/b.txt', true);

      expect(await adapter.readFile('/b.txt')).toBe('new');
      expect(fs.statSync(bPath).ino).toBe(inodeBefore);
    });

    it('overwrite rewrites the destination in place (same inode)', async () => {
      await adapter.writeFile('/src.txt', 'new content');
      await adapter.writeFile('/dst.txt', 'old content');
      const dstAbs = path.join(tmpDir, projectId, 'dst.txt');
      const inoBefore = fs.statSync(dstAbs).ino;

      await adapter.copyFile('/src.txt', '/dst.txt', true);

      expect(await adapter.readFile('/dst.txt')).toBe('new content');
      expect(fs.statSync(dstAbs).ino).toBe(inoBefore);
      const fileId = await adapter.getFileId('/dst.txt');
      expect((await adapter.listVersions(fileId!)).length).toBe(2);
    });

    it('does not mirror the source mode onto an existing destination', async () => {
      await adapter.writeFile('/src.txt', 'x');
      await adapter.writeFile('/dst.txt', 'y');
      const srcAbs = path.join(tmpDir, projectId, 'src.txt');
      const dstAbs = path.join(tmpDir, projectId, 'dst.txt');
      fs.chmodSync(srcAbs, 0o600);
      fs.chmodSync(dstAbs, 0o664);

      await adapter.copyFile('/src.txt', '/dst.txt', true);

      expect(fs.statSync(dstAbs).mode & 0o777).toBe(0o664);
    });
  });

  describe('node error translation', () => {
    it('readFile on a directory throws NOT_A_FILE', async () => {
      await adapter.mkdir('/dir');
      await expect(adapter.readFile('/dir')).rejects.toMatchObject({
        name: 'VfsError',
        code: 'NOT_A_FILE',
      });
      await expect(adapter.readFileWithMeta('/dir')).rejects.toMatchObject({
        code: 'NOT_A_FILE',
      });
    });

    it('readFile on a missing path throws PATH_NOT_FOUND without the host path', async () => {
      const err = await adapter.readFile('/missing.txt').catch(e => e);
      expect(err).toBeInstanceOf(VfsError);
      expect(err.code).toBe('PATH_NOT_FOUND');
      expect(err.message).not.toContain(tmpDir);
    });

    it('stat on a missing path throws PATH_NOT_FOUND', async () => {
      await expect(adapter.stat('/missing.txt')).rejects.toMatchObject({
        code: 'PATH_NOT_FOUND',
      });
    });

    it('strReplace and insert on a directory throw NOT_A_FILE', async () => {
      await adapter.mkdir('/dir');
      await expect(adapter.strReplace('/dir', 'a', 'b')).rejects.toMatchObject({
        code: 'NOT_A_FILE',
      });
      await expect(adapter.insert('/dir', 1, 'x')).rejects.toMatchObject({
        code: 'NOT_A_FILE',
      });
    });

    it('deleteFile on a missing path throws PATH_NOT_FOUND', async () => {
      await expect(adapter.deleteFile('/missing.txt')).rejects.toMatchObject({
        code: 'PATH_NOT_FOUND',
      });
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

    it('should report PATH_NOT_FOUND for a nonexistent path', async () => {
      await expect(adapter.deletePath('/nope')).rejects.toMatchObject({ code: 'PATH_NOT_FOUND' });
    });
  });

  describe('deletePaths', () => {
    it('deletes a mixed batch and reports per-path errors', async () => {
      await adapter.writeFile('/a.txt', 'a');
      await adapter.writeFile('/dir/b.txt', 'b');
      await adapter.writeFile('/c.txt', 'c');

      const results = await adapter.deletePaths(['/a.txt', '/dir', '/nope', '/c.txt'], false);

      expect(results.map(r => r.error?.code)).toEqual([
        undefined,
        'NOT_A_FILE',
        'PATH_NOT_FOUND',
        undefined,
      ]);
      expect(await adapter.exists('/a.txt')).toBe(false);
      expect(await adapter.exists('/dir/b.txt')).toBe(true);
      expect(await adapter.exists('/c.txt')).toBe(false);
    });

    it('deletes directories when recursive, nested entries included', async () => {
      await adapter.writeFile('/dir/sub/b.txt', 'b');
      const results = await adapter.deletePaths(['/dir/sub/b.txt', '/dir'], true);
      expect(results.every(r => !r.error)).toBe(true);
      expect(await adapter.exists('/dir')).toBe(false);
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
    it('does not create the project root just to answer hasVfs', async () => {
      expect(await adapter.hasVfs()).toBe(false);
      expect(fs.existsSync(path.join(tmpDir, projectId))).toBe(false);
    });

    it('recreates the root on the next op after clearVfs', async () => {
      await adapter.writeFile('/f.txt', 'data');
      await adapter.clearVfs();
      expect(await adapter.readDir('/')).toEqual([]);
    });

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
  // Symlink policy
  // --------------------------------------------------------------------------

  describe('symlinks (follow=false, default)', () => {
    let outside: string;
    beforeEach(async () => {
      outside = fs.mkdtempSync(path.join(os.tmpdir(), 'fsvfs-outside-'));
      const projectRoot = path.join(tmpDir, projectId);
      // Write through the adapter to ensure project dir exists, then plant symlinks.
      await adapter.writeFile('/real.txt', 'real');
      fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
      fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(projectRoot, 'link.txt'));
    });

    afterEach(() => {
      fs.rmSync(outside, { recursive: true, force: true });
    });

    it('readFile rejects symlink', async () => {
      await expect(adapter.readFile('/link.txt')).rejects.toMatchObject({
        name: 'VfsError',
        code: 'INVALID_PATH',
      });
    });

    it('stat rejects symlink', async () => {
      await expect(adapter.stat('/link.txt')).rejects.toMatchObject({ code: 'INVALID_PATH' });
    });

    it('readDir omits the symlink', async () => {
      const entries = await adapter.readDir('/');
      const names = entries.map(e => e.name);
      expect(names).toContain('real.txt');
      expect(names).not.toContain('link.txt');
    });
  });

  describe('symlinks (follow=true with allow-list)', () => {
    let extra: string;
    let altAdapter: FilesystemVfsAdapter;

    beforeEach(async () => {
      extra = fs.mkdtempSync(path.join(os.tmpdir(), 'fsvfs-extra-'));
      fs.writeFileSync(path.join(extra, 'shared.txt'), 'shared');
      const accessConfig: VfsAccessConfig = {
        followSymlinks: true,
        globalAllowedRoots: [fs.realpathSync(extra)],
        projectAllowedRoots: new Map(),
      };
      altAdapter = new FilesystemVfsAdapter(tmpDir, projectId, accessConfig);
      // The project root is created on the first adapter call.
      await altAdapter.exists('/');
      const projectRoot = path.join(tmpDir, projectId);
      fs.symlinkSync(path.join(extra, 'shared.txt'), path.join(projectRoot, 'link.txt'));
    });

    afterEach(() => {
      fs.rmSync(extra, { recursive: true, force: true });
    });

    it('readFile follows the symlink', async () => {
      expect(await altAdapter.readFile('/link.txt')).toBe('shared');
    });

    it('readDir lists the symlink entry', async () => {
      const entries = await altAdapter.readDir('/');
      expect(entries.map(e => e.name)).toContain('link.txt');
    });
  });

  describe('symlinks (follow=true, target not in allow-list)', () => {
    let outside: string;
    let altAdapter: FilesystemVfsAdapter;

    beforeEach(async () => {
      outside = fs.mkdtempSync(path.join(os.tmpdir(), 'fsvfs-outside2-'));
      fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
      const accessConfig: VfsAccessConfig = {
        followSymlinks: true,
        globalAllowedRoots: [], // outside is NOT in the allow-list
        projectAllowedRoots: new Map(),
      };
      altAdapter = new FilesystemVfsAdapter(tmpDir, projectId, accessConfig);
      await altAdapter.exists('/');
      const projectRoot = path.join(tmpDir, projectId);
      fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(projectRoot, 'link.txt'));
    });

    afterEach(() => {
      fs.rmSync(outside, { recursive: true, force: true });
    });

    it('readFile rejects with INVALID_PATH', async () => {
      await expect(altAdapter.readFile('/link.txt')).rejects.toMatchObject({
        code: 'INVALID_PATH',
        message: expect.stringContaining('outside allowed roots'),
      });
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

    it('should round-trip high-unicode text (emoji, CJK, BOM, astral plane)', async () => {
      const unicodeText = '你好 🎉 \uFEFFHello\n𐍈\u{1F600}';
      await adapter.writeFile('/unicode.txt', unicodeText);

      const result = await adapter.readFileWithMeta('/unicode.txt');
      expect(result.content).toBe(unicodeText);
      expect(result.isBinary).toBe(false);
      expect(result.mime).toBe('text/plain');

      // Verify on disk bytes are correct UTF-8.
      const absPath = path.join(tmpDir, projectId, 'unicode.txt');
      const onDisk = fs.readFileSync(absPath);
      expect(onDisk.toString('utf-8')).toBe(unicodeText);
    });

    it('should detect binary file and return buffer + mime', async () => {
      // Minimal PNG (magic header + IEND chunk). Not valid PNG but has a binary signature.
      const pngBytes = new Uint8Array([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
        0x44, 0xae, 0x42, 0x60, 0x82,
      ]);
      await adapter.writeFile('/pic.png', pngBytes);

      const result = await adapter.readFileWithMeta('/pic.png');
      expect(result.isBinary).toBe(true);
      expect(result.mime).toBe('image/png');
      expect(result.buffer).toBeDefined();
      expect(new Uint8Array(result.buffer!)).toEqual(pngBytes);

      // content is base64 of the original bytes
      expect(result.content).toBe(Buffer.from(pngBytes).toString('base64'));
    });
  });

  describe('readFile', () => {
    it('should throw BINARY_FILE when reading a binary file as text', async () => {
      const pngBytes = new Uint8Array([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
        0x44, 0xae, 0x42, 0x60, 0x82,
      ]);
      await adapter.writeFile('/pic.png', pngBytes);

      await expect(adapter.readFile('/pic.png')).rejects.toThrow(VfsError);
      await expect(adapter.readFile('/pic.png')).rejects.toMatchObject({ code: 'BINARY_FILE' });
    });

    it('should round-trip high-unicode text through readFile', async () => {
      const unicodeText = '你好 🎉 \uFEFFHello\n𐍈\u{1F600}';
      await adapter.writeFile('/u.txt', unicodeText);
      expect(await adapter.readFile('/u.txt')).toBe(unicodeText);
    });
  });

  describe('writeFile binary', () => {
    it('should preserve bytes when writing Uint8Array', async () => {
      const bytes = new Uint8Array([0x00, 0x01, 0xfe, 0xff, 0x7f, 0x80]);
      await adapter.writeFile('/raw.bin', bytes);

      const onDisk = fs.readFileSync(path.join(tmpDir, projectId, 'raw.bin'));
      expect(new Uint8Array(onDisk)).toEqual(bytes);
    });

    it('should preserve bytes when writing ArrayBuffer', async () => {
      const bytes = new Uint8Array([0x00, 0x01, 0xfe, 0xff, 0x7f, 0x80]);
      await adapter.writeFile('/raw.bin', bytes.buffer);

      const onDisk = fs.readFileSync(path.join(tmpDir, projectId, 'raw.bin'));
      expect(new Uint8Array(onDisk)).toEqual(bytes);
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

    it('should decode base64 when writing binary version history', async () => {
      const v1 = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);
      const v2 = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x02]);
      const current = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x03]);

      await adapter.writeFileWithHistory(
        '/pic.png',
        [
          { content: Buffer.from(v1).toString('base64'), createdAt: 1000 },
          { content: Buffer.from(v2).toString('base64'), createdAt: 2000 },
        ],
        current,
        true
      );

      // Version files on disk should contain the original bytes, not base64 text.
      const verPath = (n: number) => path.join(tmpDir, projectId, '.pic.png.ver', String(n));
      expect(new Uint8Array(fs.readFileSync(verPath(1)))).toEqual(v1);
      expect(new Uint8Array(fs.readFileSync(verPath(2)))).toEqual(v2);

      // getVersion should return base64 to match the vfsService contract.
      expect(await adapter.getVersion('/pic.png', 1)).toBe(Buffer.from(v1).toString('base64'));
      expect(await adapter.getVersion('/pic.png', 2)).toBe(Buffer.from(v2).toString('base64'));
      expect(await adapter.getVersion('/pic.png', 3)).toBe(Buffer.from(current).toString('base64'));
    });
  });
});
