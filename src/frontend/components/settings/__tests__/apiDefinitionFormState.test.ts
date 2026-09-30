import { describe, it, expect } from 'vitest';
import type { APIDefinition } from '../../../../shared/protocol/types';
import {
  EMPTY_API_DEFINITION_FORM,
  apiDefinitionToForm,
  buildAdvancedSettings,
  effectiveReasoningDialect,
  formToApiDefinition,
  type ApiDefinitionFormState,
} from '../apiDefinitionFormState';

const created = new Date('2026-01-01T00:00:00Z');
const now = new Date('2026-09-30T12:00:00Z');

function makeDefinition(overrides: Partial<APIDefinition> = {}): APIDefinition {
  return {
    id: 'api_1',
    apiType: 'chatgpt',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey: 'sk-test',
    createdAt: created,
    updatedAt: created,
    ...overrides,
  };
}

describe('buildAdvancedSettings', () => {
  it('returns undefined when no flag is on', () => {
    expect(buildAdvancedSettings(EMPTY_API_DEFINITION_FORM)).toBeUndefined();
  });

  it('writes only the flags that are on', () => {
    expect(
      buildAdvancedSettings({
        ...EMPTY_API_DEFINITION_FORM,
        isSubscription: true,
        enforceGenuineAnthropic: true,
      })
    ).toEqual({ isSubscription: true, enforceGenuineAnthropic: true });
  });

  const everyFlagOn: ApiDefinitionFormState = {
    ...EMPTY_API_DEFINITION_FORM,
    pruneThinking: true,
    pruneEmptyText: true,
    isSubscription: true,
    enforceGenuineAnthropic: true,
    reasoningDialect: 'openrouter',
    reasoningDialectOverride: true,
    nudgeThinking: true,
    mandateCoT: true,
    treatEmptyOutputAsError: true,
    treatFallbackAsError: true,
    useStreamAccumulator: true,
    flexTierSupported: true,
  };
  const sharedFlags = {
    pruneThinking: true,
    pruneEmptyText: true,
    isSubscription: true,
    nudgeThinking: true,
    mandateCoT: true,
    treatEmptyOutputAsError: true,
  };

  it('writes every flag Chat Completions shows', () => {
    expect(buildAdvancedSettings({ ...everyFlagOn, apiType: 'chatgpt' })).toEqual({
      ...sharedFlags,
      enforceGenuineAnthropic: true,
      reasoningDialect: 'openrouter',
      reasoningDialectOverride: true,
      flexTierSupported: true,
    });
  });

  it('drops the flags chatgpt-subscription hides, even when set under another type', () => {
    expect(buildAdvancedSettings({ ...everyFlagOn, apiType: 'chatgpt-subscription' })).toEqual(
      sharedFlags
    );
  });

  it('keeps the stream accumulator for the Responses API but not the OpenRouter dialect', () => {
    expect(buildAdvancedSettings({ ...everyFlagOn, apiType: 'responses_api' })).toEqual({
      ...sharedFlags,
      enforceGenuineAnthropic: true,
      reasoningDialectOverride: true,
      useStreamAccumulator: true,
      flexTierSupported: true,
    });
    expect(
      buildAdvancedSettings({
        ...EMPTY_API_DEFINITION_FORM,
        apiType: 'responses_api',
        reasoningDialect: 'thinking-object',
      })
    ).toEqual({ reasoningDialect: 'thinking-object' });
  });

  it('keeps treat-fallback-as-error only for claude-agent', () => {
    expect(buildAdvancedSettings({ ...everyFlagOn, apiType: 'claude-agent' })).toEqual({
      ...sharedFlags,
      enforceGenuineAnthropic: true,
      treatFallbackAsError: true,
      flexTierSupported: true,
    });
  });

  it('clears a stale hidden flag when an existing definition is saved again', () => {
    const form = apiDefinitionToForm(
      makeDefinition({
        apiType: 'chatgpt-subscription',
        advancedSettings: { flexTierSupported: true, reasoningDialect: 'thinking-object' },
      })
    );
    expect(buildAdvancedSettings(form)).toBeUndefined();
  });

  it("omits the default 'openai' dialect but keeps any other", () => {
    expect(
      buildAdvancedSettings({ ...EMPTY_API_DEFINITION_FORM, reasoningDialect: 'openai' })
    ).toBeUndefined();
    expect(
      buildAdvancedSettings({ ...EMPTY_API_DEFINITION_FORM, reasoningDialect: 'enable-thinking' })
    ).toEqual({ reasoningDialect: 'enable-thinking' });
  });

  it('migrates the legacy deFactoThinking flag to the dialect enum', () => {
    const form = apiDefinitionToForm(
      makeDefinition({ advancedSettings: { deFactoThinking: true, mandateCoT: true } })
    );
    expect(buildAdvancedSettings(form)).toEqual({
      reasoningDialect: 'thinking-object',
      mandateCoT: true,
    });
  });

  it('round-trips stored settings unchanged', () => {
    const advancedSettings = {
      pruneEmptyText: true,
      reasoningDialect: 'thinking-object' as const,
      reasoningDialectOverride: true,
      flexTierSupported: true,
    };
    const form = apiDefinitionToForm(makeDefinition({ advancedSettings }));
    expect(buildAdvancedSettings(form)).toEqual(advancedSettings);

    const agentSettings = { isSubscription: true, treatFallbackAsError: true };
    const agentForm = apiDefinitionToForm(
      makeDefinition({ apiType: 'claude-agent', advancedSettings: agentSettings })
    );
    expect(buildAdvancedSettings(agentForm)).toEqual(agentSettings);
  });
});

