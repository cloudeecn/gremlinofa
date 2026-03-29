import { describe, it, expect, beforeEach } from 'vitest';
import {
  getModelMetadataFor,
  clearModelKnowledgeCache,
  calculateCost,
  isCostUnreliable,
} from '../modelMetadata';
import type { APIDefinition, Model } from '../../../types';

// Helper to create test API definitions
function createApiDef(overrides: Partial<APIDefinition> = {}): APIDefinition {
  return {
    id: 'test-api-def',
    apiType: 'anthropic',
    name: 'Test API',
    baseUrl: '',
    apiKey: 'test-key',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('modelMetadata', () => {
  beforeEach(() => {
    clearModelKnowledgeCache();
  });

  describe('getModelMetadataFor', () => {
    describe('exact matching', () => {
      it('returns exact match for known OpenAI model', () => {
        const apiDef = createApiDef({ apiType: 'chatgpt' });
        const result = getModelMetadataFor(apiDef, 'gpt-4o');

        expect(result.id).toBe('gpt-4o');
        expect(result.name).toBe('gpt-4o');
        expect(result.apiType).toBe('chatgpt');
        expect(result.matchedMode).toBe('exact');
        expect(result.inputPrice).toBe(2.5);
        expect(result.outputPrice).toBe(10.0);
        expect(result.contextWindow).toBe(128000);
      });

      it('returns fuzz match for Anthropic model (no exact matches defined)', () => {
        const apiDef = createApiDef({ apiType: 'anthropic' });
        // Anthropic models only have fuzz patterns defined
        const result = getModelMetadataFor(apiDef, 'claude-opus-4-5-20250514');

        expect(result.matchedMode).toBe('fuzz');
        expect(result.inputPrice).toBe(5);
        expect(result.outputPrice).toBe(25);
      });

      it('returns exact match for o-series model with reasoning', () => {
        const apiDef = createApiDef({ apiType: 'responses_api' });
        const result = getModelMetadataFor(apiDef, 'o1');

        expect(result.matchedMode).toBe('exact');
        expect(result.reasoningMode).toBe('always');
        expect(result.supportedReasoningEfforts).toEqual(['low', 'medium', 'high']);
        expect(result.contextWindow).toBe(200000);
      });
    });

    describe('fuzz matching', () => {
      it('matches claude-sonnet-4-5-20250514 via prefix', () => {
        const apiDef = createApiDef({ apiType: 'anthropic' });
        const result = getModelMetadataFor(apiDef, 'claude-sonnet-4-5-20250514');

        expect(result.matchedMode).toBe('fuzz');
        expect(result.inputPrice).toBe(3);
        expect(result.outputPrice).toBe(15);
        expect(result.contextWindow).toBe(200000);
      });

      it('matches gpt-5-mini via prefix+postfix', () => {
        const apiDef = createApiDef({ apiType: 'chatgpt' });
        const result = getModelMetadataFor(apiDef, 'gpt-5-mini');

        expect(result.matchedMode).toBe('exact'); // Has exact match
        expect(result.inputPrice).toBe(0.25);
        expect(result.outputPrice).toBe(2.0);
      });

      it('matches gpt-5-mini-2025-01-15 via prefix+postfix fuzz', () => {
        const apiDef = createApiDef({ apiType: 'chatgpt' });
        const result = getModelMetadataFor(apiDef, 'gpt-5-mini-2025-01-15');

        // Should match gpt-5-mini entry via prefix "gpt-5" + postfix "-mini"
        expect(result.matchedMode).toBe('fuzz');
        expect(result.reasoningMode).toBe('always');
      });

      it('matches AWS Bedrock model via anthropic. prefix', () => {
        const apiDef = createApiDef({ apiType: 'anthropic' });
        const result = getModelMetadataFor(apiDef, 'anthropic.claude-sonnet-4-20250514');

        expect(result.matchedMode).toBe('fuzz');
        expect(result.inputPrice).toBe(3);
      });

      it('prioritizes more specific fuzz matches', () => {
        const apiDef = createApiDef({ apiType: 'chatgpt' });

        // gpt-5.2-codex should match the codex-specific entry, not base gpt-5.2
        const result = getModelMetadataFor(apiDef, 'gpt-5.2-codex');

        expect(result.matchedMode).toBe('exact'); // Has exact match
      });

      it('matches xAI grok models', () => {
        const apiDef = createApiDef({ apiType: 'chatgpt' });
        const result = getModelMetadataFor(apiDef, 'grok-4');

        expect(result.matchedMode).toBe('exact');
        expect(result.inputPrice).toBe(3.0);
        expect(result.outputPrice).toBe(15.0);
        expect(result.contextWindow).toBe(256000);
      });

      it('matches grok-3-mini with reasoning efforts', () => {
        const apiDef = createApiDef({ apiType: 'responses_api' });
        const result = getModelMetadataFor(apiDef, 'grok-3-mini');

        expect(result.matchedMode).toBe('exact');
        expect(result.reasoningMode).toBe('always');
        expect(result.supportedReasoningEfforts).toEqual(['low', 'high']);
      });
    });

    describe('default fallback', () => {
      it('returns default for unknown model', () => {
        const apiDef = createApiDef({ apiType: 'anthropic' });
        const result = getModelMetadataFor(apiDef, 'unknown-model-xyz');

        expect(result.id).toBe('unknown-model-xyz');
        expect(result.name).toBe('unknown-model-xyz');
        expect(result.apiType).toBe('anthropic');
        expect(result.matchedMode).toBe('default');
        expect(result.contextWindow).toBeUndefined();
        expect(result.inputPrice).toBeUndefined();
      });

      it('returns default for webllm api type (no models defined)', () => {
        const apiDef = createApiDef({ apiType: 'webllm' });
        const result = getModelMetadataFor(apiDef, 'llama-3-8b');

        expect(result.matchedMode).toBe('default');
        expect(result.contextWindow).toBeUndefined();
      });
    });

    describe('api type filtering', () => {
      it('does not match anthropic models for chatgpt api type', () => {
        const apiDef = createApiDef({ apiType: 'chatgpt' });
        // Claude models are defined only for anthropic apiType
        const result = getModelMetadataFor(apiDef, 'claude-sonnet-4-5-20250514');

        expect(result.matchedMode).toBe('default');
      });

      it('matches openai models for both chatgpt and responses_api', () => {
        const chatgptDef = createApiDef({ apiType: 'chatgpt' });
        const responsesDef = createApiDef({ id: 'responses-def', apiType: 'responses_api' });

        const chatgptResult = getModelMetadataFor(chatgptDef, 'gpt-4o');
        const responsesResult = getModelMetadataFor(responsesDef, 'gpt-4o');

        expect(chatgptResult.matchedMode).toBe('exact');
        expect(responsesResult.matchedMode).toBe('exact');
        expect(chatgptResult.inputPrice).toBe(responsesResult.inputPrice);
      });
    });

    describe('caching', () => {
      it('caches storage per api definition id', () => {
        const apiDef1 = createApiDef({ id: 'def-1', apiType: 'chatgpt' });
        const apiDef2 = createApiDef({ id: 'def-2', apiType: 'chatgpt' });

        // First call builds cache
        const result1a = getModelMetadataFor(apiDef1, 'gpt-4o');
        // Second call uses cache
        const result1b = getModelMetadataFor(apiDef1, 'gpt-4o');

        // Different definition builds separate cache
        const result2 = getModelMetadataFor(apiDef2, 'gpt-4o');

        expect(result1a).toEqual(result1b);
        expect(result1a).toEqual(result2);
      });

      it('clearModelKnowledgeCache clears specific cache', () => {
        const apiDef = createApiDef({ id: 'cached-def', apiType: 'chatgpt' });
        getModelMetadataFor(apiDef, 'gpt-4o');

        clearModelKnowledgeCache('cached-def');

        // Should rebuild cache without error
        const result = getModelMetadataFor(apiDef, 'gpt-4o');
        expect(result.matchedMode).toBe('exact');
      });

      it('clearModelKnowledgeCache clears all caches when no id', () => {
        const apiDef1 = createApiDef({ id: 'def-a', apiType: 'chatgpt' });
        const apiDef2 = createApiDef({ id: 'def-b', apiType: 'chatgpt' });

        getModelMetadataFor(apiDef1, 'gpt-4o');
        getModelMetadataFor(apiDef2, 'gpt-4o');

        clearModelKnowledgeCache();

        // Both should rebuild without error
        const r1 = getModelMetadataFor(apiDef1, 'gpt-4o');
        const r2 = getModelMetadataFor(apiDef2, 'gpt-4o');
        expect(r1.matchedMode).toBe('exact');
        expect(r2.matchedMode).toBe('exact');
      });
    });

    describe('supportsExtendedContext', () => {
      it('returns supportsExtendedContext for Opus 4.6', () => {
        const apiDef = createApiDef({ apiType: 'anthropic' });
        const result = getModelMetadataFor(apiDef, 'claude-opus-4-6-20260101');

        expect(result.supportsExtendedContext).toBe(true);
      });

      it('returns supportsExtendedContext for Sonnet 4.5', () => {
        const apiDef = createApiDef({ apiType: 'anthropic' });
        const result = getModelMetadataFor(apiDef, 'claude-sonnet-4-5-20250514');

        expect(result.supportsExtendedContext).toBe(true);
      });

      it('returns supportsExtendedContext for Sonnet 4', () => {
        const apiDef = createApiDef({ apiType: 'anthropic' });
        const result = getModelMetadataFor(apiDef, 'claude-sonnet-4-20250514');

        expect(result.supportsExtendedContext).toBe(true);
      });

      it('does not return supportsExtendedContext for Haiku 4.5', () => {
        const apiDef = createApiDef({ apiType: 'anthropic' });
        const result = getModelMetadataFor(apiDef, 'claude-haiku-4-5-20250101');

        expect(result.supportsExtendedContext).toBeFalsy();
      });

      it('does not return supportsExtendedContext for 3.5 Sonnet', () => {
        const apiDef = createApiDef({ apiType: 'anthropic' });
        const result = getModelMetadataFor(apiDef, 'claude-3-5-sonnet-20241022');

        expect(result.supportsExtendedContext).toBeFalsy();
      });

      it('does not return supportsExtendedContext for OpenAI models', () => {
        const apiDef = createApiDef({ apiType: 'chatgpt' });
        const result = getModelMetadataFor(apiDef, 'gpt-4o');

        expect(result.supportsExtendedContext).toBeFalsy();
      });

      it('returns supportsExtendedContext for Bedrock Opus 4.6 foundation model', () => {
        const apiDef = createApiDef({ apiType: 'anthropic' });
        const result = getModelMetadataFor(apiDef, 'anthropic.claude-opus-4-6-20250514-v1:0');

        expect(result.supportsExtendedContext).toBe(true);
      });

      it('returns supportsExtendedContext for Bedrock Sonnet 4.6 foundation model', () => {
        const apiDef = createApiDef({ apiType: 'anthropic' });
        const result = getModelMetadataFor(apiDef, 'anthropic.claude-sonnet-4-6-20250514-v1:0');

        expect(result.supportsExtendedContext).toBe(true);
      });

      it('returns supportsExtendedContext for Bedrock Sonnet 4.5 foundation model', () => {
        const apiDef = createApiDef({ apiType: 'anthropic' });
        const result = getModelMetadataFor(apiDef, 'anthropic.claude-sonnet-4-5-20250514-v1:0');

        expect(result.supportsExtendedContext).toBe(true);
      });
    });

    describe('deep cloning', () => {
      it('returns independent objects for same model', () => {
        const apiDef = createApiDef({ apiType: 'chatgpt' });
        const result1 = getModelMetadataFor(apiDef, 'gpt-4o');
        const result2 = getModelMetadataFor(apiDef, 'gpt-4o');

        // Modify one result
        result1.inputPrice = 999;

        // Other result should be unaffected
        expect(result2.inputPrice).toBe(2.5);
      });
    });

    describe('provider prefix stripping', () => {
      it('matches openai/gpt-4o via exact match after stripping prefix', () => {
        const apiDef = createApiDef({ apiType: 'chatgpt' });
        const result = getModelMetadataFor(apiDef, 'openai/gpt-4o');

        expect(result.id).toBe('openai/gpt-4o');
        expect(result.matchedMode).toBe('exact');
        expect(result.inputPrice).toBe(2.5);
      });

      it('matches openai/gpt-5.4-2025-xx via fuzz after stripping prefix', () => {
        const apiDef = createApiDef({ apiType: 'chatgpt' });
        const result = getModelMetadataFor(apiDef, 'openai/gpt-5.4-2025-01-01');

        expect(result.id).toBe('openai/gpt-5.4-2025-01-01');
        expect(result.matchedMode).toBe('fuzz');
        expect(result.inputPrice).toBe(2.5);
      });

      it('matches anthropic/claude-sonnet-4-5-20250514 via fuzz after stripping prefix', () => {
        const apiDef = createApiDef({ apiType: 'anthropic' });
        const result = getModelMetadataFor(apiDef, 'anthropic/claude-sonnet-4-5-20250514');

        expect(result.id).toBe('anthropic/claude-sonnet-4-5-20250514');
        expect(result.matchedMode).toBe('fuzz');
        expect(result.inputPrice).toBe(3);
      });

      it('matches xai/grok-4 via exact match after stripping prefix', () => {
        const apiDef = createApiDef({ apiType: 'chatgpt' });
        const result = getModelMetadataFor(apiDef, 'xai/grok-4');

        expect(result.id).toBe('xai/grok-4');
        expect(result.matchedMode).toBe('exact');
        expect(result.inputPrice).toBe(3.0);
      });

      it('prefers direct match over prefix-stripped match', () => {
        const apiDef = createApiDef({ apiType: 'chatgpt' });
        const direct = getModelMetadataFor(apiDef, 'gpt-4o');
        const prefixed = getModelMetadataFor(apiDef, 'openai/gpt-4o');

        expect(direct.matchedMode).toBe('exact');
        expect(prefixed.matchedMode).toBe('exact');
        expect(direct.inputPrice).toBe(prefixed.inputPrice);
      });

      it('does not strip when no slash present', () => {
        const apiDef = createApiDef({ apiType: 'chatgpt' });
        const result = getModelMetadataFor(apiDef, 'unknown-model-xyz');

        expect(result.matchedMode).toBe('default');
      });

      it('does not strip when slash is at position 0', () => {
        const apiDef = createApiDef({ apiType: 'chatgpt' });
        const result = getModelMetadataFor(apiDef, '/gpt-4o');

        expect(result.matchedMode).toBe('default');
      });
    });
  });

  // Helper to create test models
  function createModel(overrides: Partial<Model> = {}): Model {
    return {
      id: 'test-model',
      name: 'Test Model',
      apiType: 'anthropic',
      matchedMode: 'exact',
      inputPrice: 5,
      outputPrice: 25,
      ...overrides,
    };
  }

  describe('calculateCost', () => {
    it('calculates basic input/output cost', () => {
      const model = createModel({ inputPrice: 5, outputPrice: 25 });
      const cost = calculateCost(model, 1_000_000, 100_000);
      expect(cost).toBeCloseTo(5 + 2.5);
    });

    it('uses cacheWritePrice when available', () => {
      const model = createModel({ inputPrice: 5, cacheWritePrice: 6.25 });
      const cost = calculateCost(model, 0, 0, 0, 1_000_000, 0);
      expect(cost).toBeCloseTo(6.25);
    });

    it('uses cacheReadPrice when available', () => {
      const model = createModel({ inputPrice: 5, cacheReadPrice: 0.5 });
      const cost = calculateCost(model, 0, 0, 0, 0, 1_000_000);
      expect(cost).toBeCloseTo(0.5);
    });

    it('falls back to inputPrice for cache write when cacheWritePrice is missing', () => {
      const model = createModel({ inputPrice: 5 });
      const cost = calculateCost(model, 0, 0, 0, 1_000_000, 0);
      expect(cost).toBeCloseTo(5);
    });

    it('falls back to inputPrice for cache read when cacheReadPrice is missing', () => {
      const model = createModel({ inputPrice: 5 });
      const cost = calculateCost(model, 0, 0, 0, 0, 1_000_000);
      expect(cost).toBeCloseTo(5);
    });

    it('prefers cache-specific price over inputPrice fallback', () => {
      const model = createModel({ inputPrice: 5, cacheReadPrice: 0.5, cacheWritePrice: 6.25 });
      const cost = calculateCost(model, 0, 0, 0, 1_000_000, 1_000_000);
      expect(cost).toBeCloseTo(6.25 + 0.5);
    });

    it('handles zero cache tokens without adding cost', () => {
      const model = createModel({ inputPrice: 5 });
      const cost = calculateCost(model, 0, 0, 0, 0, 0);
      expect(cost).toBe(0);
    });
  });

  describe('isCostUnreliable', () => {
    it('returns false for model with all prices defined', () => {
      const model = createModel({
        inputPrice: 5,
        outputPrice: 25,
        cacheWritePrice: 6.25,
        cacheReadPrice: 0.5,
      });
      expect(isCostUnreliable(model, 100, 50, 0, 100, 100)).toBe(false);
    });

    it('returns false when cache prices missing but inputPrice exists', () => {
      const model = createModel({ inputPrice: 5, outputPrice: 25 });
      expect(isCostUnreliable(model, 100, 50, 0, 100, 100)).toBe(false);
    });

    it('returns true when cache tokens present and both cache price and inputPrice missing', () => {
      const model = createModel({ inputPrice: undefined, outputPrice: 25 });
      expect(isCostUnreliable(model, 0, 50, 0, 100, 0)).toBe(true);
    });

    it('returns true for default matchedMode regardless of tokens', () => {
      const model = createModel({ matchedMode: 'default' });
      expect(isCostUnreliable(model, 0, 0)).toBe(true);
      expect(isCostUnreliable(model, 100, 0)).toBe(true);
    });
  });
});
