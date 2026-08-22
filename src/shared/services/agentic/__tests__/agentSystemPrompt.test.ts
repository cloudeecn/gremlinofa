import { describe, it, expect, vi } from 'vitest';
import type { VfsAdapter } from '../../vfs/vfsAdapter';
import {
  AgentPromptError,
  DEFAULT_PRE_PERSONA_FILE,
  MINION_VFS_ROOT,
  personaNamespace,
  personaPromptPath,
  resolveAgentSystemPrompt,
} from '../agentSystemPrompt';

/**
 * Factory over a fixed `path -> content` map. Paths absent from the map throw,
 * standing in for a VFS miss. `factory.mock.calls.length` is asserted in one
 * test: the resolver promises exactly one adapter per resolution.
 */
function makeVfs(files: Record<string, string>) {
  const readFile = vi.fn(async (path: string) => {
    if (!(path in files)) throw new Error(`ENOENT: ${path}`);
    return files[path];
  });
  const factory = vi.fn((_ns?: string) => ({ readFile }) as unknown as VfsAdapter);
  return { factory, readFile };
}

describe('path helpers', () => {
  it('derives persona file and namespace from the root', () => {
    expect(MINION_VFS_ROOT).toBe('/minions');
    expect(personaPromptPath('researcher')).toBe('/minions/researcher.md');
    expect(personaNamespace('researcher')).toBe('/minions/researcher');
    expect(DEFAULT_PRE_PERSONA_FILE).toBe('/minions/_global.md');
  });
});

describe('resolveAgentSystemPrompt — segment order and joining', () => {
  it('joins pre-persona, persona, inline and files in order with blank lines', async () => {
    const { factory } = makeVfs({
      [DEFAULT_PRE_PERSONA_FILE]: 'GLOBAL',
      '/minions/researcher.md': 'PERSONA',
      '/a.md': 'FILE_A',
      '/b.md': 'FILE_B',
    });

    const text = await resolveAgentSystemPrompt({
      createVfsAdapter: factory,
      persona: 'researcher',
      inlineSegments: ['INLINE_1', 'INLINE_2'],
      promptFiles: ['/a.md', '/b.md'],
    });

    expect(text).toBe('GLOBAL\n\nPERSONA\n\nINLINE_1\n\nINLINE_2\n\nFILE_A\n\nFILE_B');
  });

  it('drops empty segments instead of emitting blank separators', async () => {
    const { factory } = makeVfs({
      [DEFAULT_PRE_PERSONA_FILE]: '',
      '/minions/p.md': 'PERSONA',
      '/empty.md': '',
    });

    const text = await resolveAgentSystemPrompt({
      createVfsAdapter: factory,
      persona: 'p',
      inlineSegments: ['', undefined, 'INLINE'],
      promptFiles: ['/empty.md'],
    });

    expect(text).toBe('PERSONA\n\nINLINE');
  });

  it('returns an empty string when nothing resolves', async () => {
    const { factory } = makeVfs({});
    await expect(resolveAgentSystemPrompt({ createVfsAdapter: factory })).resolves.toBe('');
  });

  it('creates exactly one adapter across all three phases', async () => {
    const { factory } = makeVfs({
      [DEFAULT_PRE_PERSONA_FILE]: 'G',
      '/minions/p.md': 'P',
      '/a.md': 'A',
      '/b.md': 'B',
    });

    await resolveAgentSystemPrompt({
      createVfsAdapter: factory,
      persona: 'p',
      promptFiles: ['/a.md', '/b.md'],
    });

    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledWith();
  });
});

