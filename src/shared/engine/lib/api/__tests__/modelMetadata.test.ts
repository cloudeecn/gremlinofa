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

      it.each(['gemini-4-carbon', 'gemini-4-argon'])(
        'matches %s at its introductory pricing',
        modelId => {
          const apiDef = createApiDef({ apiType: 'google' });
          const result = getModelMetadataFor(apiDef, modelId);

          expect(result.matchedMode).toBe('fuzz');
          expect(result.inputPrice).toBe(2.0);
          expect(result.outputPrice).toBe(10.0);
          expect(result.cacheReadPrice).toBe(0.1);
          expect(result.contextWindow).toBe(1048576);
          expect(result.maxOutputTokens).toBe(65536);
          expect(result.reasoningMode).toBe('always');
          expect(result.supportedReasoningEfforts).toEqual(['low', 'medium', 'high']);
          expect(result.supportsTemperature).toBe(false);
          expect(result.priceSchedule).toEqual([
            {
              effectiveFrom: '2026-12-01',
              inputPrice: 4.0,
              outputPrice: 20.0,
              cacheReadPrice: 0.2,
            },
          ]);
        }
      );

      it('matches gemini-3.8-flash at its introductory pricing', () => {
        const apiDef = createApiDef({ apiType: 'google' });
        const result = getModelMetadataFor(apiDef, 'gemini-3.8-flash');

        expect(result.matchedMode).toBe('fuzz');
        expect(result.inputPrice).toBe(0.75);
        expect(result.outputPrice).toBe(3.75);
        expect(result.cacheReadPrice).toBe(0.075);
        expect(result.contextWindow).toBe(1048576);
        expect(result.maxOutputTokens).toBe(65536);
        // MINIMAL is a validation error on this model.
        expect(result.supportedReasoningEfforts).toEqual(['low', 'medium', 'high']);
      });

      it('matches gemini-3.7-flash at its introductory pricing', () => {
        const apiDef = createApiDef({ apiType: 'google' });
        const result = getModelMetadataFor(apiDef, 'gemini-3.7-flash');

        expect(result.matchedMode).toBe('fuzz');
        expect(result.inputPrice).toBe(0.75);
        expect(result.outputPrice).toBe(3.75);
        expect(result.cacheReadPrice).toBe(0.075);
        expect(result.contextWindow).toBe(1048576);
        expect(result.maxOutputTokens).toBe(65536);
        // MINIMAL is a validation error on this model.
        expect(result.supportedReasoningEfforts).toEqual(['low', 'medium', 'high']);
      });

      it('matches gemini-3.6-flash via prefix without hitting the 3.5 entry', () => {
        const apiDef = createApiDef({ apiType: 'google' });
        const result = getModelMetadataFor(apiDef, 'gemini-3.6-flash');

        expect(result.matchedMode).toBe('fuzz');
        expect(result.inputPrice).toBe(0.75);
        expect(result.outputPrice).toBe(3.75);
        expect(result.cacheReadPrice).toBe(0.075);
        expect(result.priceSchedule).toEqual([
          { effectiveFrom: '2027-01-01', inputPrice: 1.5, outputPrice: 7.5, cacheReadPrice: 0.15 },
        ]);
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

      it('routes an unknown future opus to the adaptive-only 5.5 entry via catch-all', () => {
        const apiDef = createApiDef({ apiType: 'anthropic' });

        // A next minor and a hypothetical major bump both fall through to the
        // 5.5 catch-all rather than the legacy $15/$75 base entry.
        for (const id of ['claude-opus-5-9-20270101', 'claude-opus-6']) {
          const result = getModelMetadataFor(apiDef, id);
          expect(result.matchedMode).toBe('fuzz');
          expect(result.inputPrice).toBe(4);
          expect(result.outputPrice).toBe(20);
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

      it('separates opus 5.5 / 5 / 4.8 instead of collapsing them onto the catch-all', () => {
        const apiDef = createApiDef({ apiType: 'anthropic' });

        // 5.5 undercuts 5, so the catch-all moving to 5.5 must not drag Opus 5
        // down with it. 1M is the default context on both — no `[1m]` opt-in.
        const opus55 = getModelMetadataFor(apiDef, 'claude-opus-5-5-20260922');
        expect(opus55.inputPrice).toBe(4);
        expect(opus55.outputPrice).toBe(20);
        expect(opus55.cacheReadPrice).toBe(0.2);
        expect(opus55.cacheWritePrice).toBe(5);
        expect(opus55.contextWindow).toBe(1000000);
        expect(opus55.maxOutputTokens).toBe(128000);
        expect(opus55.onlyAdaptiveReasoning).toBe(true);

        const opus5 = getModelMetadataFor(apiDef, 'claude-opus-5');
        expect(opus5.matchedMode).toBe('exact');
        expect(opus5.inputPrice).toBe(5);
        expect(opus5.outputPrice).toBe(25);
        expect(opus5.cacheReadPrice).toBe(0.5);
        expect(opus5.contextWindow).toBe(1000000);
        // `thinking.type: enabled` 400s on Opus 5, so a budget must not select it
        expect(opus5.supportsAdaptiveReasoning).toBe(true);
        expect(opus5.onlyAdaptiveReasoning).toBe(true);

        const opus48 = getModelMetadataFor(apiDef, 'claude-opus-4-8');
        expect(opus48.inputPrice).toBe(5);
        expect(opus48.contextWindow).toBe(1000000);

        // Dated Opus 5 snapshots stay on the legacy tier via the year-scoped fuzz
        expect(getModelMetadataFor(apiDef, 'claude-opus-5-20260724').inputPrice).toBe(5);

        // Bedrock ids resolve to the same entries
        expect(getModelMetadataFor(apiDef, 'anthropic.claude-opus-5-5').inputPrice).toBe(4);
        expect(getModelMetadataFor(apiDef, 'anthropic.claude-opus-5').inputPrice).toBe(5);
      });

      it('records which Claude models think by default and how they switch off', () => {
        const apiDef = createApiDef({ apiType: 'anthropic' });

        // Always on: rejects `disabled`, so toggle off means lowest effort
        for (const id of ['claude-fable-5-1', 'claude-fable-5', 'claude-opus-5-5']) {
          expect(getModelMetadataFor(apiDef, id).reasoningMode, id).toBe('always');
        }
        // Sonnet 5.5: own entry so it doesn't inherit Sonnet 5's `disabled`;
        // its `between_tools` off switch isn't wired yet
        const sonnet55 = getModelMetadataFor(apiDef, 'claude-sonnet-5-5');
        expect([sonnet55.inputPrice, sonnet55.outputPrice]).toEqual([2, 10]);
        expect(sonnet55.reasoningMode).toBe('always');
        expect(sonnet55.thinkingOffType).toBeUndefined();
        // On by default, `disabled` accepted
        for (const id of ['claude-opus-5', 'claude-sonnet-5']) {
          expect(getModelMetadataFor(apiDef, id).thinkingOffType, id).toBe('disabled');
        }
        // Off by default: omitting `thinking` is enough
        expect(getModelMetadataFor(apiDef, 'claude-opus-4-8').thinkingOffType).toBeUndefined();
        expect(getModelMetadataFor(apiDef, 'claude-opus-4-8').reasoningMode).toBeUndefined();
      });

      it('carries the documented effort ladder per Claude model', () => {
        const apiDef = createApiDef({ apiType: 'anthropic' });
        const ALL = ['low', 'medium', 'high', 'xhigh', 'max'];
        const NO_XHIGH = ['low', 'medium', 'high', 'max'];

        // xhigh is a curated list: Fable 5.x, Opus 5.5/5/4.8/4.7, Sonnet 5.x,
        // Haiku 5.5. max additionally covers Opus 4.6 and Sonnet 4.6.
        const cases: [string, string[] | undefined][] = [
          ['claude-fable-5-2', ALL],
          ['claude-mythos-5-2', ALL],
          ['claude-fable-5-1', ALL],
          ['claude-fable-5', ALL],
          ['claude-opus-5-5', ALL],
          ['claude-opus-4-8', ALL],
          ['claude-opus-5', ALL],
          ['claude-opus-4-7', ALL],
          ['claude-sonnet-5-5', ALL],
          ['claude-sonnet-5', ALL],
          ['claude-haiku-5-5', ALL],
          ['claude-opus-4-6', NO_XHIGH],
          ['claude-sonnet-4-6', NO_XHIGH],
          // Opus 4.5 takes effort beside budget_tokens; the rest below 4.6 don't
          ['claude-opus-4-5', ['low', 'medium', 'high']],
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

      it('resolves claude-fable-5 / mythos-5 with their pricing + adaptive thinking on both api types', () => {
        for (const apiType of ['anthropic', 'claude-agent'] as const) {
          const apiDef = createApiDef({ apiType });
          for (const id of [
            'claude-fable-5',
            'claude-fable-5-20260601',
            'anthropic.claude-fable-5',
            'claude-mythos-5',
          ]) {
            const result = getModelMetadataFor(apiDef, id);
            expect(['exact', 'fuzz'], id).toContain(result.matchedMode);
            expect(result.inputPrice).toBe(10);
            expect(result.outputPrice).toBe(50);
            // Standard 0.1x cache read — not shadowed by the fable-5-1 entry.
            expect(result.cacheReadPrice).toBe(1);
            expect(result.supportsAdaptiveReasoning).toBe(true);
            expect(result.onlyAdaptiveReasoning).toBe(true);
            expect(result.contextWindow).toBe(1000000);
            expect(result.maxOutputTokens).toBe(128000);
          }
        }
      });

      it('resolves claude-fable-5-1 with its reduced cache-read price on both api types', () => {
        for (const apiType of ['anthropic', 'claude-agent'] as const) {
          const apiDef = createApiDef({ apiType });
          for (const id of [
            'claude-fable-5-1',
            'claude-fable-5-1-20260901',
            'anthropic.claude-fable-5-1',
            'claude-mythos-5-1',
          ]) {
            const result = getModelMetadataFor(apiDef, id);
            expect(result.matchedMode).toBe('fuzz');
            expect(result.inputPrice).toBe(10);
            expect(result.outputPrice).toBe(50);
            expect(result.cacheWritePrice).toBe(12.5);
            // 0.025x input on Fable 5.1 vs the standard 0.1x ($1 on Fable 5).
            expect(result.cacheReadPrice).toBe(0.25);
            expect(result.supportsAdaptiveReasoning).toBe(true);
            expect(result.onlyAdaptiveReasoning).toBe(true);
            expect(result.contextWindow).toBe(1000000);
            expect(result.maxOutputTokens).toBe(128000);
          }
        }
      });

      it('resolves Sonnet 5 to adaptive-only pricing', () => {
        for (const apiType of ['anthropic', 'claude-agent'] as const) {
          const apiDef = createApiDef({ apiType });
          for (const id of [
            'claude-sonnet-5',
            'claude-sonnet-5-20260601',
            'anthropic.claude-sonnet-5',
          ]) {
            const result = getModelMetadataFor(apiDef, id);
            expect(['exact', 'fuzz'], id).toContain(result.matchedMode);
            expect(result.inputPrice).toBe(2);
            expect(result.outputPrice).toBe(10);
            expect(result.cacheReadPrice).toBe(0.2);
            expect(result.contextWindow).toBe(1000000);
            expect(result.maxOutputTokens).toBe(128000);
            expect(result.supportsAdaptiveReasoning).toBe(true);
            expect(result.onlyAdaptiveReasoning).toBe(true);
            // Thinks by default; `disabled` is its off switch
            expect(result.thinkingOffType).toBe('disabled');
          }
        }
      });

      it('resolves Haiku 5.5 with its >100K prompt tier on both api types', () => {
        for (const apiType of ['anthropic', 'claude-agent'] as const) {
          const apiDef = createApiDef({ apiType });
          for (const id of ['claude-haiku-5-5', 'anthropic.claude-haiku-5-5']) {
            const result = getModelMetadataFor(apiDef, id);
            expect(result.matchedMode).toBe('fuzz');
            expect(result.inputPrice).toBe(0.1);
            expect(result.outputPrice).toBe(0.5);
            expect(result.cacheReadPrice).toBe(0.01);
            expect(result.cacheWritePrice).toBe(0.125);
            expect(result.contextPricingTiers).toEqual([
              {
                thresholdTokens: 100000,
                inputPrice: 0.5,
                outputPrice: 2.5,
                cacheWritePrice: 0.625,
                cacheReadPrice: 0.05,
              },
            ]);
            expect(result.contextWindow).toBe(1000000);
            expect(result.maxOutputTokens).toBe(128000);
            expect(result.onlyAdaptiveReasoning).toBe(true);
            // `disabled` is accepted at effort high or below
            expect(result.thinkingOffType).toBe('disabled');
          }
        }
      });

      it('resolves Fable 5.2 and Mythos 5.2 to their own lower price', () => {
        for (const apiType of ['anthropic', 'claude-agent'] as const) {
          const apiDef = createApiDef({ apiType });
          for (const id of [
            'claude-fable-5-2',
            'claude-mythos-5-2',
            'anthropic.claude-fable-5-2',
          ]) {
            const result = getModelMetadataFor(apiDef, id);
            expect(result.matchedMode, id).toBe('fuzz');
            expect(result.inputPrice).toBe(8);
            expect(result.outputPrice).toBe(40);
            expect(result.cacheReadPrice).toBe(0.2);
            expect(result.cacheWritePrice).toBe(10);
            expect(result.reasoningMode).toBe('always');
          }
        }
      });

      it('lets a future Claude 5.x id reach its family catch-all instead of an older 5.0 entry', () => {
        const apiDef = createApiDef({ apiType: 'anthropic' });
        // Fable 5.2 profile, not Fable 5's $10 / $1-cache-read row
        expect(getModelMetadataFor(apiDef, 'claude-fable-5-3').inputPrice).toBe(8);
        expect(getModelMetadataFor(apiDef, 'claude-mythos-5-3').inputPrice).toBe(8);
        // Sonnet 5.5 profile (0.05x cache read), not Sonnet 5's 0.1x
        expect(getModelMetadataFor(apiDef, 'claude-sonnet-5-6').cacheReadPrice).toBe(0.1);
        expect(getModelMetadataFor(apiDef, 'claude-haiku-5-6').inputPrice).toBe(0.1);
      });

      it('routes an unknown future sonnet/haiku to the newest adaptive-only entry via catch-all', () => {
        const apiDef = createApiDef({ apiType: 'anthropic' });

        const sonnet6 = getModelMetadataFor(apiDef, 'claude-sonnet-6-20270101');
        expect(sonnet6.matchedMode).toBe('fuzz');
        expect(sonnet6.contextWindow).toBe(1000000); // the Sonnet 5.5 profile
        expect(sonnet6.onlyAdaptiveReasoning).toBe(true);

        const haiku6 = getModelMetadataFor(apiDef, 'claude-haiku-6-20270101');
        expect(haiku6.matchedMode).toBe('fuzz');
        expect(haiku6.inputPrice).toBe(0.1); // the Haiku 5.5 profile
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

      it('bills retired grok-4 slugs at the grok-4.3 rate they redirect to', () => {
        const apiDef = createApiDef({ apiType: 'chatgpt' });
        for (const id of ['grok-4', 'grok-4-0709', 'grok-4-fast-reasoning', 'grok-3']) {
          const result = getModelMetadataFor(apiDef, id);
          expect(result.matchedMode, id).toBe('exact');
          expect(result.inputPrice, id).toBe(1.25);
          expect(result.outputPrice, id).toBe(2.5);
          expect(result.contextWindow, id).toBe(1000000);
        }
      });

      it('sends an unknown grok-4.x to the grok-4.7 catch-all', () => {
        const apiDef = createApiDef({ apiType: 'chatgpt' });
        const result = getModelMetadataFor(apiDef, 'grok-4.8');
        expect(result.matchedMode).toBe('fuzz');
        expect(result.inputPrice).toBe(2.0);
        expect(result.contextWindow).toBe(500000);
      });

      it('prices grok-4.20 aliases and grok-build at their current rates', () => {
        const apiDef = createApiDef({ apiType: 'chatgpt' });
        for (const id of [
          'grok-4.20-0309-reasoning',
          'grok-4.20-0309-non-reasoning',
          'grok-4.20',
          'grok-4.20-multi-agent-0309',
        ]) {
          const result = getModelMetadataFor(apiDef, id);
          expect(result.inputPrice, id).toBe(1.25);
          expect(result.contextWindow, id).toBe(1000000);
        }
        // grok-code-fast-1 is an alias of grok-build-0.1 now
        for (const id of ['grok-build-0.1', 'grok-code-fast-1']) {
          const result = getModelMetadataFor(apiDef, id);
          expect([result.inputPrice, result.outputPrice, result.cacheReadPrice], id).toEqual([
            1, 2, 0.2,
          ]);
        }
        // ...but grok-build-latest aliases grok-4.5
        expect(getModelMetadataFor(apiDef, 'grok-build-latest').inputPrice).toBe(2.0);
      });

      it('matches grok-3-mini with reasoning efforts', () => {
        const apiDef = createApiDef({ apiType: 'responses_api' });
        const result = getModelMetadataFor(apiDef, 'grok-3-mini');

        expect(result.matchedMode).toBe('exact');
        expect(result.reasoningMode).toBe('always');
        expect(result.supportedReasoningEfforts).toEqual(['low', 'high']);
      });

      it('matches gpt-6-astra with its >272K context tier', () => {
        const apiDef = createApiDef({ apiType: 'chatgpt' });

        const astra = getModelMetadataFor(apiDef, 'gpt-6-astra');
        expect(astra.matchedMode).toBe('exact');
        expect(astra.inputPrice).toBe(10.0);
        expect(astra.outputPrice).toBe(50.0);
        expect(astra.cacheReadPrice).toBe(1.0);
        expect(astra.cacheWritePrice).toBe(12.5);
        expect(astra.contextWindow).toBe(1050000);
        expect(astra.maxOutputTokens).toBe(128000);
        // No 'none'/'minimal' on gpt-6, unlike the gpt-5.x ladders.
        expect(astra.supportedReasoningEfforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
        // >272K-prompt requests bill 2x input/cache, 1.5x output.
        expect(astra.contextPricingTiers).toEqual([
          {
            thresholdTokens: 272000,
            inputPrice: 20.0,
            cacheReadPrice: 2.0,
            cacheWritePrice: 25.0,
            outputPrice: 75.0,
          },
        ]);

        const dated = getModelMetadataFor(apiDef, 'gpt-6-astra-2026-09-04');
        expect(dated.matchedMode).toBe('fuzz');
        expect(dated.inputPrice).toBe(10.0);

        // Unknown future gpt-6* ids inherit the Astra profile via the
        // low-specificity catch-all (reported as a plain fuzz match).
        const future = getModelMetadataFor(apiDef, 'gpt-6-mini');
        expect(future.matchedMode).toBe('fuzz');
        expect(future.inputPrice).toBe(10.0);
      });

      it('gives gpt-6 Sol and Luna their own entries instead of Astra pricing', () => {
        const apiDef = createApiDef({ apiType: 'chatgpt' });

        const sol = getModelMetadataFor(apiDef, 'gpt-6-sol');
        expect(sol.matchedMode).toBe('exact');
        expect(sol.inputPrice).toBe(2.0);
        expect(sol.outputPrice).toBe(10.0);
        expect(sol.cacheReadPrice).toBe(0.2);
        expect(sol.cacheWritePrice).toBe(2.5);
        expect(sol.contextWindow).toBe(1050000);
        // Sol and Luna accept 'none'; Astra does not.
        expect(sol.supportedReasoningEfforts).toContain('none');
        expect(sol.contextPricingTiers).toEqual([
          {
            thresholdTokens: 272000,
            inputPrice: 4.0,
            cacheReadPrice: 0.4,
            cacheWritePrice: 5.0,
            outputPrice: 15.0,
          },
        ]);

        const luna = getModelMetadataFor(apiDef, 'gpt-6-luna-2026-09-22');
        expect(luna.matchedMode).toBe('fuzz');
        expect(luna.inputPrice).toBe(0.1);
        expect(luna.outputPrice).toBe(0.5);
        expect(luna.cacheReadPrice).toBe(0.01);

        // Astra keeps the family catch-all, so it is unaffected
        expect(getModelMetadataFor(apiDef, 'gpt-6-astra').inputPrice).toBe(10.0);
      });

      it('gives gpt-6.1-terra its own entry instead of the 10x Astra catch-all', () => {
        const apiDef = createApiDef({ apiType: 'chatgpt' });
        const terra = getModelMetadataFor(apiDef, 'gpt-6.1-terra');
        expect(terra.matchedMode).toBe('exact');
        expect([terra.inputPrice, terra.outputPrice, terra.cacheReadPrice]).toEqual([1, 5, 0.05]);
        expect(terra.supportedReasoningEfforts).toContain('none');
        expect(getModelMetadataFor(apiDef, 'gpt-6.1-terra-2026-10-26').inputPrice).toBe(1);
      });

      it('schedules gpt-5.6-sol back to its pre-promo rate on 2026-11-30', () => {
        const apiDef = createApiDef({ apiType: 'chatgpt' });
        const sol = getModelMetadataFor(apiDef, 'gpt-5.6-sol');
        expect(sol.inputPrice).toBe(4.0);
        expect(sol.priceSchedule?.[0]).toMatchObject({
          effectiveFrom: '2026-11-30',
          inputPrice: 5.0,
          outputPrice: 30.0,
        });
        expect(sol.contextPricingTiers?.[0].thresholdTokens).toBe(272000);
      });

      it('sends reasoning.context only to models that accept it (gpt-5.4 and later)', () => {
        const apiDef = createApiDef({ apiType: 'responses_api' });

        for (const id of ['gpt-5.4', 'gpt-5.5', 'gpt-5.6-luna', 'gpt-6-sol']) {
          expect(getModelMetadataFor(apiDef, id).reasoningHistoryParam).toBe('reasoning_context');
        }
        for (const id of ['gpt-5.2', 'gpt-5-mini', 'gpt-4.1-nano']) {
          expect(getModelMetadataFor(apiDef, id).reasoningHistoryParam).toBeUndefined();
        }
      });

      it('matches grok-4.7 with its 200K-or-more prompt tier', () => {
        const apiDef = createApiDef({ apiType: 'chatgpt' });

        const exact = getModelMetadataFor(apiDef, 'grok-4.7');
        expect(exact.matchedMode).toBe('exact');
        expect(exact.inputPrice).toBe(2.0);
        expect(exact.outputPrice).toBe(6.0);
        expect(exact.cacheReadPrice).toBe(0.5);
        expect(exact.contextWindow).toBe(500000);
        // "200K or more" → strictly above 199999
        expect(exact.contextPricingTiers).toEqual([
          { thresholdTokens: 199999, inputPrice: 4.0, outputPrice: 12.0, cacheReadPrice: 1.0 },
        ]);

        // Dated snapshots resolve through the grok-4.7 prefix
        const dated = getModelMetadataFor(apiDef, 'grok-4.7-1120');
        expect(dated.matchedMode).toBe('fuzz');
        expect(dated.inputPrice).toBe(2.0);
        expect(dated.contextWindow).toBe(500000);
      });

      it('keeps mimo-v2.6-pro-ultraspeed off the 10x-cheaper mimo-v2.6-pro entry', () => {
        const apiDef = createApiDef({ apiType: 'chatgpt' });

        const pro = getModelMetadataFor(apiDef, 'mimo-v2.6-pro');
        expect(pro.matchedMode).toBe('fuzz');
        expect(pro.inputPrice).toBe(0.435);
        expect(pro.outputPrice).toBe(0.87);
        expect(pro.cacheReadPrice).toBe(0.0036);
        expect(pro.contextWindow).toBe(1048576);
        expect(pro.maxOutputTokens).toBe(131072);
        expect(pro.reasoningDialect).toBe('thinking-object');

        // The plain -pro prefix also matches this id; the longer prefix must win
        const ultra = getModelMetadataFor(apiDef, 'mimo-v2.6-pro-ultraspeed');
        expect(ultra.inputPrice).toBe(4.35);
        expect(ultra.outputPrice).toBe(8.7);

        // 2.5 Pro now bills as 2.6 Pro, and keeps its own entry over plain mimo-v2.5
        expect(getModelMetadataFor(apiDef, 'mimo-v2.5-pro').inputPrice).toBe(0.435);
      });

      it('prices mimo-v2.6-flash and the deprecated mimo-v2.5 alike', () => {
        const apiDef = createApiDef({ apiType: 'chatgpt' });

        for (const id of ['mimo-v2.6-flash', 'mimo-v2.5']) {
          const flash = getModelMetadataFor(apiDef, id);
          expect([flash.inputPrice, flash.cacheReadPrice, flash.outputPrice]).toEqual([
            0.14, 0.0028, 0.28,
          ]);
          expect(flash.reasoningDialect).toBe('thinking-object');
          expect(flash.supportedReasoningEfforts).toEqual([]);
        }
      });

      it('keeps dated gpt-4o snapshots off the gpt-4 catch-all on the gpt-4.1 entry', () => {
        const apiDef = createApiDef({ apiType: 'responses_api' });

        const dated = getModelMetadataFor(apiDef, 'gpt-4o-2024-11-20');
        expect([dated.inputPrice, dated.outputPrice]).toEqual([2.5, 10]);
        expect(getModelMetadataFor(apiDef, 'gpt-4.1-2025-04-14').inputPrice).toBe(2.0);
        expect(getModelMetadataFor(apiDef, 'gpt-4-turbo').inputPrice).toBe(2.0);
      });

      it('gives every live gpt-5.x / gpt-6.x sub-model its own entry, dated snapshots included', () => {
        const apiDef = createApiDef({ apiType: 'responses_api' });
        const price = (id: string) => {
          const m = getModelMetadataFor(apiDef, id);
          return [m.inputPrice, m.outputPrice];
        };

        expect(price('gpt-6.1-sol')).toEqual([2.0, 10.0]);
        expect(getModelMetadataFor(apiDef, 'gpt-6.1-sol').cacheReadPrice).toBe(0.1);
        expect(price('gpt-5.5-2026-04-23')).toEqual([5.0, 30.0]);
        expect(price('gpt-5.5-pro-2026-04-23')).toEqual([30.0, 180.0]);
        expect(price('gpt-5.4-pro')).toEqual([30.0, 180.0]);
        expect(price('gpt-5.4-mini-2026-03-17')).toEqual([0.75, 4.5]);
        expect(price('gpt-5.4-nano')).toEqual([0.2, 1.25]);
        expect(price('gpt-5.3-codex')).toEqual([1.75, 14.0]);
        // Dated snapshots of postfix-matched models used to fall to the parent
        expect(price('gpt-5-mini-2025-08-07')).toEqual([0.25, 2.0]);
        expect(price('gpt-4o-mini-2024-07-18')).toEqual([0.15, 0.6]);
        expect(price('gpt-4.1-nano-2025-04-14')).toEqual([0.1, 0.4]);
      });

      it('carries the documented OpenAI effort ladders', () => {
        const apiDef = createApiDef({ apiType: 'responses_api' });
        const cases: [string, string, string[]][] = [
          ['gpt-6.1-sol', 'always', ['low', 'medium', 'high', 'xhigh', 'max']],
          ['gpt-6-sol', 'optional', ['none', 'low', 'medium', 'high', 'xhigh', 'max']],
          ['gpt-5.5', 'optional', ['none', 'low', 'medium', 'high', 'xhigh']],
          ['gpt-5.4', 'optional', ['none', 'low', 'medium', 'high', 'xhigh']],
          ['gpt-5.4-pro', 'always', ['medium', 'high', 'xhigh']],
          ['gpt-5.3-codex', 'always', ['low', 'medium', 'high', 'xhigh']],
          ['gpt-5.2', 'optional', ['none', 'low', 'medium', 'high', 'xhigh']],
          ['gpt-5.2-pro', 'always', ['medium', 'high', 'xhigh']],
          ['gpt-5.1', 'optional', ['none', 'low', 'medium', 'high']],
          ['gpt-5.1-codex-max', 'always', ['low', 'medium', 'high', 'xhigh']],
          ['gpt-5', 'always', ['minimal', 'low', 'medium', 'high']],
          ['gpt-5-codex', 'always', ['low', 'medium', 'high']],
          ['gpt-5-pro', 'always', ['high']],
          ['gpt-5-search-api', 'always', []],
          ['o1-mini', 'always', []],
          ['codex-mini-latest', 'always', ['low', 'medium', 'high']],
        ];
        for (const [id, mode, levels] of cases) {
          const m = getModelMetadataFor(apiDef, id);
          expect(m.reasoningMode, id).toBe(mode);
          expect(m.supportedReasoningEfforts, id).toEqual(levels);
        }
      });

      it('carries the xAI effort ladders, grok-4.3 and 4.6 included', () => {
        const apiDef = createApiDef({ apiType: 'chatgpt' });

        const grok43 = getModelMetadataFor(apiDef, 'grok-4.3');
        expect([grok43.inputPrice, grok43.cacheReadPrice, grok43.outputPrice]).toEqual([
          1.25, 0.2, 2.5,
        ]);
        expect(grok43.reasoningMode).toBe('optional');
        expect(grok43.supportedReasoningEfforts).toEqual([
          'none',
          'low',
          'medium',
          'high',
          'xhigh',
        ]);

        const grok46 = getModelMetadataFor(apiDef, 'grok-4.6');
        expect(grok46.inputPrice).toBe(2.0);
        expect(grok46.supportedReasoningEfforts).toEqual(['low', 'medium', 'high', 'xhigh']);
        expect(getModelMetadataFor(apiDef, 'grok-4.7').supportedReasoningEfforts).toEqual([
          'low',
          'medium',
          'high',
          'xhigh',
        ]);
      });

      it('carries the Gemini effort ladders and modes', () => {
        const google = createApiDef({ apiType: 'google' });
        const pro = getModelMetadataFor(google, 'gemini-3.1-pro-preview');
        expect(pro.supportedReasoningEfforts).toEqual(['low', 'medium', 'high']);
        expect(pro.reasoningMode).toBe('always');
        expect(getModelMetadataFor(google, 'gemini-2.5-pro').reasoningMode).toBe('always');
        // A zero thinking budget still switches 2.5 Flash off
        expect(getModelMetadataFor(google, 'gemini-2.5-flash').reasoningMode).toBe('optional');
      });

      it('carries the Doubao effort ladder', () => {
        const ark = createApiDef({ apiType: 'chatgpt' });
        for (const id of ['doubao-seed-2-1-pro-260915', 'doubao-seed-1-8-251228']) {
          expect(getModelMetadataFor(ark, id).supportedReasoningEfforts, id).toEqual([
            'low',
            'medium',
            'high',
          ]);
        }
      });

      it('routes the gpt-5.6 alias to Sol pricing', () => {
        const apiDef = createApiDef({ apiType: 'responses_api' });
        const result = getModelMetadataFor(apiDef, 'gpt-5.6');

        expect(result.matchedMode).toBe('exact');
        expect(result.inputPrice).toBe(4.0);
        expect(result.cacheReadPrice).toBe(0.4);
        expect(result.cacheWritePrice).toBe(5.0);
        expect(result.outputPrice).toBe(20.0);
        expect(result.supportedReasoningEfforts).toContain('max');
      });

      it('disambiguates gpt-5.6 Terra/Luna from the bare gpt-5.6 prefix', () => {
        const apiDef = createApiDef({ apiType: 'chatgpt' });

        const terra = getModelMetadataFor(apiDef, 'gpt-5.6-terra');
        expect(terra.inputPrice).toBe(2.0);
        expect(terra.outputPrice).toBe(12.0);

        const luna = getModelMetadataFor(apiDef, 'gpt-5.6-luna-2026-07-01');
        expect(luna.matchedMode).toBe('fuzz');
        expect(luna.inputPrice).toBe(0.2);
        expect(luna.outputPrice).toBe(1.2);

        // Dated bare snapshot still routes to Sol via prefix fuzz
        const datedSol = getModelMetadataFor(apiDef, 'gpt-5.6-2026-06-25');
        expect(datedSol.inputPrice).toBe(4.0);
      });

      it('matches grok-4.5 over the shorter grok-4 prefix', () => {
        const apiDef = createApiDef({ apiType: 'chatgpt' });

        const exact = getModelMetadataFor(apiDef, 'grok-4.5');
        expect(exact.matchedMode).toBe('exact');
        expect(exact.inputPrice).toBe(2.0);
        expect(exact.cacheReadPrice).toBe(0.3);
        expect(exact.outputPrice).toBe(6.0);
        expect(exact.contextWindow).toBe(500000);
        expect(exact.supportedReasoningEfforts).toEqual(['low', 'medium', 'high']);

        const dated = getModelMetadataFor(apiDef, 'grok-4.5-0715');
        expect(dated.matchedMode).toBe('fuzz');
        expect(dated.inputPrice).toBe(2.0);
      });

      it('matches doubao-seed-2-1-pro with cache pricing', () => {
        const apiDef = createApiDef({ apiType: 'chatgpt' });
        const result = getModelMetadataFor(apiDef, 'doubao-seed-2-1-pro-20260615');

        // ¥6 / ¥1.2 / ¥30 at 7.3 CNY per USD
        expect(result.matchedMode).toBe('fuzz');
        expect(result.inputPrice).toBeCloseTo(6 / 7.3);
        expect(result.cacheReadPrice).toBeCloseTo(1.2 / 7.3);
        expect(result.outputPrice).toBeCloseTo(30 / 7.3);
        expect(result.contextWindow).toBe(1024000);
        expect(result.maxOutputTokens).toBe(256000);
        expect(result.reasoningDialect).toBe('thinking-object');
      });

      it('prices Seed 2.0 by prompt length and the new Seed 2.1 models flat', () => {
        const apiDef = createApiDef({ apiType: 'chatgpt' });
        const pro20 = getModelMetadataFor(apiDef, 'doubao-seed-2-0-pro-260215');
        expect(pro20.inputPrice).toBeCloseTo(3.2 / 7.3);
        expect(pro20.contextPricingTiers?.map(tier => tier.thresholdTokens)).toEqual([
          32000, 128000,
        ]);
        expect(pro20.contextPricingTiers?.[1].outputPrice).toBeCloseTo(48 / 7.3);

        expect(getModelMetadataFor(apiDef, 'doubao-seed-2-1-lite-260915').inputPrice).toBeCloseTo(
          0.8 / 7.3
        );
        expect(getModelMetadataFor(apiDef, 'doubao-seed-2-1-turbo-260628').inputPrice).toBeCloseTo(
          3 / 7.3
        );
        expect(getModelMetadataFor(apiDef, 'doubao-seed-evolving').inputPrice).toBeCloseTo(6 / 7.3);
        expect(getModelMetadataFor(apiDef, 'ernie-5.1').inputPrice).toBeCloseTo(4 / 7.3);
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
        expect(result.reasoningDialect).toBe('enable-thinking');
        expect(result.supportedReasoningEfforts).toEqual(['low', 'medium', 'xhigh']);
      });

      it('matches Qwen 3.8 Flash with its Responses effort ladder', () => {
        const apiDef = createApiDef({ apiType: 'chatgpt' });
        const result = getModelMetadataFor(apiDef, 'qwen3.8-flash');

        expect([result.inputPrice, result.cacheReadPrice, result.outputPrice]).toEqual([
          0.15, 0.016, 0.47,
        ]);
        expect(result.reasoningDialect).toBe('enable-thinking');
        expect(result.supportedReasoningEfforts).toEqual(['low', 'medium', 'xhigh']);
        // Earlier 3.x models have no ladder
        expect(getModelMetadataFor(apiDef, 'qwen3.7-plus').supportedReasoningEfforts).toEqual([]);
      });

      it('matches Qwen 3.7 Max with input/cache/output pricing', () => {
        const apiDef = createApiDef({ apiType: 'chatgpt' });
        const result = getModelMetadataFor(apiDef, 'qwen3.7-max');

        expect(result.matchedMode).toBe('fuzz');
        expect(result.inputPrice).toBe(2.5);
        expect(result.cacheReadPrice).toBe(0.5);
        expect(result.outputPrice).toBe(7.5);
        expect(result.reasoningDialect).toBe('enable-thinking');
      });

      it('prices Qwen 3.6 Plus caching at the explicit-cache rates', () => {
        const apiDef = createApiDef({ apiType: 'chatgpt' });
        const result = getModelMetadataFor(apiDef, 'qwen3.6-plus');

        expect(result.inputPrice).toBe(0.5);
        expect(result.outputPrice).toBe(3.0);
        expect(result.cacheReadPrice).toBe(0.05);
        expect(result.cacheWritePrice).toBe(0.625);
        expect(result.maxOutputTokens).toBe(65536);
      });

      it('gives Qwen 3.7 Flash three prompt-length tiers', () => {
        const apiDef = createApiDef({ apiType: 'chatgpt' });
        const result = getModelMetadataFor(apiDef, 'qwen3.7-flash-2026-07-15');

        expect(result.inputPrice).toBe(0.03);
        // 100K prompt lands in the middle tier, 500K in the top one
        expect(calculateCost(result, 100_000, 0)).toBeCloseTo(0.01);
        expect(calculateCost(result, 500_000, 0)).toBeCloseTo(0.1);
      });

      it('bills Qwen 3.7 Plus at the base tier up to 256K and the high tier above it', () => {
        const apiDef = createApiDef({ apiType: 'chatgpt' });
        const result = getModelMetadataFor(apiDef, 'qwen3.7-plus');

        expect(result.inputPrice).toBe(0.4);
        expect(result.cacheReadPrice).toBe(0.08);
        expect(result.outputPrice).toBe(1.6);
        expect(result.contextPricingTiers).toEqual([
          { thresholdTokens: 262144, inputPrice: 1.2, cacheReadPrice: 0.24, outputPrice: 4.8 },
        ]);

        expect(calculateCost(result, 100_000, 0)).toBeCloseTo(0.04);
        // Over 256K every token bills at the high tier
        expect(calculateCost(result, 1_000_000, 0)).toBeCloseTo(1.2);
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

      it('disambiguates kimi-k3-256k from kimi-k3 by specificity', () => {
        const apiDef = createApiDef({ apiType: 'chatgpt' });

        const k3_256k = getModelMetadataFor(apiDef, 'kimi-k3-256k');
        expect(k3_256k.inputPrice).toBe(3.0);
        expect(k3_256k.cacheReadPrice).toBe(0.3);
        expect(k3_256k.outputPrice).toBe(15.0);
        expect(k3_256k.contextWindow).toBe(262144);
        expect(k3_256k.reasoningMode).toBe('always');
        expect(k3_256k.supportedReasoningEfforts).toEqual(['low', 'high', 'max']);

        const alias = getModelMetadataFor(apiDef, 'k3-256k');
        expect(alias.matchedMode).toBe('exact');
        expect(alias.contextWindow).toBe(262144);
      });

      it('keeps kimi-k3.1-pro and its highspeed tier off the kimi-k3 prefix', () => {
        const apiDef = createApiDef({ apiType: 'chatgpt' });

        const pro = getModelMetadataFor(apiDef, 'kimi-k3.1-pro');
        expect(pro.inputPrice).toBe(2.0);
        expect(pro.cacheReadPrice).toBe(0.2);
        expect(pro.outputPrice).toBe(10.0);
        expect(pro.contextWindow).toBe(1048576);
        expect(pro.reasoningMode).toBe('always');
        expect(pro.supportedReasoningEfforts).toEqual(['low', 'high', 'max']);
        expect(pro.reasoningDialect).toBeUndefined();

        const highspeed = getModelMetadataFor(apiDef, 'kimi-k3.1-pro-highspeed');
        expect(highspeed.inputPrice).toBe(4.0);
        expect(highspeed.cacheReadPrice).toBe(0.2);
        expect(highspeed.outputPrice).toBe(20.0);
        expect(highspeed.contextWindow).toBe(1048576);
      });

      it('gives Kimi K2.x the thinking object, keep only on K2.6', () => {
        const apiDef = createApiDef({ apiType: 'chatgpt' });

        const k26 = getModelMetadataFor(apiDef, 'kimi-k2.6');
        expect(k26.reasoningDialect).toBe('thinking-object');
        expect(k26.reasoningMode).toBe('optional');
        expect(k26.reasoningHistoryParam).toBe('thinking_keep');

        // K2.7 Code always keeps reasoning and errors on `type: "disabled"`
        for (const id of ['kimi-k2.7-code', 'kimi-k2.7-code-highspeed']) {
          const code = getModelMetadataFor(apiDef, id);
          expect(code.reasoningDialect).toBe('thinking-object');
          expect(code.reasoningMode).toBe('always');
          expect(code.reasoningHistoryParam).toBeUndefined();
        }

        const k3 = getModelMetadataFor(apiDef, 'kimi-k3');
        expect(k3.reasoningDialect).toBeUndefined();
        expect(k3.reasoningHistoryParam).toBeUndefined();
      });

      it('sets the reasoning-history switch per vendor', () => {
        const apiDef = createApiDef({ apiType: 'chatgpt' });

        expect(getModelMetadataFor(apiDef, 'qwen3.7-plus').reasoningHistoryParam).toBe(
          'preserve_thinking'
        );
        for (const id of ['glm-4.7', 'glm-5.2', 'glm-5.3-flash']) {
          expect(getModelMetadataFor(apiDef, id).reasoningHistoryParam).toBe('clear_thinking');
        }
        // `clear_thinking` arrived with 4.7
        expect(getModelMetadataFor(apiDef, 'glm-4.6').reasoningHistoryParam).toBeUndefined();
        expect(getModelMetadataFor(apiDef, 'glm-4.5-air').reasoningHistoryParam).toBeUndefined();
      });

      it('marks every DeepSeek model as mandating reasoning replay', () => {
        const apiDef = createApiDef({ apiType: 'chatgpt' });

        for (const id of [
          'deepseek-flash',
          'deepseek-v4-flash',
          'deepseek-v4-pro',
          'deepseek-chat',
        ]) {
          expect(getModelMetadataFor(apiDef, id).mandatesReasoningReplay).toBe(true);
        }
        expect(getModelMetadataFor(apiDef, 'glm-5.2').mandatesReasoningReplay).toBeUndefined();
      });

      it('serves deepseek-flash, the v4.1 spelling and the retired v4-flash name from one entry', () => {
        const apiDef = createApiDef({ apiType: 'chatgpt' });

        for (const id of ['deepseek-flash', 'deepseek-v4.1-flash', 'deepseek-v4-flash']) {
          const flash = getModelMetadataFor(apiDef, id);
          expect([flash.inputPrice, flash.cacheReadPrice, flash.outputPrice]).toEqual([
            0.3, 0.006, 1.2,
          ]);
          expect(flash.contextWindow).toBe(1048576);
          expect(flash.supportedReasoningEfforts).toEqual(['low', 'high', 'max']);
        }

        const pro = getModelMetadataFor(apiDef, 'deepseek-v4-pro');
        expect([pro.inputPrice, pro.cacheReadPrice, pro.outputPrice]).toEqual([1.32, 0.044, 3.96]);
        expect(pro.supportedReasoningEfforts).toEqual(['low', 'high', 'max']);
      });

      it('matches kimi-k2.5 and a dated kimi snapshot via prefix', () => {
        const apiDef = createApiDef({ apiType: 'chatgpt' });
        const result = getModelMetadataFor(apiDef, 'kimi-k2.5-20260101');

        expect(result.matchedMode).toBe('fuzz');
        expect(result.inputPrice).toBe(0.6);
        expect(result.cacheReadPrice).toBe(0.1);
        expect(result.outputPrice).toBe(3.0);
      });

      it('matches glm-5.3-flash at list price without hitting the glm-5 base entry', () => {
        const apiDef = createApiDef({ apiType: 'chatgpt' });
        const result = getModelMetadataFor(apiDef, 'glm-5.3-flash');

        expect(result.matchedMode).toBe('fuzz');
        expect(result.inputPrice).toBe(0.15);
        expect(result.cacheReadPrice).toBe(0.03);
        expect(result.outputPrice).toBe(0.5);
        expect(result.contextWindow).toBe(1048576);
        expect(result.maxOutputTokens).toBe(131072);
        // thinking.type only supports `enabled` on this model.
        expect(result.reasoningMode).toBe('always');
        expect(result.reasoningDialect).toBe('thinking-object');
      });

      it('gives glm-5.3 and glm-5.3-flashx their own entries', () => {
        const apiDef = createApiDef({ apiType: 'chatgpt' });

        const glm53 = getModelMetadataFor(apiDef, 'glm-5.3');
        expect([glm53.inputPrice, glm53.cacheReadPrice, glm53.outputPrice]).toEqual([
          1.4, 0.26, 4.4,
        ]);
        expect(glm53.contextWindow).toBe(1048576);
        expect(glm53.reasoningMode).toBe('always');
        expect(glm53.supportedReasoningEfforts).toEqual(['low', 'high', 'max']);
        expect(glm53.reasoningHistoryParam).toBe('clear_thinking');

        const flashx = getModelMetadataFor(apiDef, 'glm-5.3-flashx');
        expect([flashx.inputPrice, flashx.cacheReadPrice, flashx.outputPrice]).toEqual([
          0.37, 0.075, 1.25,
        ]);
        expect(flashx.reasoningMode).toBe('always');
      });

      it('matches GLM-5.2 and disambiguates from glm-5 base', () => {
        const apiDef = createApiDef({ apiType: 'chatgpt' });

        const glm52 = getModelMetadataFor(apiDef, 'glm-5.2');
        expect(glm52.inputPrice).toBe(1.4);
        expect(glm52.outputPrice).toBe(4.4);
        expect(glm52.reasoningMode).toBe('optional');
        expect(glm52.supportedReasoningEfforts).toEqual(['high', 'max']);
        // Effort arrived with 5.2
        expect(getModelMetadataFor(apiDef, 'glm-5.1').supportedReasoningEfforts).toEqual([]);

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
        expect(result.reasoningDialect).toBe('openai');
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

    describe('Claude context windows', () => {
      it('serves 1M natively from the 4.6 generation on', () => {
        const apiDef = createApiDef({ apiType: 'anthropic' });
        for (const id of [
          'claude-opus-4-6-20260101',
          'claude-opus-4-7',
          'claude-opus-4-8',
          'claude-sonnet-4-6',
          'claude-sonnet-5',
          'anthropic.claude-opus-4-6-20250514-v1:0',
          'anthropic.claude-sonnet-4-6-20250514-v1:0',
        ]) {
          expect(getModelMetadataFor(apiDef, id).contextWindow, id).toBe(1000000);
        }
        expect(getModelMetadataFor(apiDef, 'claude-sonnet-4-6').maxOutputTokens).toBe(128000);
      });

      it('keeps Sonnet 4.6 at 200K on claude-agent, where 1M needs usage credits', () => {
        const apiDef = createApiDef({ apiType: 'claude-agent' });
        const sonnet46 = getModelMetadataFor(apiDef, 'claude-sonnet-4-6');
        expect(sonnet46.contextWindow).toBe(200000);
        expect(sonnet46.inputPrice).toBe(3);
        expect(sonnet46.maxOutputTokens).toBe(128000);
        // Opus 4.6 gets `[1m]` there, so it keeps the 1M window
        expect(getModelMetadataFor(apiDef, 'claude-opus-4-6').contextWindow).toBe(1000000);
      });

      it('keeps Sonnet 4.5 and older at 200K', () => {
        const apiDef = createApiDef({ apiType: 'anthropic' });
        for (const id of [
          'claude-sonnet-4-5-20250514',
          'claude-sonnet-4-20250514',
          'claude-3-5-sonnet-20241022',
          'anthropic.claude-sonnet-4-5-20250514-v1:0',
        ]) {
          expect(getModelMetadataFor(apiDef, id).contextWindow, id).toBe(200000);
        }
        const haiku45 = getModelMetadataFor(apiDef, 'claude-haiku-4-5-20250101');
        expect(haiku45.contextWindow).toBe(200000);
        expect(haiku45.maxOutputTokens).toBe(64000);
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
        expect(result.inputPrice).toBe(1.25);
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

    it('bills every token at the context tier once the prompt is above its threshold', () => {
      const model = createModel({
        inputPrice: 1,
        outputPrice: 2,
        cacheReadPrice: 0.1,
        contextPricingTiers: [{ thresholdTokens: 100_000, inputPrice: 5, outputPrice: 10 }],
      });
      // 60K input + 40K cache read = 100K prompt: not above the threshold
      expect(calculateCost(model, 60_000, 1_000_000, 0, 0, 40_000)).toBeCloseTo(0.06 + 2 + 0.004);
      // One more token tips it over; the tier leaves cacheReadPrice unset
      expect(calculateCost(model, 60_001, 1_000_000, 0, 0, 40_000)).toBeCloseTo(
        (60_001 / 1_000_000) * 5 + 10 + 0.004
      );
    });

    it('prices reasoning tokens at the tier output price when reasoningPrice is unset', () => {
      const model = createModel({
        inputPrice: 1,
        outputPrice: 2,
        contextPricingTiers: [{ thresholdTokens: 1000, outputPrice: 3 }],
      });
      expect(calculateCost(model, 2000, 0, 1_000_000)).toBeCloseTo(0.002 + 3);
    });

    it('picks the tier from promptTokens when given (multi-call results)', () => {
      const model = createModel({
        inputPrice: 1,
        outputPrice: 2,
        contextPricingTiers: [{ thresholdTokens: 100_000, inputPrice: 5 }],
      });
      // 300K summed over several calls, but the largest single prompt was 80K
      const cost = calculateCost(model, 300_000, 0, 0, 0, 0, undefined, undefined, 1.0, 80_000);
      expect(cost).toBeCloseTo(0.3);
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
