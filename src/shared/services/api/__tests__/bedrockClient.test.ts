import { describe, it, expect, vi } from 'vitest';
import type { APIDefinition } from '../../../protocol/types';
import { BedrockClient, detectBedrockReasoningType, buildReasoningConfig } from '../bedrockClient';
import { stubApiDeps } from './testStubs';

const { mockRuntimeSend } = vi.hoisted(() => ({ mockRuntimeSend: vi.fn() }));
vi.mock('@aws-sdk/client-bedrock-runtime', async importOriginal => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-bedrock-runtime')>();
  return {
    ...actual,
    BedrockRuntimeClient: class {
      send = mockRuntimeSend;
    },
  };
});

describe('detectBedrockReasoningType', () => {
  describe('Claude 3.x models', () => {
    it('detects claude-3-5-sonnet raw modelId', () => {
      expect(detectBedrockReasoningType('anthropic.claude-3-5-sonnet-20241022-v2:0')).toBe(
        'claude-3'
      );
    });

    it('detects claude-3-haiku raw modelId', () => {
      expect(detectBedrockReasoningType('anthropic.claude-3-haiku-20240307-v1:0')).toBe('claude-3');
    });

    it('detects claude-3-opus raw modelId', () => {
      expect(detectBedrockReasoningType('anthropic.claude-3-opus-20240229-v1:0')).toBe('claude-3');
    });

    it('detects claude-3-5-sonnet inference profile', () => {
      expect(detectBedrockReasoningType('us.anthropic.claude-3-5-sonnet-20241022-v2:0')).toBe(
        'claude-3'
      );
    });
  });

  describe('Claude 4+ models', () => {
    it('detects claude-4 raw modelId', () => {
      expect(detectBedrockReasoningType('anthropic.claude-4-20250514-v1:0')).toBe('claude-4');
    });

    it('detects claude-sonnet-4 raw modelId', () => {
      expect(detectBedrockReasoningType('anthropic.claude-sonnet-4-20250514-v1:0')).toBe(
        'claude-4'
      );
    });

    it('detects claude-opus-4 raw modelId', () => {
      expect(detectBedrockReasoningType('anthropic.claude-opus-4-20250514-v1:0')).toBe('claude-4');
    });

    it('detects claude-sonnet-4 inference profile', () => {
      expect(detectBedrockReasoningType('us.anthropic.claude-sonnet-4-20250514-v1:0')).toBe(
        'claude-4'
      );
    });

    it('detects claude-opus-4 inference profile', () => {
      expect(detectBedrockReasoningType('eu.anthropic.claude-opus-4-20250514-v1:0')).toBe(
        'claude-4'
      );
    });
  });

  describe('Nova 2 models (with reasoning support)', () => {
    it('detects nova-2-lite', () => {
      expect(detectBedrockReasoningType('amazon.nova-2-lite-v1:0')).toBe('nova2');
    });

    it('detects nova-2-pro', () => {
      expect(detectBedrockReasoningType('amazon.nova-2-pro-v1:0')).toBe('nova2');
    });

    it('detects nova-2 inference profile', () => {
      expect(detectBedrockReasoningType('us.amazon.nova-2-premier-v1:0')).toBe('nova2');
    });
  });

  describe('Nova 1 models (no reasoning support)', () => {
    it('returns none for nova-pro', () => {
      expect(detectBedrockReasoningType('amazon.nova-pro-v1:0')).toBe('none');
    });

    it('returns none for nova-lite', () => {
      expect(detectBedrockReasoningType('amazon.nova-lite-v1:0')).toBe('none');
    });

    it('returns none for nova-premier', () => {
      expect(detectBedrockReasoningType('us.amazon.nova-premier-v1:0')).toBe('none');
    });
  });

  describe('DeepSeek models', () => {
    it('detects deepseek-r1 via deepseek.r1 pattern', () => {
      expect(detectBedrockReasoningType('deepseek.r1-v1:0')).toBe('deepseek');
    });

    it('detects deepseek-r1 case-insensitive', () => {
      expect(detectBedrockReasoningType('DeepSeek.R1-v1:0')).toBe('deepseek');
    });

    it('falls back to generic-reasoning for other deepseek models', () => {
      expect(detectBedrockReasoningType('deepseek.deepseek-r1-v1:0')).toBe('generic-reasoning');
      expect(detectBedrockReasoningType('DeepSeek.DeepSeek-R1-v1:0')).toBe('generic-reasoning');
    });
  });

  describe('Unknown models', () => {
    it('returns none for Llama models', () => {
      expect(detectBedrockReasoningType('meta.llama3-70b-instruct-v1:0')).toBe('none');
    });

    it('returns none for Mistral models', () => {
      expect(detectBedrockReasoningType('mistral.mistral-large-2407-v1:0')).toBe('none');
    });

    it('returns none for unknown provider', () => {
      expect(detectBedrockReasoningType('unknown.model-v1:0')).toBe('none');
    });
  });
});