describe('resolveAgentSystemPrompt — pre-persona matrix', () => {
  it("undefined with the default file missing resolves to ''", async () => {
    const { factory } = makeVfs({});
    await expect(resolveAgentSystemPrompt({ createVfsAdapter: factory })).resolves.toBe('');
  });

  it("'' skips the read entirely", async () => {
    const { factory, readFile } = makeVfs({ [DEFAULT_PRE_PERSONA_FILE]: 'GLOBAL' });

    const text = await resolveAgentSystemPrompt({
      createVfsAdapter: factory,
      prePersonaFile: '',
      inlineSegments: ['INLINE'],
    });

    expect(text).toBe('INLINE');
    expect(readFile).not.toHaveBeenCalled();
  });

  it('a missing custom path throws a typed error carrying the path and cause', async () => {
    const { factory } = makeVfs({});

    const err = await resolveAgentSystemPrompt({
      createVfsAdapter: factory,
      prePersonaFile: '/custom/global.md',
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AgentPromptError);
    expect((err as AgentPromptError).kind).toBe('pre_persona_read_failed');
    expect((err as AgentPromptError).path).toBe('/custom/global.md');
    expect((err as AgentPromptError).detail).toBe('ENOENT: /custom/global.md');
  });

  it('an explicitly passed default path is still optional', async () => {
    // The comparison happens after the cascade, so passing the default path by
    // hand is indistinguishable from omitting it. Locked because the minion
    // tool has always behaved this way.
    const { factory } = makeVfs({});
    await expect(
      resolveAgentSystemPrompt({
        createVfsAdapter: factory,
        prePersonaFile: DEFAULT_PRE_PERSONA_FILE,
      })
    ).resolves.toBe('');
  });
});

describe('resolveAgentSystemPrompt — persona', () => {
  it('reads /minions/<persona>.md from the root namespace', async () => {
    const { factory, readFile } = makeVfs({ '/minions/researcher.md': 'PERSONA' });

    const text = await resolveAgentSystemPrompt({
      createVfsAdapter: factory,
      persona: 'researcher',
      prePersonaFile: '',
    });

    expect(text).toBe('PERSONA');
    expect(readFile).toHaveBeenCalledWith('/minions/researcher.md');
    // Root factory, never the persona's own namespace.
    expect(factory).toHaveBeenCalledWith();
  });

  it('throws persona_not_found with no cause detail', async () => {
    const { factory } = makeVfs({});

    const err = await resolveAgentSystemPrompt({
      createVfsAdapter: factory,
      persona: 'ghost',
      prePersonaFile: '',
    }).catch((e: unknown) => e);

    expect((err as AgentPromptError).kind).toBe('persona_not_found');
    expect((err as AgentPromptError).path).toBe('/minions/ghost.md');
    expect((err as AgentPromptError).detail).toBe('');
  });

  it('an empty persona name reads no persona file', async () => {
    const { factory, readFile } = makeVfs({});
    await expect(
      resolveAgentSystemPrompt({ createVfsAdapter: factory, persona: '', prePersonaFile: '' })
    ).resolves.toBe('');
    expect(readFile).not.toHaveBeenCalled();
  });
});

describe('resolveAgentSystemPrompt — prompt files', () => {
  it('accepts a single path as a string', async () => {
    const { factory } = makeVfs({ '/only.md': 'ONLY' });
    await expect(
      resolveAgentSystemPrompt({
        createVfsAdapter: factory,
        prePersonaFile: '',
        promptFiles: '/only.md',
      })
    ).resolves.toBe('ONLY');
  });

  it('reads an array in order', async () => {
    const { factory, readFile } = makeVfs({ '/1.md': 'ONE', '/2.md': 'TWO', '/3.md': 'THREE' });

    const text = await resolveAgentSystemPrompt({
      createVfsAdapter: factory,
      prePersonaFile: '',
      promptFiles: ['/3.md', '/1.md', '/2.md'],
    });

    expect(text).toBe('THREE\n\nONE\n\nTWO');
    expect(readFile.mock.calls.map(c => c[0])).toEqual(['/3.md', '/1.md', '/2.md']);
  });

  it('aborts on the first failure without reading later paths', async () => {
    const { factory, readFile } = makeVfs({ '/1.md': 'ONE', '/3.md': 'THREE' });

    const err = await resolveAgentSystemPrompt({
      createVfsAdapter: factory,
      prePersonaFile: '',
      promptFiles: ['/1.md', '/missing.md', '/3.md'],
    }).catch((e: unknown) => e);

    expect((err as AgentPromptError).kind).toBe('prompt_file_read_failed');
    expect((err as AgentPromptError).path).toBe('/missing.md');
    expect(readFile.mock.calls.map(c => c[0])).toEqual(['/1.md', '/missing.md']);
  });
});
