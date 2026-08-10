import { describe, expect, it } from 'vitest';
import type { ChatCompletionCreateParams } from 'openai/resources/index.mjs';
import type OpenAI from 'openai';
import { OpenAIClient } from '../openaiClient';
import { ResponsesClient } from '../responsesClient';
import type {
  APIDefinition,
  Model,
  ReasoningEffort,
  ReasoningHistoryParam,
} from '../../../protocol/types';
import { stubApiDeps } from './testStubs';

// `applyReasoning` is protected; these expose it the same way deFactoThinking.test.ts does.
class TestableOpenAIClient extends OpenAIClient {
  public testApplyReasoning(
    requestParams: ChatCompletionCreateParams,
    options: {
      temperature?: number;
      enableReasoning?: boolean;
      reasoningEffort?: ReasoningEffort;
      reasoningBudgetTokens?: number;
      maxTokens?: number;
      thinkingKeepTurns?: number;
    },
    model?: Model,
    apiDefinition?: APIDefinition,
    historyParam?: ReasoningHistoryParam
  ) {
    this.applyReasoning(requestParams, options, model, apiDefinition, historyParam);
  }
}

class TestableResponsesClient extends ResponsesClient {
  public testApplyReasoning(
    requestParams: OpenAI.Responses.ResponseCreateParams,
    options: {
      temperature?: number;
      enableReasoning?: boolean;
      reasoningEffort?: ReasoningEffort;
      reasoningSummary?: undefined;
      thinkingKeepTurns?: number;
    },
    model?: Model,
    apiDefinition?: APIDefinition,
    historyParam?: ReasoningHistoryParam
  ) {
    this.applyReasoning(requestParams, options, model, apiDefinition, historyParam);
  }
}

