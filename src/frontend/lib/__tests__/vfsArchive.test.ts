import { describe, expect, it, vi } from 'vitest';
import { strToU8, unzipSync } from 'fflate';
import type { DirEntry, VfsAdapter } from '../../../shared/protocol/types/vfs';
import {
  collectFolderFiles,
  decodeUtf8,
  importZip,
  planZipImport,
  readResultBytes,
  toFileContent,
  zipFiles,
} from '../vfsArchive';

const bytes = (text: string) => strToU8(text);
const BINARY = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe]);

const dirEntry = (name: string, type: 'file' | 'dir'): DirEntry => ({
  name,
  type,
  deleted: false,
  createdAt: 0,
  updatedAt: 0,
});

describe('decodeUtf8 / toFileContent', () => {
  it('returns text for UTF-8 and null for anything else', () => {
    expect(decodeUtf8(bytes('héllo'))).toBe('héllo');
    expect(decodeUtf8(new Uint8Array())).toBe('');
    expect(decodeUtf8(BINARY)).toBeNull();
  });

  it('hands writeFile a string for text and the bytes for binary', () => {
    expect(toFileContent(bytes('hi'))).toBe('hi');
    expect(toFileContent(BINARY)).toBe(BINARY);
  });

  it('decodes base64 content of binary read results', () => {
    const decoded = readResultBytes({ content: 'iVBO', isBinary: true, mime: 'image/png' });
    expect(Array.from(decoded)).toEqual([0x89, 0x50, 0x4e]);
    expect(
      Array.from(readResultBytes({ content: 'A', isBinary: false, mime: 'text/plain' }))
    ).toEqual([65]);
  });
});

describe('planZipImport', () => {
  it('strips one shared top-level folder', () => {
    const plan = planZipImport({
      'notes/': new Uint8Array(),
      'notes/a.md': bytes('a'),
      'notes/sub/b.md': bytes('b'),
    });
    expect(plan.files.map(f => f.path)).toEqual(['a.md', 'sub/b.md']);
    expect(plan.emptyDirs).toEqual([]);
  });

  it('keeps the top level when files sit at the archive root', () => {
    const plan = planZipImport({ 'a.md': bytes('a'), 'notes/b.md': bytes('b') });
    expect(plan.files.map(f => f.path)).toEqual(['a.md', 'notes/b.md']);
  });

  it('drops Finder and Windows junk before looking for the shared folder', () => {
    const plan = planZipImport({
      'notes/a.md': bytes('a'),
      '__MACOSX/notes/._a.md': bytes('x'),
      'notes/.DS_Store': bytes('x'),
      'notes/._b.md': bytes('x'),
      'notes/Thumbs.db': bytes('x'),
    });
    expect(plan.files.map(f => f.path)).toEqual(['a.md']);
    expect(plan.skipped).toEqual([]);
  });

  it('refuses entries that point outside the target', () => {
    const plan = planZipImport({
      '../evil.md': bytes('x'),
      'a/../../evil.md': bytes('x'),
      '/abs.md': bytes('x'),
      'C:\\win.md': bytes('x'),
      'ok.md': bytes('ok'),
    });
    expect(plan.files.map(f => f.path)).toEqual(['ok.md']);
    expect(plan.skipped).toEqual(['../evil.md', 'a/../../evil.md', '/abs.md', 'C:\\win.md']);
  });

  it('only lists directories that no file creates', () => {
    const plan = planZipImport({
      'root/full/': new Uint8Array(),
      'root/full/a.md': bytes('a'),
      'root/empty/': new Uint8Array(),
      'root/empty/nested/': new Uint8Array(),
    });
    expect(plan.files.map(f => f.path)).toEqual(['full/a.md']);
    expect(plan.emptyDirs).toEqual(['empty', 'empty/nested']);
  });
});

describe('importZip', () => {
  it('writes text and binary files, reports progress and keeps going after a failure', async () => {
    const adapter = {
      mkdir: vi.fn().mockResolvedValue(undefined),
      writeFile: vi.fn(async (path: string) => {
        if (path.endsWith('bad.md')) throw new Error('disk full');
      }),
    } as unknown as VfsAdapter;
    const onProgress = vi.fn();

    const result = await importZip(
      adapter,
      '/target',
      {
        files: [
          { path: 'a.md', bytes: bytes('a') },
          { path: 'bad.md', bytes: bytes('b') },
          { path: 'img/x.png', bytes: BINARY },
        ],
        emptyDirs: ['empty'],
        skipped: [],
      },
      onProgress
    );

    expect(adapter.mkdir).toHaveBeenCalledExactlyOnceWith('/target/empty', { recursive: true });
    expect(adapter.writeFile).toHaveBeenCalledWith('/target/a.md', 'a');
    expect(adapter.writeFile).toHaveBeenCalledWith('/target/img/x.png', BINARY);
    expect(result).toEqual({
      written: 2,
      failed: [{ path: '/target/bad.md', message: 'disk full' }],
    });
    expect(onProgress).toHaveBeenLastCalledWith(3, 3);
  });
});

describe('collectFolderFiles + zipFiles', () => {
  it('round-trips a nested folder with a binary file', async () => {
    const listings: Record<string, DirEntry[]> = {
      '/docs': [dirEntry('a.md', 'file'), dirEntry('img', 'dir')],
      '/docs/img': [dirEntry('x.png', 'file')],
    };
    const reads: Record<string, { content: string; isBinary: boolean; mime: string }> = {
      '/docs/a.md': { content: 'hello', isBinary: false, mime: 'text/plain' },
      '/docs/img/x.png': { content: 'iVBOR//+', isBinary: true, mime: 'image/png' },
    };
    const adapter = {
      readDir: vi.fn(async (path: string) => listings[path]),
      readFileWithMeta: vi.fn(async (path: string) => reads[path]),
    } as unknown as VfsAdapter;
    const onProgress = vi.fn();

    const files = await collectFolderFiles(adapter, '/docs', onProgress);
    expect(Object.keys(files).sort()).toEqual(['a.md', 'img/x.png']);
    expect(onProgress).toHaveBeenLastCalledWith(2, 2);

    const unzipped = unzipSync(await zipFiles(files));
    expect(new TextDecoder().decode(unzipped['a.md'])).toBe('hello');
    expect(Array.from(unzipped['img/x.png'])).toEqual(Array.from(BINARY));
  });
});
