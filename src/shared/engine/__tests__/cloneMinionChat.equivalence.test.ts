/**
 * The test that proves the feature works.
 *
 * A clone is only faithful if it *is* the same agent — so the minion's prompt
 * and the clone's must come out byte-identical, not merely similar. Both paths
 * funnel into `resolveAgentSystemPrompt`, so the claim reduces to: the four
 * inputs `resolveMinionPromptInputs` builds for the minion and the ones
 * `deriveChatAgentConfigFromMinion` writes into `ChatAgentConfig` resolve to
 * the same string.
 *
 * Both sides call the real production functions — neither is transcribed here,
 * so a change to either that breaks the correspondence fails this test.
 *
 * Only the BASE prompts are compared: the tool sets legitimately differ (the
 * clone drops `return` and `minion`), so their appended tool prompts do too.
 */

import { describe, it, expect, vi } from 'vitest';
import type { MinionChat, Project, ToolOptions } from '../../protocol/types';
import type { VfsAdapter } from '../../services/vfs/vfsAdapter';
import { resolveAgentSystemPrompt } from '../../services/agentic/agentSystemPrompt';
import { resolveMinionPromptInputs } from '../../services/tools/minionTool';
import { createTestProject } from '../../services/storage/__tests__/testUtils';
import { deriveChatAgentConfigFromMinion } from '../cloneMinionChat';

const VFS_FILES: Record<string, string> = {
  '/minions/_global.md': 'GLOBAL PREAMBLE',
  '/minions/researcher.md': 'You are a research persona.',
  '/prompts/style.md': 'Write tersely.',
  '/prompts/rules.md': 'Cite everything.',
  '/custom/pre.md': 'CUSTOM PREAMBLE',
};

function makeVfs() {
  const readFile = vi.fn(async (path: string) => {
    if (!(path in VFS_FILES)) throw new Error(`ENOENT: ${path}`);
    return VFS_FILES[path];
  });
  return () => ({ readFile }) as unknown as VfsAdapter;
}

function minionChat(overrides: Partial<MinionChat> = {}): MinionChat {
  return {
    id: 'minion-1',
    parentChatId: 'chat-1',
    projectId: 'test-project-1',
    createdAt: new Date(0),
    lastModifiedAt: new Date(0),
    ...overrides,
  };
}

function projectWith(minionOptions: ToolOptions): Project {
  return createTestProject({
    systemPrompt: 'PROJECT PROMPT — the clone must never see this',
    enabledTools: ['memory', 'filesystem'],
    toolOptions: { minion: minionOptions },
  });
}

/** The prompt the minion tool itself would assemble for this call. */
async function minionPrompt(chat: MinionChat, project: Project): Promise<string> {
  const inputs = resolveMinionPromptInputs({}, chat, project.toolOptions?.minion ?? {});
  return resolveAgentSystemPrompt({ createVfsAdapter: makeVfs(), ...inputs.spec });
}

/**
 * The base prompt the cloned chat would assemble — the `'replace'` branch of
 * `resolveChatBasePrompt`, which is what `deriveChatAgentConfigFromMinion`
 * always produces.
 */
async function clonePrompt(chat: MinionChat, project: Project): Promise<string> {
  const cfg = deriveChatAgentConfigFromMinion(chat, project);
  expect(cfg.systemPromptMode).toBe('replace');
  return resolveAgentSystemPrompt({
    createVfsAdapter: makeVfs(),
    persona: cfg.persona,
    prePersonaFile: cfg.prePersonaSystemPromptFile,
    inlineSegments: [cfg.systemPrompt],
    promptFiles: cfg.systemPromptFile,
  });
}

async function expectEquivalent(chat: MinionChat, project: Project): Promise<string> {
  const [minion, clone] = await Promise.all([
    minionPrompt(chat, project),
    clonePrompt(chat, project),
  ]);
  expect(clone).toBe(minion);
  expect(clone).not.toContain('PROJECT PROMPT');
  return clone;
}

