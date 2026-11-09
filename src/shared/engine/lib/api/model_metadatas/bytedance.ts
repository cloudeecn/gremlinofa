import type { ContextPricingTier, ModelKnowledge } from '../../../../protocol/types';
import { cny } from './currency';

// Doubao Seed: `reasoning_effort` (Chat) / `reasoning.effort` (Responses) take
// all seven values, but only low / medium / high are distinct: `minimal` and
// `none` switch thinking off, `xhigh` / `max` map to high. Default medium
// (high on Seed 2.1). Prefixes match Volcengine ids only, not BytePlus ones.
//
// Prices are Volcengine's CNY list (input / cache read / output per 1M),
// converted with `cny()`. Context sizes and tier thresholds use Volcengine's
// decimal K (32K = 32000).

/** A prompt-length tier given in CNY. */
function cnyTier(
  thresholdTokens: number,
  input: number,
  cacheRead: number,
  output: number
): ContextPricingTier {
  return {
    thresholdTokens,
    inputPrice: cny(input),
    cacheReadPrice: cny(cacheRead),
    outputPrice: cny(output),
  };
}

function seed(
  modelIdPrefix: string,
  input: number,
  cacheRead: number,
  output: number,
  extra: Partial<ModelKnowledge>
): ModelKnowledge {
  return {
    matches: [
      { apiType: ['anthropic', 'chatgpt', 'responses_api'], modelIdFuzz: [{ modelIdPrefix }] },
    ],
    inputPrice: cny(input),
    cacheReadPrice: cny(cacheRead),
    outputPrice: cny(output),
    reasoningMode: 'optional',
    supportedReasoningEfforts: ['low', 'medium', 'high'],
    reasoningDialect: 'thinking-object',
    supportsTools: true,
    ...extra,
  };
}

export const BYTEDANCE_MODELS: ModelKnowledge[] = [
  // Seed 2.1: one flat price across the whole window.
  seed('doubao-seed-2-1-pro', 6, 1.2, 30, { contextWindow: 1024000, maxOutputTokens: 256000 }),
  seed('doubao-seed-2-1-turbo', 3, 0.6, 15, { contextWindow: 256000, maxOutputTokens: 256000 }),
  seed('doubao-seed-2-1-lite', 0.8, 0.16, 2.7, { contextWindow: 1024000, maxOutputTokens: 256000 }),
  // Fast-moving alias without a date suffix, priced as 2.1 Pro.
  seed('doubao-seed-evolving', 6, 1.2, 30, { contextWindow: 1024000, maxOutputTokens: 256000 }),

  // Seed 2.0: priced by prompt length. Pro and Code Preview stop working on
  // 2026-11-24 (no newer 2.0 Pro snapshot).
  seed('doubao-seed-2-0-pro', 3.2, 0.64, 16, {
    contextPricingTiers: [cnyTier(32000, 4.8, 0.96, 24), cnyTier(128000, 9.6, 1.92, 48)],
    contextWindow: 256000,
    maxOutputTokens: 128000,
  }),
  seed('doubao-seed-2-0-code', 3.2, 0.64, 16, {
    contextPricingTiers: [cnyTier(32000, 4.8, 0.96, 24), cnyTier(128000, 9.6, 1.92, 48)],
    contextWindow: 256000,
    maxOutputTokens: 128000,
  }),
  seed('doubao-seed-2-0-lite', 0.6, 0.12, 3.6, {
    contextPricingTiers: [cnyTier(32000, 0.9, 0.18, 5.4), cnyTier(128000, 1.8, 0.36, 10.8)],
    contextWindow: 256000,
    maxOutputTokens: 128000,
  }),
  seed('doubao-seed-2-0-mini', 0.2, 0.04, 2, {
    contextPricingTiers: [cnyTier(32000, 0.4, 0.08, 4), cnyTier(128000, 0.8, 0.16, 8)],
    contextWindow: 256000,
    maxOutputTokens: 128000,
  }),

  // Seed 1.8 — retired 2026-09-21 (replaced by 2.0 Lite); last known price.
  seed('doubao-seed-1-8', 0.8, 0.16, 2, { contextWindow: 256000, maxOutputTokens: 64000 }),
];
