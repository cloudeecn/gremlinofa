/**
 * `buildAgenticLoopOptionsForContext` — the chat-level agent-config wiring.
 *
 * The field-by-field precedence table is unit-tested in
 * `lib/__tests__/resolveChatAgentConfig.test.ts`; what these tests cover is
 * what the builder does with the resolved settings: the system-prompt modes,
 * the namespace reaching the loop, and the no-override path staying identical
 * to what it produced before the chat layer existed.
 */

import { describe, it, expect, vi } from 'vitest';
import type { APIDefinition, Chat, ChatAgentConfig, Model, Project } from '../../protocol/types';
import type { VfsAdapter } from '../../services/vfs/vfsAdapter';
import type { BackendDeps } from '../backendDeps';
import { buildAgenticLoopOptionsForContext, type ChatLoopContext } from '../buildLoopOptions';

const VFS_FILES: Record<string, string> = {
  '/minions/_global.md': 'GLOBAL',
  '/minions/researcher.md': 'PERSONA TEXT',
  '/prompts/extra.md': 'EXTRA FILE',
};

const project: Project = {
  id: 'p1',
  name: 'P',
  createdAt: new Date(0),
  lastUsedAt: new Date(0),
  systemPrompt: 'PROJECT PROMPT',
  preFillResponse: '',
  apiDefinitionId: 'api_1',
  modelId: 'm1',
  webSearchEnabled: false,
  temperature: 0.5,
  maxOutputTokens: 2048,
  enableReasoning: false,
  reasoningBudgetTokens: 1024,
  enabledTools: ['memory', 'filesystem'],
};

const apiDef = { id: 'api_1', apiType: 'anthropic' } as unknown as APIDefinition;
const model = { id: 'm1', name: 'M1', apiType: 'anthropic' } as unknown as Model;

function makeCtx(agentConfig?: ChatAgentConfig): ChatLoopContext {
  const chat = {
    id: 'c1',
    projectId: 'p1',
    name: 'Chat',
    apiDefinitionId: null,
    modelId: null,
    createdAt: new Date(0),
    lastModifiedAt: new Date(0),
    ...(agentConfig ? { agentConfig } : {}),
  } as Chat;
  return { chat, project, apiDef, model, modelId: 'm1' };
}

function makeDeps() {
  const readFile = vi.fn(async (path: string) => {
    if (!(path in VFS_FILES)) throw new Error(`ENOENT: ${path}`);
    return VFS_FILES[path];
  });
  const createVfsAdapter = vi.fn(
    (_deps, _project, _userId, _ns?: string) => ({ readFile }) as unknown as VfsAdapter
  );
  const getSystemPrompts = vi.fn(async () => ['TOOL PROMPT']);
  return {
    deps: {
      storage: {} as never,
      encryption: { deriveUserId: vi.fn(async () => 'uid') } as never,
      apiService: {} as never,
      toolRegistry: { getSystemPrompts } as never,
      loopRegistry: {} as never,
      createVfsAdapter,
    } as unknown as BackendDeps,
    createVfsAdapter,
    getSystemPrompts,
    readFile,
  };
}

const build = (agentConfig?: ChatAgentConfig) => {
  const { deps, createVfsAdapter, getSystemPrompts, readFile } = makeDeps();
  return buildAgenticLoopOptionsForContext(
    deps,
    makeCtx(agentConfig),
    new AbortController().signal,
    'loop_1'
  ).then(options => ({ options, createVfsAdapter, getSystemPrompts, readFile }));
};

describe('no chat agent config', () => {
  it('produces the pre-feature options, project prompt and all', async () => {
    const { options } = await build();
    expect(options.systemPrompt).toBe('PROJECT PROMPT\n\nTOOL PROMPT');
    expect(options.enabledTools).toEqual(['memory', 'filesystem']);
    expect(options.namespace).toBeUndefined();
    expect(options.fileLineNumbers).toBeUndefined();
    expect(options.temperature).toBe(0.5);
    expect(options.maxTokens).toBe(2048);
  });

  it('reads no VFS files at all', async () => {
    // The `'project'` branch must not touch the VFS: a chat that predates the
    // feature should not gain a /minions/_global.md dependency. The resolver
    // is never entered, so not even the adapter gets constructed.
    const { readFile } = await build();
    expect(readFile).not.toHaveBeenCalled();
  });
});

