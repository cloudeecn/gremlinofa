import { describe, expect, it } from 'vitest';
import {
  ancestors,
  basename,
  dirname,
  isWithin,
  joinPath,
  normalizePath,
  resolveLink,
  validateEntryName,
  vfsUrl,
} from '../vfsPath';

describe('vfsPath', () => {
  it('splits paths', () => {
    expect(basename('/a/b.md')).toBe('b.md');
    expect(basename('/')).toBe('');
    expect(dirname('/a/b.md')).toBe('/a');
    expect(dirname('/a')).toBe('/');
    expect(dirname('/')).toBe('/');
  });

  it('normalizes a URL splat into an absolute path', () => {
    expect(normalizePath('')).toBe('/');
    expect(normalizePath('docs/')).toBe('/docs');
    expect(normalizePath('docs//a')).toBe('/docs/a');
  });

  it('joins at the root and below it', () => {
    expect(joinPath('/', 'x')).toBe('/x');
    expect(joinPath('/a', 'x')).toBe('/a/x');
  });

  it('lists strict ancestors root first', () => {
    expect(ancestors('/a/b/c')).toEqual(['/', '/a', '/a/b']);
    expect(ancestors('/a')).toEqual(['/']);
    expect(ancestors('/')).toEqual([]);
  });

  it('tells whether a path is inside a directory', () => {
    expect(isWithin('/a/b', '/a')).toBe(true);
    expect(isWithin('/a', '/a')).toBe(true);
    expect(isWithin('/ab', '/a')).toBe(false);
    expect(isWithin('/anything', '/')).toBe(true);
  });

  it('builds routes with each segment encoded', () => {
    expect(vfsUrl('p1', '/')).toBe('/project/p1/vfs');
    expect(vfsUrl('p1', '/my notes/a#1 %.md')).toBe('/project/p1/vfs/my%20notes/a%231%20%25.md');
  });

  it('resolves links in a rendered file against its folder', () => {
    expect(resolveLink('/notes', 'todo.md')).toBe('/notes/todo.md');
    expect(resolveLink('/notes', './a/../b.md')).toBe('/notes/b.md');
    expect(resolveLink('/notes', '../../../up.md')).toBe('/up.md');
    expect(resolveLink('/notes', '/memories/x.md')).toBe('/memories/x.md');
    expect(resolveLink('/', 'my%20notes%20%231.md')).toBe('/my notes #1.md');
    expect(resolveLink('/notes', 'todo.md?v=2#done')).toBe('/notes/todo.md');
    expect(resolveLink('/notes', '100%.md')).toBe('/notes/100%.md');
  });

  it('leaves links with a scheme or a host to the browser', () => {
    expect(resolveLink('/', 'https://example.com/a.md')).toBeNull();
    expect(resolveLink('/', 'mailto:me@example.com')).toBeNull();
    expect(resolveLink('/', '//example.com/a.md')).toBeNull();
  });

  it('validates new entry names', () => {
    expect(validateEntryName('  notes.md ')).toBeNull();
    expect(validateEntryName('   ')).toMatch(/name/);
    expect(validateEntryName('a/b')).toMatch(/“\/”/);
    expect(validateEntryName('..')).toMatch(/reserved/);
  });
});
