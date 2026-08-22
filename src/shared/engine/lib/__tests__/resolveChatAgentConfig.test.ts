import { describe, it, expect } from 'vitest';
import type { APIDefinition, ChatAgentConfig, Project } from '../../../protocol/types';
import { NUDGE_THINKING_DEFAULT } from '../../../services/api/apiService';
import { resolveChatAgentSettings } from '../resolveChatAgentConfig';

const project: Project = {
  id: 'proj_1',
  name: 'P',
  createdAt: new Date(0),
  lastUsedAt: new Date(0),
  systemPrompt: 'PROJECT PROMPT',
  preFillResponse: '',
  apiDefinitionId: 'api_1',
  modelId: 'm1',
  webSearchEnabled: true,
  temperature: 0.7,
  maxOutputTokens: 4096,
  enableReasoning: true,
  reasoningBudgetTokens: 2048,
  thinkingKeepTurns: 3,
  pruneThinkingBeforeApiCall: true,
  reasoningEffort: 'medium',
  reasoningSummary: 'auto',
  verbosity: 'medium',
  enabledTools: ['memory', 'filesystem', 'checkpoint'],
  noLineNumbers: true,
};

const apiDef = {
  id: 'api_1',
  apiType: 'anthropic',
  advancedSettings: { nudgeThinking: true },
} as unknown as APIDefinition;

const plainApiDef = { id: 'api_1', apiType: 'anthropic' } as unknown as APIDefinition;

function resolve(agent?: ChatAgentConfig, def: APIDefinition = apiDef) {
  return resolveChatAgentSettings(project, def, agent);
}

describe('resolveChatAgentSettings — no chat layer', () => {
  // The regression net for the whole feature: a chat with no agentConfig must
  // produce exactly what buildLoopOptions produced before the chat layer existed.
  it('reproduces the pre-feature project-only values', () => {
    expect(resolve(undefined)).toEqual({
      temperature: 0.7,
      maxTokens: 4096,
      webSearchEnabled: true,
      enabledTools: ['memory', 'filesystem', 'checkpoint'],
      enableReasoning: true,
      reasoningBudgetTokens: 2048,
      reasoningEffort: 'medium',
      verbosity: 'medium',
      thinkingKeepTurns: 3,
      pruneThinkingKeepTurns: 3,
      nudgeThinking: NUDGE_THINKING_DEFAULT,
      fileLineNumbers: undefined,
      namespace: undefined,
    });
  });

  it('an empty override object is indistinguishable from none', () => {
    expect(resolve({})).toEqual(resolve(undefined));
  });

  it('maps a null project temperature to undefined', () => {
    expect(
      resolveChatAgentSettings({ ...project, temperature: null }, apiDef, undefined)
    ).toMatchObject({ temperature: undefined });
  });

  it('leaves nudgeThinking off when the API definition does not enable it', () => {
    expect(resolve(undefined, plainApiDef).nudgeThinking).toBeUndefined();
  });
});

describe('resolveChatAgentSettings — per-field overrides', () => {
  it.each([
    ['temperature', { temperature: 0.1 }, 'temperature', 0.1],
    ['maxOutputTokens', { maxOutputTokens: 100 }, 'maxTokens', 100],
    ['webSearchEnabled', { webSearchEnabled: false }, 'webSearchEnabled', false],
    ['enableReasoning', { enableReasoning: false }, 'enableReasoning', false],
    ['reasoningBudgetTokens', { reasoningBudgetTokens: 99 }, 'reasoningBudgetTokens', 99],
    ['reasoningEffort', { reasoningEffort: 'high' as const }, 'reasoningEffort', 'high'],
    ['verbosity', { verbosity: 'low' as const }, 'verbosity', 'low'],
    ['fileLineNumbers', { fileLineNumbers: true }, 'fileLineNumbers', true],
  ])('%s overrides the project value', (_name, agent, key, expected) => {
    expect(resolve(agent as ChatAgentConfig)[key as 'temperature']).toBe(expected);
  });

  it('falsy-but-defined overrides land instead of falling through', () => {
    // `??` not `||`: 0 and false are real choices, not "inherit".
    const s = resolve({ temperature: 0, enableReasoning: false, maxOutputTokens: 0 });
    expect(s.temperature).toBe(0);
    expect(s.enableReasoning).toBe(false);
    expect(s.maxTokens).toBe(0);
  });
});

describe('resolveChatAgentSettings — enabledTools intersection', () => {
  it('narrows to the overlap, preserving project order', () => {
    expect(resolve({ enabledTools: ['checkpoint', 'memory'] }).enabledTools).toEqual([
      'memory',
      'checkpoint',
    ]);
  });

  it('drops a tool the project has since disabled', () => {
    // A stale cloned config must not re-enable anything project-wide.
    expect(resolve({ enabledTools: ['memory', 'javascript'] }).enabledTools).toEqual(['memory']);
  });

  it('an empty override disables every tool', () => {
    expect(resolve({ enabledTools: [] }).enabledTools).toEqual([]);
  });

  it('falls back to the full project set when unset', () => {
    expect(resolve({}).enabledTools).toEqual(project.enabledTools);
  });
});

describe('resolveChatAgentSettings — nudgeThinking', () => {
  it("'' disables the nudge even when the API definition enables it", () => {
    expect(resolve({ nudgeThinking: '' }).nudgeThinking).toBe('');
  });

  it('custom text wins over the default', () => {
    expect(resolve({ nudgeThinking: 'THINK HARDER' }).nudgeThinking).toBe('THINK HARDER');
  });

  it('custom text applies even when the API definition has the nudge off', () => {
    expect(resolve({ nudgeThinking: 'X' }, plainApiDef).nudgeThinking).toBe('X');
  });
});

describe('resolveChatAgentSettings — pruneThinkingKeepTurns derivation', () => {
  it('derives from the resolved keep-turns, not the project one', () => {
    expect(resolve({ thinkingKeepTurns: 0 }).pruneThinkingKeepTurns).toBe(0);
  });

  it('is undefined when the chat turns pruning off', () => {
    expect(resolve({ pruneThinkingBeforeApiCall: false }).pruneThinkingKeepTurns).toBeUndefined();
  });

  it('is undefined for the "all" sentinel', () => {
    expect(resolve({ thinkingKeepTurns: -1 }).pruneThinkingKeepTurns).toBeUndefined();
  });

  it('turns pruning on from the chat layer alone', () => {
    const noPrune = { ...project, pruneThinkingBeforeApiCall: false };
    const s = resolveChatAgentSettings(noPrune, apiDef, { pruneThinkingBeforeApiCall: true });
    expect(s.pruneThinkingKeepTurns).toBe(3);
  });
});

describe('resolveChatAgentSettings — namespace', () => {
  it('passes a set namespace through', () => {
    expect(resolve({ namespace: '/minions/researcher' }).namespace).toBe('/minions/researcher');
  });

  it("treats '' as the root VFS, matching absent", () => {
    // Unlike the other '' fields: projects have no namespace to inherit, so
    // there is nothing for '' to mean other than "root".
    expect(resolve({ namespace: '' }).namespace).toBeUndefined();
  });
});
