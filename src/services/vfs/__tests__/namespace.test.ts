import { describe, it, expect } from 'vitest';
import { resolveNamespacedPath } from '../vfsService';

describe('resolveNamespacedPath', () => {
  it('returns normalized path when no namespace', () => {
    expect(resolveNamespacedPath('/memories/note.md')).toBe('/memories/note.md');
    expect(resolveNamespacedPath('file.txt')).toBe('/file.txt');
    expect(resolveNamespacedPath('/')).toBe('/');
  });

  it('prefixes path with namespace', () => {
    expect(resolveNamespacedPath('/memories/note.md', '/minions/code')).toBe(
      '/minions/code/memories/note.md'
    );
    expect(resolveNamespacedPath('/data.json', '/minions/researcher')).toBe(
      '/minions/researcher/data.json'
    );
  });

  it('bypasses namespace for /share paths', () => {
    expect(resolveNamespacedPath('/share/data.json', '/minions/code')).toBe('/share/data.json');
    expect(resolveNamespacedPath('/share', '/minions/code')).toBe('/share');
    expect(resolveNamespacedPath('/share/nested/file.txt', '/minions/code')).toBe(
      '/share/nested/file.txt'
    );
  });

  it('normalizes path traversal in path', () => {
    // normalizePath strips ".." segments
    expect(resolveNamespacedPath('../../etc/passwd', '/minions/code')).toBe(
      '/minions/code/etc/passwd'
    );
    expect(resolveNamespacedPath('/a/../b', '/minions/code')).toBe('/minions/code/b');
  });

  it('normalizes path traversal in namespace', () => {
    expect(resolveNamespacedPath('/file.txt', '/../escape')).toBe('/escape/file.txt');
    expect(resolveNamespacedPath('/file.txt', '/a/../b')).toBe('/b/file.txt');
  });

  it('handles root path with namespace', () => {
    expect(resolveNamespacedPath('/', '/minions/code')).toBe('/minions/code');
  });

  it('handles root namespace', () => {
    expect(resolveNamespacedPath('/file.txt', '/')).toBe('/file.txt');
  });

  it('handles nested namespaces', () => {
    expect(resolveNamespacedPath('/memories/README.md', '/minions/deep/nest')).toBe(
      '/minions/deep/nest/memories/README.md'
    );
  });

  it('handles empty and whitespace paths', () => {
    expect(resolveNamespacedPath('', '/minions/code')).toBe('/minions/code');
    expect(resolveNamespacedPath('  ', '/minions/code')).toBe('/minions/code');
  });

  it('does not treat /sharing or /shared as /share bypass', () => {
    expect(resolveNamespacedPath('/sharing/file.txt', '/minions/code')).toBe(
      '/minions/code/sharing/file.txt'
    );
    expect(resolveNamespacedPath('/shared/file.txt', '/minions/code')).toBe(
      '/minions/code/shared/file.txt'
    );
  });
});
