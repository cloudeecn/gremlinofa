import type { ModelKnowledge } from '../../../../protocol/types';

// Moonshot AI Kimi (OpenAI- & Anthropic-compatible endpoints).
// Prices are USD per 1M tokens: input / cached-input read / output.
// Max context is 262,144 tokens across the K2 line and K3-256k, 1M for K3 and
// K3.1 Pro. Where prefixes overlap (e.g. kimi-k3 vs kimi-k3-256k or
// kimi-k3.1-pro) the longer/more specific prefix wins via the specificity sort
// in modelMetadata.ts.
//
// K2.x takes `thinking: { type, keep }` and K3 takes `reasoning_effort`; the
// two must never meet in one request. Per the Kimi docs: K2.6 drops earlier
// turns' reasoning unless `keep: "all"`, K2.7 Code always keeps it and errors
// on `type: "disabled"`, and K3 has no `thinking` param at all.
export const MOONSHOT_MODELS: ModelKnowledge[] = [
  // Kimi K3.1 Pro (high-speed tier) — same model, double the input/output price.
  {
    matches: [
      {
        apiType: ['anthropic', 'chatgpt', 'responses_api'],
        modelIdFuzz: [{ modelIdPrefix: 'kimi-k3.1-pro-highspeed' }],
      },
    ],
    inputPrice: 4.0,
    cacheReadPrice: 0.2,
    outputPrice: 20.0,
    contextWindow: 1048576,
    reasoningMode: 'always',
    supportedReasoningEfforts: ['low', 'high', 'max'],
    supportsTools: true,
  },
  // Kimi K3.1 Pro — flat pricing across the 1M window. Same reasoning surface
  // as K3: always reasons, reasoning_effort low/high/max (default max).
  {
    matches: [
      {
        apiType: ['anthropic', 'chatgpt', 'responses_api'],
        modelIdFuzz: [{ modelIdPrefix: 'kimi-k3.1-pro' }],
      },
    ],
    inputPrice: 2.0,
    cacheReadPrice: 0.2,
    outputPrice: 10.0,
    contextWindow: 1048576,
    reasoningMode: 'always',
    supportedReasoningEfforts: ['low', 'high', 'max'],
    supportsTools: true,
  },
  // Kimi K3 256k — same model and pricing as K3, capped at 256k context.
  {
    matches: [
      {
        apiType: ['anthropic', 'chatgpt', 'responses_api'],
        modelIdExact: ['k3-256k'],
        modelIdFuzz: [{ modelIdPrefix: 'kimi-k3-256k' }],
      },
    ],
    inputPrice: 3.0,
    cacheReadPrice: 0.3,
    outputPrice: 15.0,
    contextWindow: 262144,
    reasoningMode: 'always',
    supportedReasoningEfforts: ['low', 'high', 'max'],
    supportsTools: true,
  },
  // Kimi K3 — flagship 1M-context model. Always reasons; reasoning_effort
  // accepts low/high/max (default max), so no de facto thinking toggle.
  {
    matches: [
      {
        apiType: ['anthropic', 'chatgpt', 'responses_api'],
        modelIdExact: ['k3'],
        modelIdFuzz: [{ modelIdPrefix: 'kimi-k3' }],
      },
    ],
    inputPrice: 3.0,
    cacheReadPrice: 0.3,
    outputPrice: 15.0,
    contextWindow: 1048576,
    reasoningMode: 'always',
    supportedReasoningEfforts: ['low', 'high', 'max'],
    supportsTools: true,
  },
  // Kimi K2.7 Code (high-speed tier)
  {
    matches: [
      {
        apiType: ['anthropic', 'chatgpt', 'responses_api'],
        modelIdFuzz: [{ modelIdPrefix: 'kimi-k2.7-code-highspeed' }],
      },
    ],
    inputPrice: 1.9,
    cacheReadPrice: 0.38,
    outputPrice: 8.0,
    contextWindow: 262144,
    reasoningMode: 'always',
    supportedReasoningEfforts: [],
    reasoningDialect: 'thinking-object',
    supportsTools: true,
  },
  // Kimi K2.7 Code
  {
    matches: [
      {
        apiType: ['anthropic', 'chatgpt', 'responses_api'],
        modelIdFuzz: [{ modelIdPrefix: 'kimi-k2.7-code' }],
      },
    ],
    inputPrice: 0.95,
    cacheReadPrice: 0.19,
    outputPrice: 4.0,
    contextWindow: 262144,
    reasoningMode: 'always',
    supportedReasoningEfforts: [],
    reasoningDialect: 'thinking-object',
    supportsTools: true,
  },
  // Kimi K2.6
  {
    matches: [
      {
        apiType: ['anthropic', 'chatgpt', 'responses_api'],
        modelIdFuzz: [{ modelIdPrefix: 'kimi-k2.6' }],
      },
    ],
    inputPrice: 0.95,
    cacheReadPrice: 0.16,
    outputPrice: 4.0,
    contextWindow: 262144,
    reasoningMode: 'optional',
    supportedReasoningEfforts: [],
    reasoningDialect: 'thinking-object',
    reasoningHistoryParam: 'thinking_keep',
    supportsTools: true,
  },
  // Kimi K2.5 (retired 2026-08)
  {
    matches: [
      {
        apiType: ['anthropic', 'chatgpt', 'responses_api'],
        modelIdFuzz: [{ modelIdPrefix: 'kimi-k2.5' }],
      },
    ],
    inputPrice: 0.6,
    cacheReadPrice: 0.1,
    outputPrice: 3.0,
    contextWindow: 262144,
    reasoningMode: 'optional',
    supportedReasoningEfforts: [],
    reasoningDialect: 'thinking-object',
    supportsTools: true,
  },
];