describe('a clone resolves the same system prompt as its minion', () => {
  it("nsMode 'off' — configured prompt only, no pre-persona read", async () => {
    const text = await expectEquivalent(minionChat(), projectWith({ systemPrompt: 'CONFIGURED' }));
    expect(text).toBe('CONFIGURED');
  });

  it("nsMode 'off' ignores the persona entirely", async () => {
    const text = await expectEquivalent(
      minionChat({ persona: 'researcher' }),
      projectWith({ systemPrompt: 'CONFIGURED' })
    );
    // No persona file, no global — that is what 'off' means, and a clone that
    // "helpfully" picked them up would be a different agent.
    expect(text).toBe('CONFIGURED');
  });

  it("nsMode 'persona' with the default persona behaves like 'off'", async () => {
    const text = await expectEquivalent(
      minionChat({ persona: 'default' }),
      projectWith({ namespacedMinion: 'persona', systemPrompt: 'CONFIGURED' })
    );
    expect(text).toBe('CONFIGURED');
  });

  it("nsMode 'persona' with a named persona: global + persona file", async () => {
    const text = await expectEquivalent(
      minionChat({ persona: 'researcher' }),
      projectWith({ namespacedMinion: 'persona', systemPrompt: 'CONFIGURED' })
    );
    expect(text).toBe('GLOBAL PREAMBLE\n\nYou are a research persona.');
    // The persona file replaces the configured prompt on both sides.
    expect(text).not.toContain('CONFIGURED');
  });

  it("nsMode 'all' with the default persona: global + configured prompt", async () => {
    const text = await expectEquivalent(
      minionChat({ persona: 'default' }),
      projectWith({ namespacedMinion: 'all', systemPrompt: 'CONFIGURED' })
    );
    expect(text).toBe('GLOBAL PREAMBLE\n\nCONFIGURED');
  });

  it('carries the inline systemPrompt after the persona block', async () => {
    const text = await expectEquivalent(
      minionChat({ persona: 'researcher', systemPrompt: 'EXTRA INSTRUCTIONS' }),
      projectWith({ namespacedMinion: 'persona', systemPrompt: 'CONFIGURED' })
    );
    expect(text).toBe('GLOBAL PREAMBLE\n\nYou are a research persona.\n\nEXTRA INSTRUCTIONS');
  });

  it('reads prompt files in order, last', async () => {
    const text = await expectEquivalent(
      minionChat({
        persona: 'researcher',
        systemPromptFile: ['/prompts/style.md', '/prompts/rules.md'],
      }),
      projectWith({ namespacedMinion: 'persona' })
    );
    expect(text).toBe(
      'GLOBAL PREAMBLE\n\nYou are a research persona.\n\nWrite tersely.\n\nCite everything.'
    );
  });

  it('accepts a single prompt file as a string', async () => {
    const text = await expectEquivalent(
      minionChat({ systemPromptFile: '/prompts/style.md' }),
      projectWith({})
    );
    expect(text).toBe('Write tersely.');
  });

  it('honours a custom pre-persona path', async () => {
    const text = await expectEquivalent(
      minionChat({ persona: 'researcher', prePersonaSystemPromptFile: '/custom/pre.md' }),
      projectWith({ namespacedMinion: 'persona' })
    );
    expect(text).toBe('CUSTOM PREAMBLE\n\nYou are a research persona.');
  });

  it("honours '' as an explicit pre-persona disable", async () => {
    const text = await expectEquivalent(
      minionChat({ persona: 'researcher', prePersonaSystemPromptFile: '' }),
      projectWith({ namespacedMinion: 'persona' })
    );
    expect(text).toBe('You are a research persona.');
  });

  it('never newly introduces the global preamble for a non-namespaced minion', async () => {
    // The `prePersonaSystemPromptFile: ''` in the derived config is doing the
    // work here: `undefined` would resolve to /minions/_global.md, which this
    // minion never read.
    const chat = minionChat({ prePersonaSystemPromptFile: '/custom/pre.md' });
    const text = await expectEquivalent(chat, projectWith({ systemPrompt: 'CONFIGURED' }));
    expect(text).toBe('CONFIGURED');
    expect(text).not.toContain('PREAMBLE');
  });
});

describe('the clone resolves from the VFS every turn, not from a snapshot', () => {
  it('picks up an edited persona file on the next resolution', async () => {
    const chat = minionChat({ persona: 'researcher' });
    const project = projectWith({ namespacedMinion: 'persona' });

    const before = await clonePrompt(chat, project);
    expect(before).toContain('You are a research persona.');

    VFS_FILES['/minions/researcher.md'] = 'You are now an editor persona.';
    try {
      const after = await clonePrompt(chat, project);
      expect(after).toContain('You are now an editor persona.');
      expect(after).not.toContain('research persona');
    } finally {
      VFS_FILES['/minions/researcher.md'] = 'You are a research persona.';
    }
  });

  it('snapshots only the configured prompt, which has no file behind it', async () => {
    // The minion tool's `systemPrompt` option lives in project settings, so a
    // clone that read it live would follow the project instead of the minion.
    const chat = minionChat();
    const cfg = deriveChatAgentConfigFromMinion(chat, projectWith({ systemPrompt: 'AT CLONE' }));
    expect(cfg.systemPrompt).toBe('AT CLONE');
    expect(cfg.persona).toBeUndefined();
    expect(cfg.systemPromptFile).toBeUndefined();
  });
});
