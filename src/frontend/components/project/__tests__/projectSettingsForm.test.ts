import { describe, it, expect } from 'vitest';
import type { Project, ToolOptionDefinition } from '../../../../shared/protocol/types';
import {
  formToProjectPatch,
  initProjectSettingsState,
  projectSettingsReducer,
  projectToForm,
  type ProjectSettingsState,
} from '../projectSettingsForm';

const created = new Date('2026-01-01T00:00:00Z');

/** Every field the settings page edits set to a non-default value. */
const fullProject: Project = {
  id: 'project-1',
  name: 'Everything On',
  icon: '🧪',
  createdAt: created,
  lastUsedAt: created,
  apiDefinitionId: 'api-1',
  modelId: 'claude-opus',
  systemPrompt: 'Be terse.',
  preFillResponse: 'Sure:',
  temperature: 0.7,
  maxOutputTokens: 8192,
  enableReasoning: true,
  reasoningBudgetTokens: 4096,
  thinkingKeepTurns: -1,
  pruneThinkingBeforeApiCall: true,
  reasoningEffort: 'high',
  reasoningSummary: 'detailed',
  verbosity: 'low',
  webSearchEnabled: true,
  sendMessageMetadata: 'template',
  metadataTimestampMode: 'relative',
  metadataIncludeModelName: true,
  metadataIncludeContextWindow: true,
  metadataIncludeCost: true,
  metadataTemplate: '{{timestamp}} {{userMessage}}',
  metadataNewContext: true,
  enabledTools: ['memory', 'javascript'],
  toolOptions: { memory: { useSystemPrompt: true }, javascript: { loadLib: false } },
  disableStream: true,
  extendedContext: true,
  useAnthropicOneHourCache: true,
  noLineNumbers: true,
  cacheRoutingScope: 'chat',
  flexTierEnabled: true,
  remoteVfsUrl: 'https://vfs.example.com',
  remoteVfsPassword: 'hunter2',
};

/** Only the fields `Project` requires. */
const sparseProject: Project = {
  id: 'project-2',
  name: 'Bare',
  createdAt: created,
  lastUsedAt: created,
  apiDefinitionId: null,
  modelId: null,
  systemPrompt: '',
  preFillResponse: '',
  webSearchEnabled: false,
  temperature: null,
  maxOutputTokens: 1536,
  enableReasoning: false,
  reasoningBudgetTokens: 1024,
};

describe('projectToForm -> formToProjectPatch', () => {
  it('an untouched form writes back the project values unchanged', () => {
    const patch = formToProjectPatch(projectToForm(fullProject));
    expect({ ...fullProject, ...patch }).toEqual(fullProject);
  });

  it('keeps zero values instead of treating them as empty', () => {
    const project = { ...fullProject, temperature: 0, thinkingKeepTurns: 0, maxOutputTokens: 0 };
    const patch = formToProjectPatch(projectToForm(project));
    expect(patch).toMatchObject({ temperature: 0, thinkingKeepTurns: 0, maxOutputTokens: 0 });
  });

  it('leaves absent opt-in fields absent and writes the documented defaults', () => {
    const patch = formToProjectPatch(projectToForm(sparseProject));
    expect({ ...sparseProject, ...patch }).toEqual({
      ...sparseProject,
      sendMessageMetadata: false,
      metadataTimestampMode: 'disabled',
      metadataIncludeModelName: false,
      metadataIncludeContextWindow: false,
      metadataIncludeCost: false,
      metadataTemplate: '{{userMessage}}',
      metadataNewContext: false,
    });
    // Unset rather than written as false / [] / {}.
    for (const key of [
      'thinkingKeepTurns',
      'pruneThinkingBeforeApiCall',
      'enabledTools',
      'toolOptions',
      'disableStream',
      'cacheRoutingScope',
      'remoteVfsUrl',
    ] as const) {
      expect(patch[key]).toBeUndefined();
    }
  });

  it('covers every form field', () => {
    const form = projectToForm(fullProject);
    expect(Object.keys(formToProjectPatch(form)).sort()).toEqual(Object.keys(form).sort());
  });

  it('clears the remote VFS in server mode', () => {
    const patch = formToProjectPatch(projectToForm(fullProject), { serverMode: true });
    expect(patch.remoteVfsUrl).toBeUndefined();
    expect(patch.remoteVfsPassword).toBeUndefined();
  });
});

