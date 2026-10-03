import { describe, it, expect } from 'vitest';
import { hookFilePath, hookNameFromPath, hooksDir } from '../dummyHook';

describe('dummyHook paths', () => {
  it('puts hooks under /hooks, inside the namespace when there is one', () => {
    expect(hooksDir()).toBe('/hooks');
    expect(hooksDir('')).toBe('/hooks');
    expect(hooksDir('/minions/coder')).toBe('/minions/coder/hooks');
    expect(hooksDir('minions/coder/')).toBe('/minions/coder/hooks');
  });

  it('builds the file path for a hook name', () => {
    expect(hookFilePath('example')).toBe('/hooks/example.js');
    expect(hookFilePath('a/b', '/ns')).toBe('/ns/hooks/a/b.js');
  });

  it('reads the hook name back from a file path', () => {
    expect(hookNameFromPath('/hooks/example.js')).toBe('example');
    expect(hookNameFromPath('/hooks/hook-chain.example.js')).toBe('hook-chain.example');
    expect(hookNameFromPath('/hooks/a/b.js')).toBe('a/b');
    expect(hookNameFromPath('/ns/hooks/example.js', '/ns')).toBe('example');
  });

  it('rejects files the runtime would not load', () => {
    expect(hookNameFromPath('/hooks/notes.md')).toBeNull();
    expect(hookNameFromPath('/scripts/example.js')).toBeNull();
    expect(hookNameFromPath('/hooks')).toBeNull();
    expect(hookNameFromPath('/hooks/.js')).toBeNull();
    // Outside the chat's namespace, even though it is a /hooks file
    expect(hookNameFromPath('/hooks/example.js', '/ns')).toBeNull();
  });
});
