import { describe, it, expect } from 'vitest';
import type { ChatAgentConfig } from '../../../../../shared/protocol/types';
import { fromDraft, toDraft } from '../chatSettingsDraft';

/** Round-trip a config through the draft and back. */
const roundTrip = (cfg: ChatAgentConfig | undefined) => fromDraft(toDraft(cfg));

describe('toDraft / fromDraft — the empty case', () => {
  it('no config produces no config', () => {
    expect(roundTrip(undefined)).toBeUndefined();
  });

  it('an empty config stays empty rather than materialising defaults', () => {
    // Every field defaults to inherit, so an untouched form must emit nothing
    // — otherwise opening and saving the panel would silently pin the current
    // project values onto the chat.
    expect(roundTrip({})).toBeUndefined();
  });

  it("mode 'project' alone is not an override", () => {
    expect(roundTrip({ systemPromptMode: 'project' })).toBeUndefined();
  });
});

describe('fromDraft — only overridden keys survive', () => {
  it('emits just the fields that were set', () => {
    expect(roundTrip({ temperature: 0.3 })).toEqual({ temperature: 0.3 });
  });

  it('keeps falsy-but-defined values', () => {
    expect(roundTrip({ temperature: 0, enableReasoning: false, maxOutputTokens: 0 })).toEqual({
      temperature: 0,
      enableReasoning: false,
      maxOutputTokens: 0,
    });
  });

  it('drops a garbage numeric instead of emitting NaN', () => {
    const draft = { ...toDraft(undefined), temperature: 'abc' };
    expect(fromDraft(draft)).toBeUndefined();
  });

  it('drops a cleared numeric field', () => {
    const draft = { ...toDraft({ temperature: 0.5 }), temperature: '' };
    expect(fromDraft(draft)).toBeUndefined();
  });
});

describe("fromDraft — '' is a value, not inherit", () => {
  it("preserves prePersonaSystemPromptFile: ''", () => {
    // `undefined` would newly pull in /minions/_global.md, which is a
    // different agent, so the distinction has to survive the form.
    const cfg = roundTrip({ systemPromptMode: 'replace', prePersonaSystemPromptFile: '' });
    expect(cfg?.prePersonaSystemPromptFile).toBe('');
  });

  it("preserves nudgeThinking: ''", () => {
    expect(roundTrip({ nudgeThinking: '' })).toEqual({ nudgeThinking: '' });
  });

  it('distinguishes the three pre-persona states', () => {
    expect(toDraft({ systemPromptMode: 'replace' }).prePersonaMode).toBe('default');
    expect(
      toDraft({ systemPromptMode: 'replace', prePersonaSystemPromptFile: '' }).prePersonaMode
    ).toBe('off');
    expect(
      toDraft({ systemPromptMode: 'replace', prePersonaSystemPromptFile: '/x.md' }).prePersonaMode
    ).toBe('custom');
  });
});

describe('fromDraft — system prompt mode gating', () => {
  const full: ChatAgentConfig = {
    systemPromptMode: 'replace',
    persona: 'researcher',
    prePersonaSystemPromptFile: '/pre.md',
    systemPromptFile: ['/a.md', '/b.md'],
    systemPrompt: 'INLINE',
    temperature: 0.4,
  };

  it("strips every prompt sub-field when the mode is 'project'", () => {
    const draft = { ...toDraft(full), systemPromptMode: 'project' as const };
    const cfg = fromDraft(draft);
    expect(cfg).toEqual({ temperature: 0.4 });
  });

  it('keeps the typed values in the draft across a mode round-trip', () => {
    // replace → project → replace must not lose the user's typing.
    const draft = toDraft(full);
    const viaProject = { ...draft, systemPromptMode: 'project' as const };
    const back = { ...viaProject, systemPromptMode: 'replace' as const };
    expect(fromDraft(back)).toEqual(full);
  });

  it('keeps the namespace even in project mode — it is not a prompt source', () => {
    const draft = {
      ...toDraft({ systemPromptMode: 'replace', namespace: '/minions/r', persona: 'r' }),
      systemPromptMode: 'project' as const,
    };
    expect(fromDraft(draft)).toEqual({ namespace: '/minions/r' });
  });
});

describe('fromDraft — prompt files', () => {
  it('collapses a single path back to a string', () => {
    expect(roundTrip({ systemPromptMode: 'replace', systemPromptFile: '/a.md' })).toMatchObject({
      systemPromptFile: '/a.md',
    });
  });

  it('keeps an array of paths in order', () => {
    expect(
      roundTrip({ systemPromptMode: 'replace', systemPromptFile: ['/b.md', '/a.md'] })
    ).toMatchObject({ systemPromptFile: ['/b.md', '/a.md'] });
  });

  it('drops blank rows the user added but never filled in', () => {
    const draft = {
      ...toDraft({ systemPromptMode: 'replace' }),
      systemPromptFiles: ['/a.md', '', '  '],
    };
    expect(fromDraft(draft)?.systemPromptFile).toBe('/a.md');
  });

  it('normalises a string field into a one-row list for the editor', () => {
    expect(toDraft({ systemPromptFile: '/a.md' }).systemPromptFiles).toEqual(['/a.md']);
  });
});

describe('fromDraft — tools', () => {
  it('preserves an empty tool override, which means "no tools"', () => {
    expect(roundTrip({ enabledTools: [] })).toEqual({ enabledTools: [] });
  });

  it('preserves a tool the registry may no longer expose', () => {
    // A cloned config can carry one; dropping it here would silently widen or
    // narrow the chat on the next save.
    expect(roundTrip({ enabledTools: ['memory', 'retired-tool'] })).toEqual({
      enabledTools: ['memory', 'retired-tool'],
    });
  });
});

describe('fromDraft — overrides with no value', () => {
  it('emits nothing for an effort or verbosity override left on the default', () => {
    expect(
      fromDraft({ ...toDraft(undefined), hasReasoningEffort: true, hasVerbosity: true })
    ).toBeUndefined();
  });
});

describe('toDraft / fromDraft — full fidelity', () => {
  it('round-trips every field without loss', () => {
    const cfg: ChatAgentConfig = {
      systemPromptMode: 'append',
      persona: 'researcher',
      namespace: '/minions/researcher',
      prePersonaSystemPromptFile: '/pre.md',
      systemPromptFile: ['/a.md', '/b.md'],
      systemPrompt: 'INLINE',
      enabledTools: ['memory'],
      temperature: 0.25,
      maxOutputTokens: 4096,
      enableReasoning: true,
      reasoningBudgetTokens: 2048,
      reasoningEffort: 'high',
      verbosity: 'low',
      webSearchEnabled: true,
      fileLineNumbers: false,
      nudgeThinking: 'THINK',
      thinkingKeepTurns: -1,
      pruneThinkingBeforeApiCall: true,
    };
    expect(roundTrip(cfg)).toEqual(cfg);
  });
});
