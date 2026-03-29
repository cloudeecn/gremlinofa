import { describe, expect, it } from 'vitest';
import type { ChatCompletionCreateParams } from 'openai/resources/index.mjs';
import type OpenAI from 'openai';
import { OpenAIClient } from '../openaiClient';
import { ResponsesClient } from '../responsesClient';
import type { APIDefinition, Model } from '../../../types';

// Expose protected applyReasoning for testing
class TestableOpenAIClient extends OpenAIClient {
  public testApplyReasoning(
    requestParams: ChatCompletionCreateParams,
    options: { temperature?: number; enableReasoning?: boolean; reasoningEffort?: undefined },
    model?: Model,
    apiDefinition?: APIDefinition
  ) {
    this.applyReasoning(requestParams, options, model, apiDefinition);
  }
}

class TestableResponsesClient extends ResponsesClient {
  public testApplyReasoning(
    requestParams: OpenAI.Responses.ResponseCreateParams,
    options: {
      temperature?: number;
      enableReasoning?: boolean;
      reasoningEffort?: undefined;
      reasoningSummary?: undefined;
    },
    model?: Model,
    apiDefinition?: APIDefinition
  ) {
    this.applyReasoning(requestParams, options, model, apiDefinition);
  }
}

const baseModel: Model = {
  id: 'test-model',
  name: 'Test Model',
  apiType: 'chatgpt',
  matchedMode: 'exact',
};

const baseApiDef: APIDefinition = {
  id: 'test-api',
  apiType: 'chatgpt',
  name: 'Test API',
  baseUrl: '',
  apiKey: 'key',
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('De facto thinking - OpenAI Chat Completions', () => {
  const client = new TestableOpenAIClient();

  it('injects thinking: enabled when model has deFactoThinking and reasoning is on', () => {
    const params: ChatCompletionCreateParams = { model: 'deepseek-chat', messages: [] };
    const model: Model = { ...baseModel, deFactoThinking: true, reasoningMode: 'optional' };
    client.testApplyReasoning(params, { enableReasoning: true }, model);
    expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (params as any)['thinking']
    ).toEqual({ type: 'enabled' });
  });

  it('injects thinking: disabled when model has deFactoThinking and reasoning is off', () => {
    const params: ChatCompletionCreateParams = { model: 'deepseek-chat', messages: [] };
    const model: Model = { ...baseModel, deFactoThinking: true, reasoningMode: 'optional' };
    client.testApplyReasoning(params, { enableReasoning: false }, model);
    expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (params as any)['thinking']
    ).toEqual({ type: 'disabled' });
  });

  it('injects thinking: enabled via provider advancedSettings even without model flag', () => {
    const params: ChatCompletionCreateParams = { model: 'some-model', messages: [] };
    const apiDef: APIDefinition = {
      ...baseApiDef,
      advancedSettings: { deFactoThinking: true },
    };
    client.testApplyReasoning(params, { enableReasoning: true }, baseModel, apiDef);
    expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (params as any)['thinking']
    ).toEqual({ type: 'enabled' });
  });

  it('injects thinking: disabled via provider advancedSettings when reasoning is off', () => {
    const params: ChatCompletionCreateParams = { model: 'some-model', messages: [] };
    const apiDef: APIDefinition = {
      ...baseApiDef,
      advancedSettings: { deFactoThinking: true },
    };
    client.testApplyReasoning(params, { enableReasoning: false }, baseModel, apiDef);
    expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (params as any)['thinking']
    ).toEqual({ type: 'disabled' });
  });

  it('does not inject thinking when neither model nor provider has the flag', () => {
    const params: ChatCompletionCreateParams = { model: 'gpt-5', messages: [] };
    client.testApplyReasoning(params, { enableReasoning: true }, baseModel, baseApiDef);
    expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (params as any)['thinking']
    ).toBeUndefined();
  });

  it('skips standard reasoning_effort when deFactoThinking is set', () => {
    const params: ChatCompletionCreateParams = { model: 'deepseek-chat', messages: [] };
    const model: Model = {
      ...baseModel,
      deFactoThinking: true,
      reasoningMode: 'optional',
      supportedReasoningEfforts: ['low', 'medium', 'high'],
    };
    client.testApplyReasoning(params, { enableReasoning: true }, model);
    expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (params as any)['thinking']
    ).toEqual({ type: 'enabled' });
    expect(params.reasoning_effort).toBeUndefined();
  });
});

describe('De facto thinking - Responses API', () => {
  const client = new TestableResponsesClient();

  it('injects thinking: enabled when model has deFactoThinking and reasoning is on', () => {
    const params = { model: 'deepseek-chat', input: '' } as OpenAI.Responses.ResponseCreateParams;
    const model: Model = { ...baseModel, deFactoThinking: true, reasoningMode: 'optional' };
    client.testApplyReasoning(params, { enableReasoning: true }, model);
    expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (params as any)['thinking']
    ).toEqual({ type: 'enabled' });
  });

  it('injects thinking: disabled when model has deFactoThinking and reasoning is off', () => {
    const params = { model: 'deepseek-chat', input: '' } as OpenAI.Responses.ResponseCreateParams;
    const model: Model = { ...baseModel, deFactoThinking: true, reasoningMode: 'optional' };
    client.testApplyReasoning(params, { enableReasoning: false }, model);
    expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (params as any)['thinking']
    ).toEqual({ type: 'disabled' });
  });

  it('injects thinking: enabled via provider advancedSettings', () => {
    const params = { model: 'some-model', input: '' } as OpenAI.Responses.ResponseCreateParams;
    const apiDef: APIDefinition = {
      ...baseApiDef,
      advancedSettings: { deFactoThinking: true },
    };
    client.testApplyReasoning(params, { enableReasoning: true }, baseModel, apiDef);
    expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (params as any)['thinking']
    ).toEqual({ type: 'enabled' });
  });

  it('does not inject thinking when neither model nor provider has the flag', () => {
    const params = { model: 'gpt-5', input: '' } as OpenAI.Responses.ResponseCreateParams;
    client.testApplyReasoning(params, { enableReasoning: true }, baseModel, baseApiDef);
    expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (params as any)['thinking']
    ).toBeUndefined();
  });

  it('does not set reasoning or include when deFactoThinking is used', () => {
    const params = { model: 'deepseek-chat', input: '' } as OpenAI.Responses.ResponseCreateParams;
    const model: Model = {
      ...baseModel,
      deFactoThinking: true,
      reasoningMode: 'optional',
    };
    client.testApplyReasoning(params, { enableReasoning: true }, model);
    expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (params as any)['thinking']
    ).toEqual({ type: 'enabled' });
    expect(params.reasoning).toBeUndefined();
    expect(params.include).toBeUndefined();
  });
});
