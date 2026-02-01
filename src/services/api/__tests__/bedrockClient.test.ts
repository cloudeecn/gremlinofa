import { describe, it, expect } from 'vitest';
import { detectBedrockReasoningType, buildReasoningConfig } from '../bedrockClient';

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
    it('detects deepseek-r1', () => {
      expect(detectBedrockReasoningType('deepseek.deepseek-r1-v1:0')).toBe('deepseek');
    });

    it('detects DeepSeek case-insensitive', () => {
      expect(detectBedrockReasoningType('DeepSeek.DeepSeek-R1-v1:0')).toBe('deepseek');
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
    it('builds showThinking config', () => {
      const result = buildReasoningConfig('deepseek', {
        enableReasoning: true,
        reasoningBudgetTokens: 1024,
      });
      expect(result).toEqual({
        showThinking: true,
      });
    });
  });
});
