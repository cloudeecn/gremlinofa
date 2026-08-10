import { describe, expect, it } from 'vitest';
import type { ChatCompletionCreateParams } from 'openai/resources/index.mjs';
import { OpenAIClient } from '../openaiClient';
import type { APIDefinition, Model, ReasoningEffort } from '../../../protocol/types';
import { stubApiDeps } from './testStubs';

class TestableOpenAIClient extends OpenAIClient {
  public testApplyReasoning(
    requestParams: ChatCompletionCreateParams,
    options: {
      temperature?: number;
      enableReasoning?: boolean;
      reasoningEffort?: ReasoningEffort;
      reasoningBudgetTokens?: number;
      maxTokens?: number;
    },
    model?: Model,
    apiDefinition?: APIDefinition
  ) {
    this.applyReasoning(requestParams, options, model, apiDefinition);
  }
}

const openRouterDef: APIDefinition = {
  id: 'test-api',
  apiType: 'chatgpt',
  name: 'OpenRouter',
  baseUrl: 'https://openrouter.ai/api/v1',
  apiKey: 'key',
  advancedSettings: { reasoningDialect: 'openrouter' },
  createdAt: new Date(),
  updatedAt: new Date(),
};

const baseModel: Model = {
  id: 'anthropic/claude-sonnet-4.5',
  name: 'Claude Sonnet 4.5',
  apiType: 'chatgpt',
  matchedMode: 'fuzz',
  reasoningMode: 'optional',
};

const params = (): ChatCompletionCreateParams => ({
  model: 'anthropic/claude-sonnet-4.5',
  messages: [],
  max_completion_tokens: 1536,
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const reasoningOf = (p: ChatCompletionCreateParams): any => (p as any)['reasoning'];

const client = new TestableOpenAIClient(stubApiDeps);

describe('OpenRouter unified reasoning', () => {
  it('sends no reasoning field at all for a non-reasoning model', () => {
    const p = params();
    client.testApplyReasoning(
      p,
      { enableReasoning: true, reasoningEffort: 'high' },
      { ...baseModel, reasoningMode: 'none' },
      openRouterDef
    );
    expect(reasoningOf(p)).toBeUndefined();
  });

  it('sends enabled: false when the user turned reasoning off', () => {
    const p = params();
    client.testApplyReasoning(p, { enableReasoning: false }, baseModel, openRouterDef);
    expect(reasoningOf(p)).toEqual({ enabled: false });
  });

  it('sends nothing when the toggle is off but the endpoint mandates reasoning', () => {
    const p = params();
    client.testApplyReasoning(
      p,
      { enableReasoning: false },
      { ...baseModel, reasoningMode: 'always' },
      openRouterDef
    );
    expect(reasoningOf(p)).toBeUndefined();
  });

  it('asks a mandatory-reasoning endpoint for its lowest effort when the levels are known', () => {
    const p = params();
    client.testApplyReasoning(
      p,
      { enableReasoning: false, reasoningEffort: 'max' },
      { ...baseModel, reasoningMode: 'always', supportedReasoningEfforts: ['low', 'high', 'max'] },
      openRouterDef
    );
    expect(reasoningOf(p)).toEqual({ effort: 'low' });
  });

  it('sends the effort when one is picked', () => {
    const p = params();
    client.testApplyReasoning(
      p,
      { enableReasoning: true, reasoningEffort: 'high', reasoningBudgetTokens: 4096 },
      { ...baseModel, supportedReasoningEfforts: ['low', 'medium', 'high'] },
      openRouterDef
    );
    expect(reasoningOf(p)).toEqual({ effort: 'high' });
    expect(p.reasoning_effort).toBeUndefined();
  });

  it('passes xhigh and max through — this field is not the SDK’s narrower one', () => {
    for (const effort of ['xhigh', 'max'] as const) {
      const p = params();
      client.testApplyReasoning(
        p,
        { enableReasoning: true, reasoningEffort: effort },
        { ...baseModel, supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
        openRouterDef
      );
      expect(reasoningOf(p)).toEqual({ effort });
    }
  });

  it('clamps the effort to what the model declares', () => {
    const p = params();
    client.testApplyReasoning(
      p,
      { enableReasoning: true, reasoningEffort: 'max' },
      { ...baseModel, supportedReasoningEfforts: ['low', 'high'] },
      openRouterDef
    );
    expect(reasoningOf(p)).toEqual({ effort: 'high' });
  });

  it('passes an effort through untouched when the model declares no ladder', () => {
    const p = params();
    client.testApplyReasoning(
      p,
      { enableReasoning: true, reasoningEffort: 'medium' },
      baseModel,
      openRouterDef
    );
    expect(reasoningOf(p)).toEqual({ effort: 'medium' });
  });

  it('falls back to max_tokens when no effort is picked', () => {
    const p = params();
    client.testApplyReasoning(
      p,
      { enableReasoning: true, reasoningBudgetTokens: 2000, maxTokens: 8000 },
      baseModel,
      openRouterDef
    );
    expect(reasoningOf(p)).toEqual({ max_tokens: 2000 });
    expect(p.max_completion_tokens).toBe(1536);
  });

  it('raises max_completion_tokens when the budget would leave no room for an answer', () => {
    const p = params();
    client.testApplyReasoning(
      p,
      { enableReasoning: true, reasoningBudgetTokens: 4096, maxTokens: 1536 },
      baseModel,
      openRouterDef
    );
    expect(reasoningOf(p)).toEqual({ max_tokens: 4096 });
    expect(p.max_completion_tokens).toBe(4596);
  });

  it('never sends both effort and max_tokens', () => {
    const p = params();
    client.testApplyReasoning(
      p,
      { enableReasoning: true, reasoningEffort: 'low', reasoningBudgetTokens: 4096 },
      { ...baseModel, supportedReasoningEfforts: ['low', 'high'] },
      openRouterDef
    );
    expect(reasoningOf(p)).toEqual({ effort: 'low' });
  });

  it('falls back to enabled: true with neither effort nor budget', () => {
    const p = params();
    client.testApplyReasoning(
      p,
      { enableReasoning: true, reasoningBudgetTokens: 0 },
      baseModel,
      openRouterDef
    );
    expect(reasoningOf(p)).toEqual({ enabled: true });
  });

  it('ignores deFactoThinking metadata carried by a model routed through the gateway', () => {
    const p = params();
    client.testApplyReasoning(
      p,
      { enableReasoning: true },
      { ...baseModel, id: 'deepseek/deepseek-chat', deFactoThinking: true },
      openRouterDef
    );
    expect(reasoningOf(p)).toEqual({ enabled: true });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((p as any)['thinking']).toBeUndefined();
  });

  it('beats a model whose own metadata names a different dialect', () => {
    const p = params();
    client.testApplyReasoning(
      p,
      { enableReasoning: false },
      { ...baseModel, id: 'z-ai/glm-4.6', reasoningDialect: 'thinking-object' },
      openRouterDef
    );
    expect(reasoningOf(p)).toEqual({ enabled: false });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((p as any)['thinking']).toBeUndefined();
  });
});
