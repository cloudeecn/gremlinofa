import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as engine from '../fsEngine.js';
import type { VfsContext } from '../fsEngine.js';

function makeCtx(opts: {
  projectRoot: string;
  extraRoots?: string[];
  followSymlinks?: boolean;
}): VfsContext {
  return {
    projectRoot: fs.realpathSync(opts.projectRoot),
    allowedRoots: [
      fs.realpathSync(opts.projectRoot),
      ...(opts.extraRoots ?? []).map(r => fs.realpathSync(r)),
    ],
    followSymlinks: opts.followSymlinks ?? false,
  };
}

describe('fsEngine path resolution + symlink policy', () => {
  let tmpDir: string;
  let projectRoot: string;
  let extraRoot: string;
  let outsideDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsengine-test-'));
    projectRoot = path.join(tmpDir, 'proj');
    extraRoot = path.join(tmpDir, 'extra');
    outsideDir = path.join(tmpDir, 'outside');
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.mkdirSync(extraRoot, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('lexical containment', () => {
    it('rejects .. traversal', async () => {
      const ctx = makeCtx({ projectRoot });
      await expect(engine.read(ctx, '/../../etc/passwd')).rejects.toMatchObject({ status: 403 });
    });

    it('rejects null byte', async () => {
      const ctx = makeCtx({ projectRoot });
      await expect(engine.read(ctx, '/a\0b')).rejects.toMatchObject({ status: 403 });
    });
  });

  describe('symlink file, follow=false', () => {
    beforeEach(() => {
      fs.writeFileSync(path.join(extraRoot, 'target.txt'), 'secret');
      fs.symlinkSync(path.join(extraRoot, 'target.txt'), path.join(projectRoot, 'link.txt'));
    });

    it('read rejects with 403', async () => {
      const ctx = makeCtx({ projectRoot });
      await expect(engine.read(ctx, '/link.txt')).rejects.toMatchObject({
        status: 403,
        message: expect.stringContaining('Symlink encountered'),
      });
    });

    it('stat rejects with 403', async () => {
      const ctx = makeCtx({ projectRoot });
      await expect(engine.stat(ctx, '/link.txt')).rejects.toMatchObject({ status: 403 });
    });

    it('ls omits the symlink entry', async () => {
      const ctx = makeCtx({ projectRoot });
      const entries = await engine.ls(ctx, '/');
      expect(entries.map(e => e.name)).not.toContain('link.txt');
    });
  });

  describe('symlink dir, follow=false', () => {
    beforeEach(() => {
      fs.writeFileSync(path.join(extraRoot, 'inner.txt'), 'hi');
      fs.symlinkSync(extraRoot, path.join(projectRoot, 'linkdir'));
    });

    it('ls omits the linked dir', async () => {
      const ctx = makeCtx({ projectRoot });
      const entries = await engine.ls(ctx, '/');
      expect(entries.map(e => e.name)).not.toContain('linkdir');
    });

    it('read through the linked dir rejects', async () => {
      const ctx = makeCtx({ projectRoot });
      await expect(engine.read(ctx, '/linkdir/inner.txt')).rejects.toMatchObject({ status: 403 });
    });
  });

  describe('symlink, follow=true, target inside project root', () => {
    it('read returns content', async () => {
      fs.writeFileSync(path.join(projectRoot, 'real.txt'), 'within');
      fs.symlinkSync(path.join(projectRoot, 'real.txt'), path.join(projectRoot, 'link.txt'));
      const ctx = makeCtx({ projectRoot, followSymlinks: true });
      const buf = await engine.read(ctx, '/link.txt');
      expect(buf.toString()).toBe('within');
    });
  });

  describe('symlink, follow=true, target outside allow-list', () => {
    it('rejects with Path outside allowed roots', async () => {
      fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'nope');
      fs.symlinkSync(path.join(outsideDir, 'secret.txt'), path.join(projectRoot, 'link.txt'));
      const ctx = makeCtx({ projectRoot, followSymlinks: true });
      await expect(engine.read(ctx, '/link.txt')).rejects.toMatchObject({
        status: 403,
        message: expect.stringContaining('Path outside allowed roots'),
      });
    });
  });

  describe('symlink, follow=true, target inside global extra root', () => {
    it('read returns content', async () => {
      fs.writeFileSync(path.join(extraRoot, 'target.txt'), 'shared');
      fs.symlinkSync(path.join(extraRoot, 'target.txt'), path.join(projectRoot, 'link.txt'));
      const ctx = makeCtx({ projectRoot, extraRoots: [extraRoot], followSymlinks: true });
      const buf = await engine.read(ctx, '/link.txt');
      expect(buf.toString()).toBe('shared');
    });
  });

  describe('symlink, follow=true, target inside project-scoped extra root', () => {
    it('works when ctx includes the scoped root', async () => {
      fs.writeFileSync(path.join(extraRoot, 'target.txt'), 'scoped');
      fs.symlinkSync(path.join(extraRoot, 'target.txt'), path.join(projectRoot, 'link.txt'));
      // Simulating: getAllowedRootsForProject would have added extraRoot for this project.
      const ctx = makeCtx({ projectRoot, extraRoots: [extraRoot], followSymlinks: true });
      const buf = await engine.read(ctx, '/link.txt');
      expect(buf.toString()).toBe('scoped');
    });

    it('rejects when ctx omits the scoped root (i.e. different project)', async () => {
      fs.writeFileSync(path.join(extraRoot, 'target.txt'), 'private');
      fs.symlinkSync(path.join(extraRoot, 'target.txt'), path.join(projectRoot, 'link.txt'));
      const ctx = makeCtx({ projectRoot, followSymlinks: true });
      await expect(engine.read(ctx, '/link.txt')).rejects.toMatchObject({ status: 403 });
    });
  });

  describe('write into an extra root with missing parent dirs', () => {
    it('forWrite walks ancestors, mkdirs inside extra root, succeeds', async () => {
      fs.symlinkSync(extraRoot, path.join(projectRoot, 'mount'));
      const ctx = makeCtx({ projectRoot, extraRoots: [extraRoot], followSymlinks: true });
      await engine.write(ctx, '/mount/nested/new.txt', Buffer.from('hello'), false);
      const onDisk = fs.readFileSync(path.join(extraRoot, 'nested', 'new.txt'), 'utf-8');
      expect(onDisk).toBe('hello');
    });
  });

  describe('regression — non-symlink paths still work', () => {
    it('ls + read on plain files', async () => {
      const ctx = makeCtx({ projectRoot });
      await engine.write(ctx, '/a.txt', Buffer.from('x'), false);
      await engine.write(ctx, '/b.txt', Buffer.from('y'), false);
      const entries = await engine.ls(ctx, '/');
      expect(entries.map(e => e.name).sort()).toEqual(['a.txt', 'b.txt']);
      expect((await engine.read(ctx, '/a.txt')).toString()).toBe('x');
    });
  });
});