describe('formToProjectPatch numeric text', () => {
  const form = projectToForm(fullProject);

  it('maps blank fields to their empty meaning', () => {
    const patch = formToProjectPatch({
      ...form,
      temperature: '',
      thinkingKeepTurns: '',
      maxOutputTokens: '',
      reasoningBudgetTokens: '',
    });
    expect(patch).toMatchObject({
      temperature: null,
      thinkingKeepTurns: undefined,
      maxOutputTokens: 1536,
      reasoningBudgetTokens: 1024,
    });
  });

  it('never writes NaN', () => {
    const patch = formToProjectPatch({
      ...form,
      temperature: 'abc',
      thinkingKeepTurns: 'abc',
      maxOutputTokens: 'abc',
      reasoningBudgetTokens: 'abc',
    });
    expect(patch).toMatchObject({
      temperature: null,
      thinkingKeepTurns: undefined,
      maxOutputTokens: 1536,
      reasoningBudgetTokens: 1024,
    });
  });

  it('trims the remote VFS URL', () => {
    expect(formToProjectPatch({ ...form, remoteVfsUrl: '  ' }).remoteVfsUrl).toBeUndefined();
    expect(formToProjectPatch({ ...form, remoteVfsUrl: ' https://x ' }).remoteVfsUrl).toBe(
      'https://x'
    );
  });
});

describe('projectSettingsReducer', () => {
  const optionDefinitions: ToolOptionDefinition[] = [
    { type: 'boolean', id: 'loadLib', label: 'Load /lib', default: true },
    { type: 'model', id: 'model', label: 'Model' },
  ];

  function loaded(project: Project = sparseProject): ProjectSettingsState {
    return initProjectSettingsState(project);
  }

  it('has no form until a project arrives, and ignores edits before that', () => {
    const empty = initProjectSettingsState(null);
    expect(empty.form).toBeNull();
    expect(projectSettingsReducer(empty, { type: 'patch', fields: { systemPrompt: 'x' } })).toBe(
      empty
    );
  });

  it('seed replaces the form with the new project', () => {
    const edited = projectSettingsReducer(loaded(), {
      type: 'patch',
      fields: { systemPrompt: 'draft' },
    });
    const reseeded = projectSettingsReducer(edited, { type: 'seed', project: fullProject });
    expect(reseeded.seededFrom).toBe(fullProject);
    expect(reseeded.form?.systemPrompt).toBe('Be terse.');
  });

  it('enabling a tool fills in option defaults, with the model currently picked in the form', () => {
    const picked = projectSettingsReducer(loaded(), {
      type: 'patch',
      fields: { apiDefinitionId: 'api-9', modelId: 'gpt-9' },
    });
    const next = projectSettingsReducer(picked, {
      type: 'toggleTool',
      toolName: 'javascript',
      enabled: true,
      optionDefinitions,
    });
    expect(next.form?.enabledTools).toEqual(['javascript']);
    expect(next.form?.toolOptions.javascript).toEqual({
      loadLib: true,
      model: { apiDefinitionId: 'api-9', modelId: 'gpt-9' },
    });
  });

  it('enabling keeps options the tool already stored', () => {
    const next = projectSettingsReducer(loaded(fullProject), {
      type: 'toggleTool',
      toolName: 'javascript',
      enabled: true,
      optionDefinitions,
    });
    expect(next.form?.toolOptions.javascript.loadLib).toBe(false);
    // Re-enabling moves it to the end rather than listing it twice.
    expect(next.form?.enabledTools).toEqual(['memory', 'javascript']);
  });

  it('disabling a tool keeps its options for next time', () => {
    const next = projectSettingsReducer(loaded(fullProject), {
      type: 'toggleTool',
      toolName: 'memory',
      enabled: false,
    });
    expect(next.form?.enabledTools).toEqual(['javascript']);
    expect(next.form?.toolOptions.memory).toEqual({ useSystemPrompt: true });
  });

  it('setToolOption changes one option and leaves its siblings', () => {
    const next = projectSettingsReducer(loaded(fullProject), {
      type: 'setToolOption',
      toolName: 'memory',
      optionId: 'depth',
      value: 3,
    });
    expect(next.form?.toolOptions.memory).toEqual({ useSystemPrompt: true, depth: 3 });
    expect(next.form?.toolOptions.javascript).toEqual({ loadLib: false });
  });
});
