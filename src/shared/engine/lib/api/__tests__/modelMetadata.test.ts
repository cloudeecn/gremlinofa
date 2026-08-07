import { describe, it, expect, beforeEach } from 'vitest';
import {
  getModelMetadataFor,
  clearModelKnowledgeCache,
  calculateCost,
  isCostUnreliable,
} from '../modelMetadata';
import type { APIDefinition, Model } from '../../../../protocol/types';

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

      it('matches gemini-3.6-flash via prefix without hitting the 3.5 entry', () => {
        const apiDef = createApiDef({ apiType: 'google' });
        const result = getModelMetadataFor(apiDef, 'gemini-3.6-flash');

        expect(result.matchedMode).toBe('fuzz');
        expect(result.inputPrice).toBe(1.5);
        expect(result.outputPrice).toBe(7.5);
        expect(result.cacheReadPrice).toBe(0.15);
        expect(result.contextWindow).toBe(1048576);
        expect(result.maxOutputTokens).toBe(65536);
      });

      it('matches AWS Bedrock model via anthropic. prefix', () => {
        const apiDef = createApiDef({ apiType: 'anthropic' });
        const result = getModelMetadataFor(apiDef, 'anthropic.claude-sonnet-4-20250514');

        expect(result.matchedMode).toBe('fuzz');
        expect(result.inputPrice).toBe(3);
      });

      it('resolves claude-opus-4-8 to its own entry, not the claude-opus catch-all', () => {
        const apiDef = createApiDef({ apiType: 'anthropic' });
        // The opus-4-8 entry carries the `claude-opus` catch-all in a separate
        // low-specificity match, so 4-8's dedicated specific match wins. Its
        // onlyAdaptiveReasoning flag and xhigh support (both absent on opus-4-6)
        // prove which entry hit.
        for (const id of ['claude-opus-4-8', 'claude-opus-4-8-20260301']) {
          const result = getModelMetadataFor(apiDef, id);
          expect(result.matchedMode).toBe('fuzz');
          expect(result.onlyAdaptiveReasoning).toBe(true);
          expect(result.supportedReasoningEfforts).toEqual([
            'low',
            'medium',
            'high',
            'xhigh',
            'max',
          ]);
          expect(result.maxOutputTokens).toBe(128000);
        }

        // Sanity: opus-4-6 lacks those flags, so the assertions above can't pass by accident
        const opus46 = getModelMetadataFor(apiDef, 'claude-opus-4-6-20260101');
        expect(opus46.onlyAdaptiveReasoning).toBeUndefined();
      });

      it('flags supportsVerbosity on the GPT-5 family only', () => {
        const apiDef = createApiDef({ apiType: 'responses_api' });

        for (const id of ['gpt-5', 'gpt-5-mini', 'gpt-5.1-codex', 'gpt-5.2', 'gpt-5.6']) {
          expect(getModelMetadataFor(apiDef, id).supportsVerbosity).toBe(true);
        }

        // Pre-GPT-5 models reject the param, and gpt-5-search-api is left off
        // deliberately (search endpoints are picky about sampling params).
        for (const id of ['gpt-4o', 'gpt-4.1', 'o3', 'o4-mini', 'gpt-5-search-api']) {
          expect(getModelMetadataFor(apiDef, id).supportsVerbosity).toBeUndefined();
        }
      });

      it('routes an unknown future opus to the adaptive-only 4.8 entry via catch-all', () => {
        const apiDef = createApiDef({ apiType: 'anthropic' });

        // The likely next minor and a hypothetical major bump both fall through
        // to the 4.8 catch-all rather than the legacy $15/$75 base entry.
        for (const id of ['claude-opus-4-9-20270101', 'claude-opus-5']) {
          const result = getModelMetadataFor(apiDef, id);
          expect(result.matchedMode).toBe('fuzz');
          expect(result.inputPrice).toBe(5);
          expect(result.outputPrice).toBe(25);
          expect(result.onlyAdaptiveReasoning).toBe(true);
          expect(result.supportedReasoningEfforts).toEqual([
            'low',
            'medium',
            'high',
            'xhigh',
            'max',
          ]);
        }
      });

      it('carries the documented effort ladder per Claude model', () => {
        const apiDef = createApiDef({ apiType: 'anthropic' });
        const ALL = ['low', 'medium', 'high', 'xhigh', 'max'];
        const NO_XHIGH = ['low', 'medium', 'high', 'max'];

        // xhigh is a curated list: Fable 5, Opus 5/4.8/4.7, Sonnet 5.
        // max additionally covers Opus 4.6 and Sonnet 4.6.
        const cases: [string, string[] | undefined][] = [
          ['claude-fable-5', ALL],
          ['claude-opus-4-8', ALL],
          ['claude-opus-5', ALL], // via the claude-opus catch-all
          ['claude-opus-4-7', ALL],
          ['claude-sonnet-5', ALL],
          ['claude-opus-4-6', NO_XHIGH],
          ['claude-sonnet-4-6', NO_XHIGH],
          ['claude-haiku-5', NO_XHIGH],
          // Effort is unsupported below the 4.6 generation (Opus 4.5 takes it,
          // but only outside adaptive mode, so it is deliberately unannotated).
          ['claude-opus-4-5', undefined],
          ['claude-sonnet-4-5', undefined],
          ['claude-haiku-4-5', undefined],
          ['claude-3-5-sonnet', undefined],
        ];

        for (const [id, expected] of cases) {
          expect(getModelMetadataFor(apiDef, id).supportedReasoningEfforts, id).toEqual(expected);
        }
      });

      it('resolves legacy Opus 4.0 / 4.1 to their own $15/$75 tier (no longer shadowed)', () => {
        const apiDef = createApiDef({ apiType: 'anthropic' });
        for (const id of [
          'claude-opus-4-0',
          'claude-opus-4-20250514',
          'claude-opus-4-1',
          'claude-opus-4-1-20250805',
          'anthropic.claude-opus-4-20250514-v1:0',
        ]) {
          const result = getModelMetadataFor(apiDef, id);
          expect(result.matchedMode).toBe('fuzz');
          expect(result.inputPrice).toBe(15);
          expect(result.outputPrice).toBe(75);
          expect(result.onlyAdaptiveReasoning).toBeUndefined();
        }
      });

      it('resolves claude-fable-5 with its pricing + adaptive thinking on both api types', () => {
        for (const apiType of ['anthropic', 'claude-agent'] as const) {
          const apiDef = createApiDef({ apiType });
          for (const id of [
            'claude-fable-5',
            'claude-fable-5-20260601',
            'anthropic.claude-fable-5',
          ]) {
            const result = getModelMetadataFor(apiDef, id);
            expect(result.matchedMode).toBe('fuzz');
            expect(result.inputPrice).toBe(10);
            expect(result.outputPrice).toBe(50);
            expect(result.supportsAdaptiveReasoning).toBe(true);
            expect(result.onlyAdaptiveReasoning).toBe(true);
            expect(result.contextWindow).toBe(200000);
          }
        }
      });

      it('resolves Sonnet 5 to adaptive-only pricing matching Sonnet 4.6', () => {
        for (const apiType of ['anthropic', 'claude-agent'] as const) {
          const apiDef = createApiDef({ apiType });
          for (const id of [
            'claude-sonnet-5',
            'claude-sonnet-5-20260601',
            'anthropic.claude-sonnet-5',
          ]) {
            const result = getModelMetadataFor(apiDef, id);
            expect(result.matchedMode).toBe('fuzz');
            expect(result.inputPrice).toBe(3);
            expect(result.outputPrice).toBe(15);
            expect(result.supportsAdaptiveReasoning).toBe(true);
            expect(result.onlyAdaptiveReasoning).toBe(true);
          }
        }
      });

      it('resolves Haiku 5 to adaptive-only pricing matching Haiku 4.5', () => {
        for (const apiType of ['anthropic', 'claude-agent'] as const) {
          const apiDef = createApiDef({ apiType });
          for (const id of [
            'claude-haiku-5',
            'claude-haiku-5-20260601',
            'anthropic.claude-haiku-5',
          ]) {
            const result = getModelMetadataFor(apiDef, id);
            expect(result.matchedMode).toBe('fuzz');
            expect(result.inputPrice).toBe(1);
            expect(result.outputPrice).toBe(5);
            expect(result.supportsAdaptiveReasoning).toBe(true);
            expect(result.onlyAdaptiveReasoning).toBe(true);
          }
        }
      });

      it('routes an unknown future sonnet/haiku to the adaptive-only 5 entry via catch-all', () => {
        const apiDef = createApiDef({ apiType: 'anthropic' });

        const sonnet6 = getModelMetadataFor(apiDef, 'claude-sonnet-6-20270101');
        expect(sonnet6.matchedMode).toBe('fuzz');
        expect(sonnet6.inputPrice).toBe(3);
        expect(sonnet6.onlyAdaptiveReasoning).toBe(true);

        const haiku6 = getModelMetadataFor(apiDef, 'claude-haiku-6-20270101');
        expect(haiku6.matchedMode).toBe('fuzz');
        expect(haiku6.inputPrice).toBe(1);
        expect(haiku6.onlyAdaptiveReasoning).toBe(true);
      });

      it('keeps the catch-all off specific sonnet/haiku entries (no false adaptive-only)', () => {
        const apiDef = createApiDef({ apiType: 'anthropic' });

        // The 5-entry catch-all lives in its own low-specificity match, so
        // dedicated older ids still resolve to themselves — not the 5 profile.
        const sonnet46 = getModelMetadataFor(apiDef, 'claude-sonnet-4-6-20260101');
        expect(sonnet46.supportsAdaptiveReasoning).toBe(true);
        expect(sonnet46.onlyAdaptiveReasoning).toBeUndefined();

        const sonnet4 = getModelMetadataFor(apiDef, 'claude-sonnet-4-20250514');
        expect(sonnet4.maxOutputTokens).toBe(16384);
        expect(sonnet4.onlyAdaptiveReasoning).toBeUndefined();

        const haiku45 = getModelMetadataFor(apiDef, 'claude-haiku-4-5-20250101');
        expect(haiku45.onlyAdaptiveReasoning).toBeUndefined();
        expect(haiku45.supportsAdaptiveReasoning).toBeUndefined();
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

      it('routes the gpt-5.6 alias to Sol pricing', () => {
        const apiDef = createApiDef({ apiType: 'responses_api' });
        const result = getModelMetadataFor(apiDef, 'gpt-5.6');

        expect(result.matchedMode).toBe('exact');
        expect(result.inputPrice).toBe(5.0);
        expect(result.cacheReadPrice).toBe(0.5);
        expect(result.outputPrice).toBe(30.0);
        expect(result.supportedReasoningEfforts).toContain('max');
      });

      it('disambiguates gpt-5.6 Terra/Luna from the bare gpt-5.6 prefix', () => {
        const apiDef = createApiDef({ apiType: 'chatgpt' });

        const terra = getModelMetadataFor(apiDef, 'gpt-5.6-terra');
        expect(terra.inputPrice).toBe(2.5);
        expect(terra.outputPrice).toBe(15.0);

        const luna = getModelMetadataFor(apiDef, 'gpt-5.6-luna-2026-07-01');
        expect(luna.matchedMode).toBe('fuzz');
        expect(luna.inputPrice).toBe(1.0);
        expect(luna.outputPrice).toBe(6.0);

        // Dated bare snapshot still routes to Sol via prefix fuzz
        const datedSol = getModelMetadataFor(apiDef, 'gpt-5.6-2026-06-25');
        expect(datedSol.inputPrice).toBe(5.0);
      });

      it('matches grok-4.5 over the shorter grok-4 prefix', () => {
        const apiDef = createApiDef({ apiType: 'chatgpt' });

        const exact = getModelMetadataFor(apiDef, 'grok-4.5');
        expect(exact.matchedMode).toBe('exact');
        expect(exact.inputPrice).toBe(2.0);
        expect(exact.cacheReadPrice).toBe(0.5);
        expect(exact.outputPrice).toBe(6.0);
        expect(exact.contextWindow).toBe(500000);

        const dated = getModelMetadataFor(apiDef, 'grok-4.5-0715');
        expect(dated.matchedMode).toBe('fuzz');
        expect(dated.inputPrice).toBe(2.0);
      });

      it('matches doubao-seed-2-1-pro with cache pricing', () => {
        const apiDef = createApiDef({ apiType: 'chatgpt' });
        const result = getModelMetadataFor(apiDef, 'doubao-seed-2-1-pro-20260615');

        expect(result.matchedMode).toBe('fuzz');
        expect(result.inputPrice).toBe(0.93);
        expect(result.cacheReadPrice).toBe(0.186);
        expect(result.outputPrice).toBe(4.65);
        expect(result.deFactoThinking).toBe(true);
      });
    });

    describe('Chinese open models (Qwen / Kimi / GLM)', () => {
      it('matches Qwen 3.8 Max with input/cache/output pricing', () => {
        const apiDef = createApiDef({ apiType: 'chatgpt' });
        const result = getModelMetadataFor(apiDef, 'qwen3.8-max');

        expect(result.matchedMode).toBe('fuzz');
        expect(result.inputPrice).toBe(2.0);
        expect(result.cacheReadPrice).toBe(0.25);
        expect(result.outputPrice).toBe(6.0);
        expect(result.deFactoThinking).toBe(true);
      });

      it('matches Qwen 3.7 Max with input/cache/output pricing', () => {
        const apiDef = createApiDef({ apiType: 'chatgpt' });
        const result = getModelMetadataFor(apiDef, 'qwen3.7-max');

        expect(result.matchedMode).toBe('fuzz');
        expect(result.inputPrice).toBe(2.5);
        expect(result.cacheReadPrice).toBe(0.5);
        expect(result.outputPrice).toBe(7.5);
        expect(result.deFactoThinking).toBe(true);
      });

      it('matches Qwen 3.6 Plus with no cache price (falls back to input)', () => {
        const apiDef = createApiDef({ apiType: 'chatgpt' });
        const result = getModelMetadataFor(apiDef, 'qwen3.6-plus');

        expect(result.inputPrice).toBe(0.5);
        expect(result.outputPrice).toBe(3.0);
        expect(result.cacheReadPrice).toBeUndefined();
      });

      it('bills Qwen 3.7 Plus at the base (<256K) tier, records the >=256K tier as unsupported', () => {
        const apiDef = createApiDef({ apiType: 'chatgpt' });
        const result = getModelMetadataFor(apiDef, 'qwen3.7-plus');

        // Base tier applied by calculateCost
        expect(result.inputPrice).toBe(0.4);
        expect(result.cacheReadPrice).toBe(0.08);
        expect(result.outputPrice).toBe(1.6);

        // High tier recorded but not applied
        expect(result.unsupportedHighContextPricing).toEqual({
          thresholdTokens: 262144,
          inputPrice: 1.2,
          cacheReadPrice: 0.24,
          outputPrice: 4.8,
        });

        // calculateCost uses the base price, not the high tier
        const cost = calculateCost(result, 1_000_000, 0);
        expect(cost).toBeCloseTo(0.4);
      });

      it('disambiguates kimi-k2.7-code from kimi-k2.7-code-highspeed by specificity', () => {
        const apiDef = createApiDef({ apiType: 'chatgpt' });

        const code = getModelMetadataFor(apiDef, 'kimi-k2.7-code');
        expect(code.inputPrice).toBe(0.95);
        expect(code.outputPrice).toBe(4.0);

        const highspeed = getModelMetadataFor(apiDef, 'kimi-k2.7-code-highspeed');
        expect(highspeed.inputPrice).toBe(1.9);
        expect(highspeed.outputPrice).toBe(8.0);
        expect(highspeed.contextWindow).toBe(262144);
      });

      it('matches kimi-k3 via prefix and the bare k3 alias exactly', () => {
        const apiDef = createApiDef({ apiType: 'chatgpt' });

        const k3 = getModelMetadataFor(apiDef, 'kimi-k3');
        expect(k3.inputPrice).toBe(3.0);
        expect(k3.cacheReadPrice).toBe(0.3);
        expect(k3.outputPrice).toBe(15.0);
        expect(k3.contextWindow).toBe(1048576);
        expect(k3.reasoningMode).toBe('always');
        expect(k3.supportedReasoningEfforts).toEqual(['low', 'high', 'max']);

        const alias = getModelMetadataFor(apiDef, 'k3');
        expect(alias.matchedMode).toBe('exact');
        expect(alias.inputPrice).toBe(3.0);
      });

      it('matches kimi-k2.5 and a dated kimi snapshot via prefix', () => {
        const apiDef = createApiDef({ apiType: 'chatgpt' });
        const result = getModelMetadataFor(apiDef, 'kimi-k2.5-20260101');

        expect(result.matchedMode).toBe('fuzz');
        expect(result.inputPrice).toBe(0.6);
        expect(result.cacheReadPrice).toBe(0.1);
        expect(result.outputPrice).toBe(3.0);
      });

      it('matches GLM-5.2 and disambiguates from glm-5 base', () => {
        const apiDef = createApiDef({ apiType: 'chatgpt' });

        const glm52 = getModelMetadataFor(apiDef, 'glm-5.2');
        expect(glm52.inputPrice).toBe(1.4);
        expect(glm52.outputPrice).toBe(4.4);

        const glm5 = getModelMetadataFor(apiDef, 'glm-5');
        expect(glm5.inputPrice).toBe(1.0);
        expect(glm5.outputPrice).toBe(3.2);
      });

      it('disambiguates GLM-4.5 air/airx/x/flash/base via specificity', () => {
        const apiDef = createApiDef({ apiType: 'chatgpt' });

        expect(getModelMetadataFor(apiDef, 'glm-4.5').inputPrice).toBe(0.6);
        expect(getModelMetadataFor(apiDef, 'glm-4.5-air').inputPrice).toBe(0.2);
        expect(getModelMetadataFor(apiDef, 'glm-4.5-airx').inputPrice).toBe(1.1);
        expect(getModelMetadataFor(apiDef, 'glm-4.5-x').inputPrice).toBe(2.2);

        const flash = getModelMetadataFor(apiDef, 'glm-4.5-flash');
        expect(flash.inputPrice).toBe(0);
        expect(flash.outputPrice).toBe(0);
      });

      it('disambiguates GLM-4.7 flash/flashx/base (flash is free, flashx is not)', () => {
        const apiDef = createApiDef({ apiType: 'chatgpt' });

        const flash = getModelMetadataFor(apiDef, 'glm-4.7-flash');
        expect(flash.inputPrice).toBe(0);
        expect(flash.outputPrice).toBe(0);

        const flashx = getModelMetadataFor(apiDef, 'glm-4.7-flashx');
        expect(flashx.inputPrice).toBe(0.07);
        expect(flashx.outputPrice).toBe(0.4);

        expect(getModelMetadataFor(apiDef, 'glm-4.7').inputPrice).toBe(0.6);
      });

      it('matches GLM-4-32B-0414 as a non-thinking model with 128K context', () => {
        const apiDef = createApiDef({ apiType: 'chatgpt' });
        const result = getModelMetadataFor(apiDef, 'glm-4-32b-0414-128k');

        expect(result.inputPrice).toBe(0.1);
        expect(result.outputPrice).toBe(0.1);
        expect(result.cacheReadPrice).toBeUndefined();
        expect(result.contextWindow).toBe(131072);
        expect(result.reasoningMode).toBe('none');
        expect(result.deFactoThinking).toBe(false);
      });

      it('does not match these models for the google api type', () => {
        const apiDef = createApiDef({ apiType: 'google' });
        expect(getModelMetadataFor(apiDef, 'qwen3.7-max').matchedMode).toBe('default');
        expect(getModelMetadataFor(apiDef, 'kimi-k2.5').matchedMode).toBe('default');
        expect(getModelMetadataFor(apiDef, 'glm-5').matchedMode).toBe('default');
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

    it("applies 1.6x multiplier to cache writes when cacheTtl is '1h'", () => {
      const model = createModel({ inputPrice: 5, cacheWritePrice: 6.25, cacheReadPrice: 0.5 });
      const cost5m = calculateCost(model, 0, 0, 0, 1_000_000, 0, undefined, '5m');
      const cost1h = calculateCost(model, 0, 0, 0, 1_000_000, 0, undefined, '1h');
      expect(cost5m).toBeCloseTo(6.25);
      expect(cost1h).toBeCloseTo(6.25 * 1.6);
      // Cache reads cost the same regardless of ttl
      const read5m = calculateCost(model, 0, 0, 0, 0, 1_000_000, undefined, '5m');
      const read1h = calculateCost(model, 0, 0, 0, 0, 1_000_000, undefined, '1h');
      expect(read1h).toBeCloseTo(read5m);
    });

    it('applies tierMultiplier to token-priced lines', () => {
      const model = createModel({
        inputPrice: 1.0,
        outputPrice: 2.0,
        cacheReadPrice: 0.5,
        cacheWritePrice: 1.5,
      });
      const full = calculateCost(model, 1_000_000, 1_000_000, 0, 1_000_000, 1_000_000);
      const half = calculateCost(
        model,
        1_000_000,
        1_000_000,
        0,
        1_000_000,
        1_000_000,
        undefined,
        undefined,
        0.5
      );
      expect(half).toBeCloseTo(full * 0.5);
    });

    it('does not discount per-request fees with tierMultiplier', () => {
      const model = createModel({ inputPrice: 0, outputPrice: 0, webSearchPrice: 0.01 });
      const full = calculateCost(model, 0, 0, 0, 0, 0, 5);
      const halfTier = calculateCost(model, 0, 0, 0, 0, 0, 5, undefined, 0.5);
      expect(halfTier).toBeCloseTo(full);
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