describe('buildReasoningConfig', () => {
  describe('when reasoning is disabled', () => {
    it('returns undefined when enableReasoning is false', () => {
      const result = buildReasoningConfig('claude-3', {
        enableReasoning: false,
        reasoningBudgetTokens: 1024,
      });
      expect(result).toBeUndefined();
    });

    it('returns undefined for none model type', () => {
      const result = buildReasoningConfig('none', {
        enableReasoning: true,
        reasoningBudgetTokens: 1024,
      });
      expect(result).toBeUndefined();
    });
  });

  describe('Claude 3.x config', () => {
    it('builds thinking config with budget', () => {
      const result = buildReasoningConfig('claude-3', {
        enableReasoning: true,
        reasoningBudgetTokens: 2048,
      });
      expect(result).toEqual({
        thinking: {
          type: 'enabled',
          budget_tokens: 2048,
        },
      });
    });
  });

  describe('Claude 4+ config', () => {
    it('builds reasoning_config with budget and context_management (default keep all)', () => {
      const result = buildReasoningConfig('claude-4', {
        enableReasoning: true,
        reasoningBudgetTokens: 4096,
      });
      expect(result).toEqual({
        reasoning_config: {
          type: 'enabled',
          budget_tokens: 4096,
        },
        anthropic_beta: ['interleaved-thinking-2025-05-14', 'context-management-2025-06-27'],
        context_management: {
          edits: [
            {
              type: 'clear_thinking_20251015',
              keep: { type: 'all' },
            },
          ],
        },
      });
    });

    it('builds reasoning_config with thinkingKeepTurns=-1 (keep all)', () => {
      const result = buildReasoningConfig('claude-4', {
        enableReasoning: true,
        reasoningBudgetTokens: 4096,
        thinkingKeepTurns: -1,
      });
      expect(result).toEqual({
        reasoning_config: {
          type: 'enabled',
          budget_tokens: 4096,
        },
        anthropic_beta: ['interleaved-thinking-2025-05-14', 'context-management-2025-06-27'],
        context_management: {
          edits: [
            {
              type: 'clear_thinking_20251015',
              keep: { type: 'all' },
            },
          ],
        },
      });
    });

    it('builds reasoning_config with thinkingKeepTurns=0 (keep 0 turns)', () => {
      const result = buildReasoningConfig('claude-4', {
        enableReasoning: true,
        reasoningBudgetTokens: 4096,
        thinkingKeepTurns: 0,
      });
      expect(result).toEqual({
        reasoning_config: {
          type: 'enabled',
          budget_tokens: 4096,
        },
        anthropic_beta: ['interleaved-thinking-2025-05-14', 'context-management-2025-06-27'],
        context_management: {
          edits: [
            {
              type: 'clear_thinking_20251015',
              keep: { type: 'thinking_turns', value: 0 },
            },
          ],
        },
      });
    });

    it('builds reasoning_config with thinkingKeepTurns=3 (keep 3 turns)', () => {
      const result = buildReasoningConfig('claude-4', {
        enableReasoning: true,
        reasoningBudgetTokens: 4096,
        thinkingKeepTurns: 3,
      });
      expect(result).toEqual({
        reasoning_config: {
          type: 'enabled',
          budget_tokens: 4096,
        },
        anthropic_beta: ['interleaved-thinking-2025-05-14', 'context-management-2025-06-27'],
        context_management: {
          edits: [
            {
              type: 'clear_thinking_20251015',
              keep: { type: 'thinking_turns', value: 3 },
            },
          ],
        },
      });
    });
  });

  describe('Claude 4+ with the toggle off', () => {
    it('switches off a model that thinks by default (Opus 5, Sonnet 5)', () => {
      const result = buildReasoningConfig('claude-4', {
        enableReasoning: false,
        reasoningBudgetTokens: 0,
        reasoningEffort: 'max',
        thinkingOffType: 'disabled',
      });
      expect(result).toEqual({ reasoning_config: { type: 'disabled' } });
    });

    it('asks an always-on model for its lowest effort (Opus 5.5)', () => {
      const result = buildReasoningConfig('claude-4', {
        enableReasoning: false,
        reasoningBudgetTokens: 0,
        reasoningMode: 'always',
        supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      });
      expect(result).toEqual({ output_config: { effort: 'low' } });
    });

    it('sends nothing to a model whose default is off', () => {
      expect(
        buildReasoningConfig('claude-4', { enableReasoning: false, reasoningBudgetTokens: 0 })
      ).toBeUndefined();
    });
  });

  describe('Claude effort in budget mode', () => {
    it('sends effort beside budget_tokens on a model without adaptive (Opus 4.5)', () => {
      const result = buildReasoningConfig('claude-4', {
        enableReasoning: true,
        reasoningBudgetTokens: 4096,
        reasoningEffort: 'medium',
        supportedReasoningEfforts: ['low', 'medium', 'high'],
      }) as Record<string, unknown>;
      expect(result.reasoning_config).toEqual({ type: 'enabled', budget_tokens: 4096 });
      expect(result.output_config).toEqual({ effort: 'medium' });
    });

    it('leaves the deprecated 4.6 budget path without effort', () => {
      const result = buildReasoningConfig('claude-4', {
        enableReasoning: true,
        reasoningBudgetTokens: 4096,
        reasoningEffort: 'medium',
        supportsAdaptiveReasoning: true,
        supportedReasoningEfforts: ['low', 'medium', 'high', 'max'],
      }) as Record<string, unknown>;
      expect(result.reasoning_config).toEqual({ type: 'enabled', budget_tokens: 4096 });
      expect(result.output_config).toBeUndefined();
    });
  });

  describe('Nova 2 config', () => {
    it('builds reasoningConfig with default medium effort', () => {
      const result = buildReasoningConfig('nova2', {
        enableReasoning: true,
        reasoningBudgetTokens: 1024,
      });
      expect(result).toEqual({
        reasoningConfig: {
          type: 'enabled',
          maxReasoningEffort: 'medium',
        },
      });
    });

    it('maps none effort to low', () => {
      const result = buildReasoningConfig('nova2', {
        enableReasoning: true,
        reasoningBudgetTokens: 1024,
        reasoningEffort: 'none',
      });
      expect(result).toEqual({
        reasoningConfig: {
          type: 'enabled',
          maxReasoningEffort: 'low',
        },
      });
    });

    it('maps minimal effort to low', () => {
      const result = buildReasoningConfig('nova2', {
        enableReasoning: true,
        reasoningBudgetTokens: 1024,
        reasoningEffort: 'minimal',
      });
      expect(result).toEqual({
        reasoningConfig: {
          type: 'enabled',
          maxReasoningEffort: 'low',
        },
      });
    });

    it('maps low effort to low', () => {
      const result = buildReasoningConfig('nova2', {
        enableReasoning: true,
        reasoningBudgetTokens: 1024,
        reasoningEffort: 'low',
      });
      expect(result).toEqual({
        reasoningConfig: {
          type: 'enabled',
          maxReasoningEffort: 'low',
        },
      });
    });

    it('maps medium effort to medium', () => {
      const result = buildReasoningConfig('nova2', {
        enableReasoning: true,
        reasoningBudgetTokens: 1024,
        reasoningEffort: 'medium',
      });
      expect(result).toEqual({
        reasoningConfig: {
          type: 'enabled',
          maxReasoningEffort: 'medium',
        },
      });
    });

    it('maps high effort to high', () => {
      const result = buildReasoningConfig('nova2', {
        enableReasoning: true,
        reasoningBudgetTokens: 1024,
        reasoningEffort: 'high',
      });
      expect(result).toEqual({
        reasoningConfig: {
          type: 'enabled',
          maxReasoningEffort: 'high',
        },
      });
    });

    it('maps xhigh effort to high', () => {
      const result = buildReasoningConfig('nova2', {
        enableReasoning: true,
        reasoningBudgetTokens: 1024,
        reasoningEffort: 'xhigh',
      });
      expect(result).toEqual({
        reasoningConfig: {
          type: 'enabled',
          maxReasoningEffort: 'high',
        },
      });
    });
  });

  describe('DeepSeek config', () => {
    it('builds reasoning_config with showThinking', () => {
      const result = buildReasoningConfig('deepseek', {
        enableReasoning: true,
        reasoningBudgetTokens: 1024,
      });
      expect(result).toEqual({
        reasoning_config: 'medium',
        showThinking: true,
      });
    });

    it('maps effort to reasoning_config', () => {
      const result = buildReasoningConfig('deepseek', {
        enableReasoning: true,
        reasoningBudgetTokens: 1024,
        reasoningEffort: 'high',
      });
      expect(result).toEqual({
        reasoning_config: 'high',
        showThinking: true,
      });
    });
  });

  describe('generic-reasoning config', () => {
    it('builds reasoning_config with effort', () => {
      const result = buildReasoningConfig('generic-reasoning', {
        enableReasoning: true,
        reasoningBudgetTokens: 1024,
      });
      expect(result).toEqual({
        reasoning_config: 'medium',
      });
    });

    it('maps effort levels', () => {
      expect(
        buildReasoningConfig('generic-reasoning', {
          enableReasoning: true,
          reasoningBudgetTokens: 1024,
          reasoningEffort: 'low',
        })
      ).toEqual({ reasoning_config: 'low' });

      expect(
        buildReasoningConfig('generic-reasoning', {
          enableReasoning: true,
          reasoningBudgetTokens: 1024,
          reasoningEffort: 'xhigh',
        })
      ).toEqual({ reasoning_config: 'high' });
    });
  });

  describe('Claude 4+ adaptive mode (output_config effort mapping)', () => {
    const NO_XHIGH = ['low', 'medium', 'high', 'max'] as const; // 4.6-class
    const ALL_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const; // 4.7+

    const baseAdaptive = {
      enableReasoning: true,
      reasoningBudgetTokens: 0,
      thinkingKeepTurns: -1,
      supportsAdaptiveReasoning: true,
    } as const;

    it('on 4.6-class (no xhigh): xhigh escalates to max', () => {
      const result = buildReasoningConfig('claude-4', {
        ...baseAdaptive,
        supportedReasoningEfforts: NO_XHIGH,
        reasoningEffort: 'xhigh',
      }) as { output_config?: { effort: string } };
      expect(result.output_config).toEqual({ effort: 'max' });
    });

    it('on 4.6-class: max maps to max', () => {
      const result = buildReasoningConfig('claude-4', {
        ...baseAdaptive,
        supportedReasoningEfforts: NO_XHIGH,
        reasoningEffort: 'max',
      }) as { output_config?: { effort: string } };
      expect(result.output_config).toEqual({ effort: 'max' });
    });

    it('on 4.7-class: xhigh stays xhigh', () => {
      const result = buildReasoningConfig('claude-4', {
        ...baseAdaptive,
        supportedReasoningEfforts: ALL_LEVELS,
        reasoningEffort: 'xhigh',
      }) as { output_config?: { effort: string } };
      expect(result.output_config).toEqual({ effort: 'xhigh' });
    });

    it('on 4.7-class: max maps to max', () => {
      const result = buildReasoningConfig('claude-4', {
        ...baseAdaptive,
        supportedReasoningEfforts: ALL_LEVELS,
        reasoningEffort: 'max',
      }) as { output_config?: { effort: string } };
      expect(result.output_config).toEqual({ effort: 'max' });
    });

    it('omits output_config when the model advertises no configurable effort', () => {
      const empty = buildReasoningConfig('claude-4', {
        ...baseAdaptive,
        supportedReasoningEfforts: [],
        reasoningEffort: 'high',
      }) as { output_config?: { effort: string } };
      expect(empty.output_config).toBeUndefined();

      const absent = buildReasoningConfig('claude-4', {
        ...baseAdaptive,
        reasoningEffort: 'high',
      }) as { output_config?: { effort: string } };
      expect(absent.output_config).toBeUndefined();
    });

    it('onlyAdaptiveReasoning forces adaptive even with a non-zero budget', () => {
      const result = buildReasoningConfig('claude-4', {
        enableReasoning: true,
        reasoningBudgetTokens: 4096,
        thinkingKeepTurns: -1,
        supportsAdaptiveReasoning: true,
        onlyAdaptiveReasoning: true,
        supportedReasoningEfforts: ALL_LEVELS,
        reasoningEffort: 'xhigh',
      }) as { reasoning_config?: { type: string }; output_config?: { effort: string } };
      expect(result.reasoning_config).toEqual({ type: 'adaptive' });
      expect(result.output_config).toEqual({ effort: 'xhigh' });
    });
  });

  describe('thinking.display (reasoningSummary → summarized)', () => {
    it('claude-4 adaptive with reasoningSummary set adds display:summarized', () => {
      const result = buildReasoningConfig('claude-4', {
        enableReasoning: true,
        reasoningBudgetTokens: 0,
        thinkingKeepTurns: -1,
        supportsAdaptiveReasoning: true,
        reasoningSummary: 'auto',
      }) as { reasoning_config?: { type: string; display?: string } };
      expect(result.reasoning_config).toEqual({ type: 'adaptive', display: 'summarized' });
    });

    it('claude-4 adaptive without reasoningSummary omits display', () => {
      const result = buildReasoningConfig('claude-4', {
        enableReasoning: true,
        reasoningBudgetTokens: 0,
        thinkingKeepTurns: -1,
        supportsAdaptiveReasoning: true,
      }) as { reasoning_config?: { type: string; display?: string } };
      expect(result.reasoning_config).toEqual({ type: 'adaptive' });
    });

    it('claude-4 enabled with reasoningSummary set adds display:summarized', () => {
      const result = buildReasoningConfig('claude-4', {
        enableReasoning: true,
        reasoningBudgetTokens: 4096,
        thinkingKeepTurns: -1,
        reasoningSummary: 'detailed',
      }) as { reasoning_config?: { type: string; budget_tokens?: number; display?: string } };
      expect(result.reasoning_config).toEqual({
        type: 'enabled',
        budget_tokens: 4096,
        display: 'summarized',
      });
    });

    it('claude-3 thinking inherits display', () => {
      const result = buildReasoningConfig('claude-3', {
        enableReasoning: true,
        reasoningBudgetTokens: 2048,
        reasoningSummary: 'auto',
      }) as { thinking?: { type: string; display?: string } };
      expect(result.thinking).toMatchObject({ type: 'enabled', display: 'summarized' });
    });
  });
});

