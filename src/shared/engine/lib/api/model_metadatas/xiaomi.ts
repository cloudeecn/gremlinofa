import type { ModelKnowledge } from '../../../../protocol/types';

// Xiaomi MiMo. No effort ladder: Chat Completions takes only `thinking.type`,
// and on Responses `reasoning.effort: none` switches thinking off while every
// other level just switches it on. Overseas pay-as-you-go prices, USD per 1M.
export const XIAOMI_MODELS: ModelKnowledge[] = [
  {
    // UltraSpeed is a flat 10x the price of plain -pro for ~10x output
    // throughput; the cache-read rate is scaled by the same factor rather than
    // quoted separately. Its longer prefix outranks the `mimo-v2.6-pro` entry
    // below, which would otherwise match the UltraSpeed id and price it 10x low.
    matches: [
      {
        apiType: ['anthropic', 'chatgpt', 'responses_api'],
        modelIdFuzz: [{ modelIdPrefix: 'mimo-v2.6-pro-ultraspeed' }],
      },
    ],
    inputPrice: 4.35,
    cacheReadPrice: 0.036,
    outputPrice: 8.7,
    contextWindow: 1048576,
    maxOutputTokens: 131072,
    reasoningMode: 'optional',
    supportedReasoningEfforts: [],
    reasoningDialect: 'thinking-object',
  },
  {
    matches: [
      {
        apiType: ['anthropic', 'chatgpt', 'responses_api'],
        modelIdFuzz: [{ modelIdPrefix: 'mimo-v2.6-pro' }],
      },
    ],
    inputPrice: 0.435,
    cacheReadPrice: 0.0036,
    outputPrice: 0.87,
    contextWindow: 1048576,
    maxOutputTokens: 131072,
    reasoningMode: 'optional',
    supportedReasoningEfforts: [],
    reasoningDialect: 'thinking-object',
  },
  {
    // mimo-v2.5 (deprecated 2026-10-21) bills the same. It sits in its own
    // match because an entry ranks by its longest prefix, and sharing one with
    // mimo-v2.6-flash would outrank mimo-v2.5-pro.
    matches: [
      {
        apiType: ['anthropic', 'chatgpt', 'responses_api'],
        modelIdFuzz: [{ modelIdPrefix: 'mimo-v2.6-flash' }],
      },
      {
        apiType: ['anthropic', 'chatgpt', 'responses_api'],
        modelIdFuzz: [{ modelIdPrefix: 'mimo-v2.5' }],
      },
    ],
    inputPrice: 0.14,
    cacheReadPrice: 0.0028,
    outputPrice: 0.28,
    reasoningMode: 'optional',
    supportedReasoningEfforts: [],
    reasoningDialect: 'thinking-object',
  },
  {
    matches: [
      {
        apiType: ['anthropic', 'chatgpt', 'responses_api'],
        modelIdFuzz: [{ modelIdPrefix: 'mimo-v2-pro' }],
      },
    ],
    inputPrice: 1.0,
    cacheReadPrice: 0.2,
    outputPrice: 3.0,
    reasoningMode: 'optional',
    supportedReasoningEfforts: [],
    reasoningDialect: 'thinking-object',
  },
  {
    matches: [
      {
        apiType: ['anthropic', 'chatgpt', 'responses_api'],
        modelIdFuzz: [{ modelIdPrefix: 'mimo-v2.5-pro' }],
      },
    ],
    // Billed as mimo-v2.6-pro; deprecated 2026-10-21.
    inputPrice: 0.435,
    cacheReadPrice: 0.0036,
    outputPrice: 0.87,
    reasoningMode: 'optional',
    supportedReasoningEfforts: [],
    reasoningDialect: 'thinking-object',
  },
  {
    matches: [
      {
        apiType: ['anthropic', 'chatgpt', 'responses_api'],
        modelIdFuzz: [{ modelIdPrefix: 'mimo-v2-omni' }],
      },
    ],
    inputPrice: 0.4,
    cacheReadPrice: 0.08,
    outputPrice: 2.0,
    reasoningMode: 'optional',
    supportedReasoningEfforts: [],
    reasoningDialect: 'thinking-object',
  },
];