describe('effectiveReasoningDialect', () => {
  it('shows a dialect the type cannot send as the openai default', () => {
    const openRouter = { ...EMPTY_API_DEFINITION_FORM, reasoningDialect: 'openrouter' as const };
    expect(effectiveReasoningDialect({ ...openRouter, apiType: 'chatgpt' })).toBe('openrouter');
    expect(effectiveReasoningDialect({ ...openRouter, apiType: 'responses_api' })).toBe('openai');
    expect(effectiveReasoningDialect({ ...openRouter, apiType: 'anthropic' })).toBe('openai');
  });
});

describe('apiDefinitionToForm', () => {
  it('fills absent optional fields with the empty form values', () => {
    const form = apiDefinitionToForm(makeDefinition());
    expect(form).toEqual({
      ...EMPTY_API_DEFINITION_FORM,
      apiType: 'chatgpt',
      name: 'OpenRouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-test',
    });
  });

  it('joins extra model ids one per line', () => {
    const form = apiDefinitionToForm(makeDefinition({ extraModelIds: ['a', 'b'] }));
    expect(form.extraModelIds).toBe('a\nb');
  });
});

describe('formToApiDefinition', () => {
  it('saves an untouched edit form back to the same definition', () => {
    const def = makeDefinition({
      icon: '🦊',
      isDefault: true,
      isLocal: true,
      modelsEndpoint: 'https://example.com/models',
      proxyUrl: 'https://proxy.example.com',
      proxyAuthToken: 'secret',
      extraModelIds: ['model-a', 'model-b'],
      advancedSettings: { pruneThinking: true },
    });
    const saved = formToApiDefinition(apiDefinitionToForm(def), {
      id: def.id,
      existing: def,
      now,
    });
    expect(saved).toEqual({ ...def, updatedAt: now });
  });

  it('trims text fields and drops empty optionals', () => {
    const saved = formToApiDefinition(
      {
        ...EMPTY_API_DEFINITION_FORM,
        apiType: 'anthropic',
        name: '  Claude  ',
        icon: ' ',
        apiKey: ' sk-ant ',
        extraModelIds: '\n  one \n\n two\n',
        proxyUrl: '   ',
      },
      { id: 'api_new', now }
    );
    expect(saved).toMatchObject({
      id: 'api_new',
      name: 'Claude',
      icon: undefined,
      apiKey: 'sk-ant',
      extraModelIds: ['one', 'two'],
      proxyUrl: undefined,
      isDefault: false,
      createdAt: now,
      updatedAt: now,
    });
  });

  it('scrubs the fields chatgpt-subscription does not use', () => {
    const saved = formToApiDefinition(
      {
        ...EMPTY_API_DEFINITION_FORM,
        apiType: 'chatgpt-subscription',
        name: 'ChatGPT',
        baseUrl: 'https://stale.example.com',
        apiKey: 'stale-key',
        isLocal: true,
      },
      { id: 'api_sub', now }
    );
    expect(saved).toMatchObject({ baseUrl: '', apiKey: '', isLocal: false });
  });

  it('drops fields typed under another type that the chosen type hides', () => {
    const typedUnderChatCompletions = {
      ...EMPTY_API_DEFINITION_FORM,
      name: 'Switched',
      baseUrl: 'https://api.example.com',
      modelsEndpoint: 'https://api.example.com/models',
      proxyUrl: 'https://proxy.example.com',
      proxyAuthToken: 'secret',
      binaryPath: '/usr/local/bin/claude',
      extraArgs: '--verbose',
    };
    const saveAs = (apiType: ApiDefinitionFormState['apiType']) =>
      formToApiDefinition({ ...typedUnderChatCompletions, apiType }, { id: 'api_x', now });

    expect(saveAs('chatgpt-subscription')).toMatchObject({
      baseUrl: '',
      modelsEndpoint: undefined,
      proxyUrl: 'https://proxy.example.com',
      binaryPath: undefined,
      extraArgs: undefined,
    });
    expect(saveAs('claude-agent')).toMatchObject({
      baseUrl: '',
      modelsEndpoint: undefined,
      proxyUrl: undefined,
      proxyAuthToken: undefined,
      binaryPath: '/usr/local/bin/claude',
      extraArgs: '--verbose',
    });
    expect(saveAs('bedrock')).toMatchObject({
      baseUrl: 'https://api.example.com',
      modelsEndpoint: 'https://api.example.com/models',
      proxyUrl: undefined,
      proxyAuthToken: undefined,
      binaryPath: undefined,
    });
  });

  it('keeps the key but not Local for claude-agent', () => {
    const saved = formToApiDefinition(
      {
        ...EMPTY_API_DEFINITION_FORM,
        apiType: 'claude-agent',
        name: 'Claude Agent',
        apiKey: 'sk-ant-oat01-x',
        isLocal: true,
      },
      { id: 'api_agent', now }
    );
    expect(saved).toMatchObject({ apiKey: 'sk-ant-oat01-x', isLocal: false });
  });
});