describe('systemPromptMode', () => {
  it("'project' ignores the chat's prompt sources entirely", async () => {
    const { options } = await build({
      systemPromptMode: 'project',
      persona: 'researcher',
      systemPrompt: 'CHAT PROMPT',
    });
    expect(options.systemPrompt).toBe('PROJECT PROMPT\n\nTOOL PROMPT');
  });

  it('an absent mode defaults to project', async () => {
    const { options } = await build({ systemPrompt: 'CHAT PROMPT' });
    expect(options.systemPrompt).toBe('PROJECT PROMPT\n\nTOOL PROMPT');
  });

  it("'replace' drops the project prompt", async () => {
    const { options } = await build({
      systemPromptMode: 'replace',
      systemPrompt: 'CHAT PROMPT',
      prePersonaSystemPromptFile: '',
    });
    expect(options.systemPrompt).toBe('CHAT PROMPT\n\nTOOL PROMPT');
  });

  it("'append' keeps the project prompt first", async () => {
    const { options } = await build({
      systemPromptMode: 'append',
      systemPrompt: 'CHAT PROMPT',
      prePersonaSystemPromptFile: '',
    });
    expect(options.systemPrompt).toBe('PROJECT PROMPT\n\nCHAT PROMPT\n\nTOOL PROMPT');
  });

  it('resolves persona and prompt files from the VFS, tool prompts last', async () => {
    const { options } = await build({
      systemPromptMode: 'replace',
      persona: 'researcher',
      systemPromptFile: '/prompts/extra.md',
    });
    expect(options.systemPrompt).toBe('GLOBAL\n\nPERSONA TEXT\n\nEXTRA FILE\n\nTOOL PROMPT');
  });

  it('raises CHAT_AGENT_PROMPT_UNRESOLVED naming the path when a persona is missing', async () => {
    // Stated intent: silently falling back to the project prompt would run the
    // agent under the wrong identity with no visible signal.
    const err = (await build({ systemPromptMode: 'replace', persona: 'ghost' }).then(
      () => undefined,
      (e: unknown) => e
    )) as { code?: string; message?: string } | undefined;
    expect(err?.code).toBe('CHAT_AGENT_PROMPT_UNRESOLVED');
    expect(err?.message).toContain('/minions/ghost.md');
  });
});

describe('namespace', () => {
  it('reaches the loop options and the tool system-prompt context', async () => {
    const { options, getSystemPrompts } = await build({ namespace: '/minions/researcher' });
    expect(options.namespace).toBe('/minions/researcher');
    expect(getSystemPrompts).toHaveBeenCalledWith(
      'anthropic',
      ['memory', 'filesystem'],
      expect.objectContaining({ namespace: '/minions/researcher' }),
      {}
    );
  });

  it('resolves persona files from the ROOT VFS even when namespaced', async () => {
    // A persona cannot be required to live inside its own sandbox.
    const { options, createVfsAdapter } = await build({
      systemPromptMode: 'replace',
      namespace: '/minions/researcher',
      persona: 'researcher',
      prePersonaSystemPromptFile: '',
    });
    expect(options.systemPrompt).toBe('PERSONA TEXT\n\nTOOL PROMPT');
    const namespaces = createVfsAdapter.mock.calls.map(c => c[3]);
    expect(namespaces).toContain(undefined);
  });
});

describe('tools', () => {
  it('narrows the tool list and the prompts generated from it', async () => {
    const { options, getSystemPrompts } = await build({ enabledTools: ['memory'] });
    expect(options.enabledTools).toEqual(['memory']);
    expect(getSystemPrompts).toHaveBeenCalledWith('anthropic', ['memory'], expect.anything(), {});
  });

  it('drops checkpoint replay when the chat narrows the tool away', async () => {
    const { deps } = makeDeps();
    const ctx = makeCtx({ enabledTools: ['memory'] });
    ctx.project = { ...project, enabledTools: ['memory', 'checkpoint'] };
    ctx.chat = { ...ctx.chat, checkpointMessageIds: ['msg_1'] };
    const options = await buildAgenticLoopOptionsForContext(
      deps,
      ctx,
      new AbortController().signal,
      'loop_1'
    );
    // The ids stay on the record, so re-enabling the tool restores them.
    expect(options.checkpointMessageIds).toBeUndefined();
    expect(ctx.chat.checkpointMessageIds).toEqual(['msg_1']);
  });
});