describe('BedrockClient stream termination', () => {
  const client = new BedrockClient(stubApiDeps);
  const apiDef = {
    id: 'b1',
    name: 'Test Bedrock',
    apiType: 'bedrock',
    apiKey: 'k',
  } as APIDefinition;

  const runStream = async (events: object[]) => {
    mockRuntimeSend.mockResolvedValueOnce({
      stream: (async function* () {
        yield* events;
      })(),
    });
    const messages: Parameters<typeof client.sendMessageStream>[0] = [
      { id: 'msg1', role: 'user', content: { type: 'text', content: 'Hi' }, timestamp: new Date() },
    ];
    const generator = client.sendMessageStream(messages, 'amazon.nova-pro-v1:0', apiDef, {
      maxTokens: 2048,
      enableReasoning: false,
      reasoningBudgetTokens: 0,
      signal: new AbortController().signal,
    });
    let next = await generator.next();
    while (!next.done) next = await generator.next();
    return next.value;
  };

  const textEvents = [
    { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'Half an ans' } } },
    { contentBlockStop: { contentBlockIndex: 0 } },
  ];
  const toolEvents = [
    {
      contentBlockStart: {
        contentBlockIndex: 1,
        start: { toolUse: { toolUseId: 'tu_1', name: 'ping' } },
      },
    },
    { contentBlockDelta: { contentBlockIndex: 1, delta: { toolUse: { input: '{"ho' } } } },
  ];

  it('errors on a stream that never sent messageStop, dropping partial tool calls', async () => {
    const result = await runStream([...textEvents, ...toolEvents]);

    expect(result.error?.message).toBe('Stream ended before messageStop');
    expect(result.textContent).toBe('Half an ans');
    expect(result.fullContent.some(block => 'toolUse' in block)).toBe(false);
  });

  it('passes the messageStop reason through', async () => {
    const result = await runStream([...textEvents, { messageStop: { stopReason: 'max_tokens' } }]);

    expect(result.error).toBeUndefined();
    expect(result.stopReason).toBe('max_tokens');
  });
});