describe('loadVfsAccessConfig', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'accesscfg-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('defaults: follow=false, empty allow-lists', async () => {
    const { loadVfsAccessConfig } = await import('../accessConfig.js');
    const cfg = loadVfsAccessConfig({});
    expect(cfg.followSymlinks).toBe(false);
    expect(cfg.globalAllowedRoots).toEqual([]);
    expect(cfg.projectAllowedRoots.size).toBe(0);
  });

  it('parses follow=true', async () => {
    const { loadVfsAccessConfig } = await import('../accessConfig.js');
    expect(loadVfsAccessConfig({ VFS_FOLLOW_SYMLINKS: 'true' }).followSymlinks).toBe(true);
    expect(loadVfsAccessConfig({ VFS_FOLLOW_SYMLINKS: '1' }).followSymlinks).toBe(true);
    expect(loadVfsAccessConfig({ VFS_FOLLOW_SYMLINKS: 'yes' }).followSymlinks).toBe(true);
    expect(loadVfsAccessConfig({ VFS_FOLLOW_SYMLINKS: 'false' }).followSymlinks).toBe(false);
  });

  it('parses global + project-scoped roots', async () => {
    const { loadVfsAccessConfig } = await import('../accessConfig.js');
    const globalA = path.join(tmpDir, 'globalA');
    const globalB = path.join(tmpDir, 'globalB');
    const scoped = path.join(tmpDir, 'scoped');
    fs.mkdirSync(globalA);
    fs.mkdirSync(globalB);
    fs.mkdirSync(scoped);

    const cfg = loadVfsAccessConfig({
      VFS_EXTRA_ROOTS: `${globalA}:projA|${scoped}:${globalB}`,
    });
    expect(cfg.globalAllowedRoots).toEqual([fs.realpathSync(globalA), fs.realpathSync(globalB)]);
    expect(cfg.projectAllowedRoots.get('projA')).toEqual([fs.realpathSync(scoped)]);
  });

  it('rejects non-existent path', async () => {
    const { loadVfsAccessConfig } = await import('../accessConfig.js');
    expect(() => loadVfsAccessConfig({ VFS_EXTRA_ROOTS: '/this/does/not/exist' })).toThrow(
      /Invalid VFS_EXTRA_ROOTS/
    );
  });

  it('rejects non-absolute path', async () => {
    const { loadVfsAccessConfig } = await import('../accessConfig.js');
    expect(() => loadVfsAccessConfig({ VFS_EXTRA_ROOTS: 'relative/path' })).toThrow(
      /must be absolute/
    );
  });

  it('rejects malformed projectId', async () => {
    const { loadVfsAccessConfig } = await import('../accessConfig.js');
    expect(() => loadVfsAccessConfig({ VFS_EXTRA_ROOTS: `bad-project!|${tmpDir}` })).toThrow(
      /projectId/
    );
  });
});

describe('getAllowedRootsForProject', () => {
  it('returns project root + globals + scoped, deduped', async () => {
    const { getAllowedRootsForProject } = await import('../accessConfig.js');
    const cfg = {
      followSymlinks: false,
      globalAllowedRoots: ['/g1', '/g2'],
      projectAllowedRoots: new Map([['projA', ['/p1', '/g1']]]),
    };
    const roots = getAllowedRootsForProject(cfg, 'projA', '/proj/root');
    expect(roots).toEqual(['/proj/root', '/g1', '/g2', '/p1']);
  });

  it('only project root + globals for unscoped project', async () => {
    const { getAllowedRootsForProject } = await import('../accessConfig.js');
    const cfg = {
      followSymlinks: false,
      globalAllowedRoots: ['/g1'],
      projectAllowedRoots: new Map([['other', ['/p1']]]),
    };
    expect(getAllowedRootsForProject(cfg, 'projA', '/proj/root')).toEqual(['/proj/root', '/g1']);
  });
});