const baseModel: Model = {
  id: 'test-model',
  name: 'Test Model',
  apiType: 'chatgpt',
  matchedMode: 'exact',
  reasoningMode: 'optional',
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

const chatParams = (): ChatCompletionCreateParams => ({ model: 'test-model', messages: [] });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const field = (params: object, key: string): any => (params as any)[key];

describe('Reasoning dialects - Chat Completions', () => {
  const client = new TestableOpenAIClient(stubApiDeps);

  describe('thinking-object', () => {
    const model: Model = { ...baseModel, reasoningDialect: 'thinking-object' };

    it('sends thinking: enabled when reasoning is on', () => {
      const params = chatParams();
      client.testApplyReasoning(params, { enableReasoning: true }, model);
      expect(field(params, 'thinking')).toEqual({ type: 'enabled' });
    });

    it('sends thinking: disabled when reasoning is off', () => {
      const params = chatParams();
      client.testApplyReasoning(params, { enableReasoning: false }, model);
      expect(field(params, 'thinking')).toEqual({ type: 'disabled' });
    });

    it('sends no reasoning_effort for a model without effort levels (Kimi K2.x)', () => {
      const params = chatParams();
      client.testApplyReasoning(
        params,
        { enableReasoning: true, reasoningEffort: 'high' },
        { ...model, supportedReasoningEfforts: [] }
      );
      expect(field(params, 'thinking')).toEqual({ type: 'enabled' });
      expect(params.reasoning_effort).toBeUndefined();
    });

    describe('with effort levels (GLM-5.3)', () => {
      const glm53: Model = {
        ...model,
        reasoningMode: 'always',
        supportedReasoningEfforts: ['low', 'high', 'max'],
      };

      it('sends reasoning_effort beside thinking, max included', () => {
        const params = chatParams();
        client.testApplyReasoning(params, { enableReasoning: true, reasoningEffort: 'max' }, glm53);
        expect(field(params, 'thinking')).toEqual({ type: 'enabled' });
        expect(field(params, 'reasoning_effort')).toBe('max');
      });

      it('rounds an unlisted level up, as Z.ai does', () => {
        const params = chatParams();
        client.testApplyReasoning(
          params,
          { enableReasoning: true, reasoningEffort: 'medium' },
          glm53
        );
        expect(field(params, 'reasoning_effort')).toBe('high');
      });

      it('leaves the server default when no effort is picked', () => {
        const params = chatParams();
        client.testApplyReasoning(params, { enableReasoning: true }, glm53);
        expect(params.reasoning_effort).toBeUndefined();
      });

      it('drops to the lowest level when the toggle is off', () => {
        const params = chatParams();
        client.testApplyReasoning(
          params,
          { enableReasoning: false, reasoningEffort: 'max' },
          glm53
        );
        expect(field(params, 'thinking')).toEqual({ type: 'enabled' });
        expect(field(params, 'reasoning_effort')).toBe('low');
      });

      it('sends no effort beside thinking: disabled on an optional model', () => {
        const params = chatParams();
        client.testApplyReasoning(
          params,
          { enableReasoning: false, reasoningEffort: 'max' },
          { ...glm53, reasoningMode: 'optional' }
        );
        expect(field(params, 'thinking')).toEqual({ type: 'disabled' });
        expect(params.reasoning_effort).toBeUndefined();
      });
    });
  });

  describe('enable-thinking', () => {
    const model: Model = { ...baseModel, reasoningDialect: 'enable-thinking' };

    it('sends enable_thinking: true when reasoning is on', () => {
      const params = chatParams();
      client.testApplyReasoning(params, { enableReasoning: true }, model);
      expect(field(params, 'enable_thinking')).toBe(true);
      expect(field(params, 'thinking')).toBeUndefined();
    });

    it('sends enable_thinking: false when reasoning is off', () => {
      const params = chatParams();
      client.testApplyReasoning(params, { enableReasoning: false }, model);
      expect(field(params, 'enable_thinking')).toBe(false);
    });

    it('never rides alongside reasoning_effort', () => {
      const params = chatParams();
      client.testApplyReasoning(
        params,
        { enableReasoning: true, reasoningEffort: 'high' },
        { ...model, supportedReasoningEfforts: ['low', 'high'] }
      );
      expect(field(params, 'enable_thinking')).toBe(true);
      expect(params.reasoning_effort).toBeUndefined();
    });
  });

  describe('openai', () => {
    it('still maps effort onto reasoning_effort', () => {
      const params = chatParams();
      client.testApplyReasoning(
        params,
        { enableReasoning: true, reasoningEffort: 'high' },
        { ...baseModel, supportedReasoningEfforts: ['low', 'medium', 'high'] }
      );
      expect(params.reasoning_effort).toBe('high');
      expect(field(params, 'thinking')).toBeUndefined();
      expect(field(params, 'enable_thinking')).toBeUndefined();
    });

    it('sends none when the toggle is off and the ladder has it', () => {
      const params = chatParams();
      client.testApplyReasoning(
        params,
        { enableReasoning: false, reasoningEffort: 'high' },
        { ...baseModel, supportedReasoningEfforts: ['none', 'low', 'medium', 'high'] }
      );
      expect(params.reasoning_effort).toBe('none');
      expect(field(params, 'thinking')).toBeUndefined();
    });

    it('sends the lowest level when the toggle is off and the model cannot switch off', () => {
      const params = chatParams();
      client.testApplyReasoning(
        params,
        { enableReasoning: false, reasoningEffort: 'max' },
        { ...baseModel, reasoningMode: 'always', supportedReasoningEfforts: ['low', 'high', 'max'] }
      );
      expect(params.reasoning_effort).toBe('low');
    });

    it('sends nothing when the toggle is off and the model has no ladder or no reasoning', () => {
      for (const model of [
        baseModel,
        {
          ...baseModel,
          reasoningMode: 'none' as const,
          supportedReasoningEfforts: ['low' as const],
        },
      ]) {
        const params = chatParams();
        client.testApplyReasoning(params, { enableReasoning: false }, model);
        expect(params.reasoning_effort).toBeUndefined();
      }
    });
  });

  describe('always-reasoning models', () => {
    const always = (dialect: Model['reasoningDialect']): Model => ({
      ...baseModel,
      reasoningMode: 'always',
      reasoningDialect: dialect,
    });

    it('never sends thinking: disabled', () => {
      const params = chatParams();
      client.testApplyReasoning(params, { enableReasoning: false }, always('thinking-object'));
      expect(field(params, 'thinking')).toEqual({ type: 'enabled' });
    });

    it('never sends enable_thinking: false', () => {
      const params = chatParams();
      client.testApplyReasoning(params, { enableReasoning: false }, always('enable-thinking'));
      expect(field(params, 'enable_thinking')).toBe(true);
    });
  });

  describe('reasoning history (Keep Thinking Turns)', () => {
    const glm: Model = { ...baseModel, reasoningDialect: 'thinking-object' };
    const qwen: Model = { ...baseModel, reasoningDialect: 'enable-thinking' };

    it('sends clear_thinking: false at -1 and 2+', () => {
      for (const keep of [-1, 2]) {
        const params = chatParams();
        client.testApplyReasoning(
          params,
          { enableReasoning: true, thinkingKeepTurns: keep },
          glm,
          undefined,
          'clear_thinking'
        );
        expect(field(params, 'thinking')).toEqual({ type: 'enabled', clear_thinking: false });
      }
    });

    it('sends nothing extra at undefined, 0 and 1', () => {
      for (const keep of [undefined, 0, 1]) {
        const params = chatParams();
        client.testApplyReasoning(
          params,
          { enableReasoning: true, thinkingKeepTurns: keep },
          glm,
          undefined,
          'clear_thinking'
        );
        expect(field(params, 'thinking')).toEqual({ type: 'enabled' });
      }
    });

    it("sends Kimi K2.6's keep: all inside the thinking object", () => {
      const params = chatParams();
      client.testApplyReasoning(
        params,
        { enableReasoning: true, thinkingKeepTurns: -1 },
        glm,
        undefined,
        'thinking_keep'
      );
      expect(field(params, 'thinking')).toEqual({ type: 'enabled', keep: 'all' });

      const notAsked = chatParams();
      client.testApplyReasoning(
        notAsked,
        { enableReasoning: true, thinkingKeepTurns: 1 },
        glm,
        undefined,
        'thinking_keep'
      );
      expect(field(notAsked, 'thinking')).toEqual({ type: 'enabled' });
    });

    it('sends preserve_thinking next to enable_thinking', () => {
      const params = chatParams();
      client.testApplyReasoning(
        params,
        { enableReasoning: true, thinkingKeepTurns: 3 },
        qwen,
        undefined,
        'preserve_thinking'
      );
      expect(field(params, 'enable_thinking')).toBe(true);
      expect(field(params, 'preserve_thinking')).toBe(true);
    });

    it('sends no history switch while thinking is switched off', () => {
      const params = chatParams();
      client.testApplyReasoning(
        params,
        { enableReasoning: false, thinkingKeepTurns: -1 },
        qwen,
        undefined,
        'preserve_thinking'
      );
      expect(field(params, 'enable_thinking')).toBe(false);
      expect(field(params, 'preserve_thinking')).toBeUndefined();
    });

    it('ignores a switch that belongs to another dialect', () => {
      const params = chatParams();
      client.testApplyReasoning(
        params,
        { enableReasoning: true, thinkingKeepTurns: -1 },
        qwen,
        undefined,
        'clear_thinking'
      );
      expect(field(params, 'thinking')).toBeUndefined();
      expect(field(params, 'clear_thinking')).toBeUndefined();
    });
  });

  it('takes the dialect from the definition for an unrecognized model', () => {
    const params = chatParams();
    client.testApplyReasoning(params, { enableReasoning: true }, baseModel, {
      ...baseApiDef,
      advancedSettings: { reasoningDialect: 'enable-thinking' },
    });
    expect(field(params, 'enable_thinking')).toBe(true);
  });

  it('lets a definition override a known model’s dialect', () => {
    const params = chatParams();
    client.testApplyReasoning(
      params,
      { enableReasoning: true },
      { ...baseModel, reasoningDialect: 'thinking-object' },
      {
        ...baseApiDef,
        advancedSettings: { reasoningDialect: 'enable-thinking', reasoningDialectOverride: true },
      }
    );
    expect(field(params, 'enable_thinking')).toBe(true);
    expect(field(params, 'thinking')).toBeUndefined();
  });

  it('still applies temperature on every dialect', () => {
    for (const dialect of ['openai', 'thinking-object', 'enable-thinking', 'openrouter'] as const) {
      const params = chatParams();
      client.testApplyReasoning(
        params,
        { temperature: 0.7, enableReasoning: true },
        { ...baseModel, reasoningDialect: dialect }
      );
      expect(params.temperature).toBe(0.7);
    }
  });
});

describe('Reasoning dialects - Responses API', () => {
  const client = new TestableResponsesClient(stubApiDeps);
  const responsesParams = () =>
    ({ model: 'test-model', input: '' }) as OpenAI.Responses.ResponseCreateParams;

  it('honors thinking-object', () => {
    const params = responsesParams();
    client.testApplyReasoning(
      params,
      { enableReasoning: true },
      { ...baseModel, reasoningDialect: 'thinking-object' }
    );
    expect(field(params, 'thinking')).toEqual({ type: 'enabled' });
    expect(params.reasoning).toBeUndefined();
  });

  it('switches thinking-object off through reasoning.effort: none (DeepSeek, MiMo, Z.ai)', () => {
    const deepseek: Model = {
      ...baseModel,
      reasoningDialect: 'thinking-object',
      supportedReasoningEfforts: ['low', 'high', 'max'],
    };
    const off = responsesParams();
    client.testApplyReasoning(off, { enableReasoning: false, reasoningEffort: 'max' }, deepseek);
    expect(field(off, 'thinking')).toEqual({ type: 'disabled' });
    expect(off.reasoning).toEqual({ effort: 'none' });

    const on = responsesParams();
    client.testApplyReasoning(on, { enableReasoning: true, reasoningEffort: 'max' }, deepseek);
    expect(field(on, 'thinking')).toEqual({ type: 'enabled' });
    expect(on.reasoning).toEqual({ effort: 'max' });

    // No ladder (MiMo): `none` is still the off switch
    const mimoOff = responsesParams();
    client.testApplyReasoning(
      mimoOff,
      { enableReasoning: false },
      { ...baseModel, reasoningDialect: 'thinking-object' }
    );
    expect(mimoOff.reasoning).toEqual({ effort: 'none' });
  });

  it('sends GLM-5.3 effort as reasoning.effort beside thinking', () => {
    const glm53: Model = {
      ...baseModel,
      reasoningMode: 'always',
      reasoningDialect: 'thinking-object',
      supportedReasoningEfforts: ['low', 'high', 'max'],
    };
    const params = responsesParams();
    client.testApplyReasoning(params, { enableReasoning: true, reasoningEffort: 'max' }, glm53);
    expect(field(params, 'thinking')).toEqual({ type: 'enabled' });
    expect(params.reasoning).toEqual({ effort: 'max' });
    expect(field(params, 'reasoning_effort')).toBeUndefined();

    const off = responsesParams();
    client.testApplyReasoning(off, { enableReasoning: false, reasoningEffort: 'max' }, glm53);
    expect(off.reasoning).toEqual({ effort: 'low' });
  });

  it('honors enable-thinking', () => {
    const params = responsesParams();
    client.testApplyReasoning(
      params,
      { enableReasoning: false },
      { ...baseModel, reasoningDialect: 'enable-thinking' }
    );
    expect(field(params, 'enable_thinking')).toBe(false);
    expect(params.reasoning).toBeUndefined();
  });

  it('sends Qwen 3.8 effort beside enable_thinking, and no none when off', () => {
    const qwen38: Model = {
      ...baseModel,
      reasoningDialect: 'enable-thinking',
      supportedReasoningEfforts: ['low', 'medium', 'xhigh'],
    };
    const on = responsesParams();
    client.testApplyReasoning(on, { enableReasoning: true, reasoningEffort: 'xhigh' }, qwen38);
    expect(field(on, 'enable_thinking')).toBe(true);
    expect(on.reasoning).toEqual({ effort: 'xhigh' });

    const off = responsesParams();
    client.testApplyReasoning(off, { enableReasoning: false, reasoningEffort: 'xhigh' }, qwen38);
    expect(field(off, 'enable_thinking')).toBe(false);
    expect(off.reasoning).toBeUndefined();
  });

  it('ignores the openrouter dialect — this API has its own reasoning field', () => {
    const params = responsesParams();
    client.testApplyReasoning(
      params,
      { enableReasoning: true, reasoningEffort: 'high' },
      {
        ...baseModel,
        reasoningDialect: 'openrouter',
        supportedReasoningEfforts: ['low', 'medium', 'high'],
      }
    );
    expect(params.reasoning).toEqual({ effort: 'high', summary: undefined });
    expect(field(params, 'enable_thinking')).toBeUndefined();
  });

  it('never sends thinking: disabled to an always-reasoning model', () => {
    const params = responsesParams();
    client.testApplyReasoning(
      params,
      { enableReasoning: false },
      { ...baseModel, reasoningMode: 'always', reasoningDialect: 'thinking-object' }
    );
    expect(field(params, 'thinking')).toEqual({ type: 'enabled' });
  });

  it('sends reasoning.context: all_turns next to effort at -1', () => {
    const params = responsesParams();
    client.testApplyReasoning(
      params,
      { enableReasoning: true, reasoningEffort: 'high', thinkingKeepTurns: -1 },
      { ...baseModel, supportedReasoningEfforts: ['low', 'medium', 'high'] },
      undefined,
      'reasoning_context'
    );
    expect(params.reasoning).toEqual({ context: 'all_turns', effort: 'high', summary: undefined });
  });

  it('omits reasoning.context at 1', () => {
    const params = responsesParams();
    client.testApplyReasoning(
      params,
      { enableReasoning: true, reasoningEffort: 'high', thinkingKeepTurns: 1 },
      { ...baseModel, supportedReasoningEfforts: ['low', 'medium', 'high'] },
      undefined,
      'reasoning_context'
    );
    expect(params.reasoning).toEqual({ effort: 'high', summary: undefined });
  });

  it('keeps reasoning.context for an always-reasoning model with the toggle off', () => {
    const params = responsesParams();
    client.testApplyReasoning(
      params,
      { enableReasoning: false, reasoningEffort: 'high', thinkingKeepTurns: -1 },
      {
        ...baseModel,
        reasoningMode: 'always',
        supportedReasoningEfforts: ['low', 'medium', 'high'],
      },
      undefined,
      'reasoning_context'
    );
    // Still reasons, at its lowest level, and that reasoning still counts as history
    expect(params.reasoning).toEqual({ context: 'all_turns', effort: 'low' });
  });

  it('sends none, or the lowest level, as the effort when the toggle is off', () => {
    const optional = responsesParams();
    client.testApplyReasoning(
      optional,
      { enableReasoning: false, reasoningEffort: 'high' },
      { ...baseModel, supportedReasoningEfforts: ['none', 'low', 'medium', 'high'] }
    );
    expect(optional.reasoning).toEqual({ effort: 'none' });

    const always = responsesParams();
    client.testApplyReasoning(
      always,
      { enableReasoning: false, reasoningEffort: 'high' },
      { ...baseModel, reasoningMode: 'always', supportedReasoningEfforts: ['medium', 'high'] }
    );
    expect(always.reasoning).toEqual({ effort: 'medium' });

    const noLadder = responsesParams();
    client.testApplyReasoning(noLadder, { enableReasoning: false }, baseModel);
    expect(noLadder.reasoning).toBeUndefined();
  });

  it('sends Kimi K2.6 keep: all on this API too', () => {
    const params = responsesParams();
    client.testApplyReasoning(
      params,
      { enableReasoning: true, thinkingKeepTurns: -1 },
      { ...baseModel, reasoningDialect: 'thinking-object' },
      undefined,
      'thinking_keep'
    );
    expect(field(params, 'thinking')).toEqual({ type: 'enabled', keep: 'all' });
  });
});
