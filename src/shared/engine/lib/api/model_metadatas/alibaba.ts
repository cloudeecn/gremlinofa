import type { ModelKnowledge } from '../../../../protocol/types';

// Alibaba Qwen (DashScope / OpenAI- & Anthropic-compatible endpoints).
// Prices are USD per 1M tokens: input / cached-input read / output.
export const ALIBABA_MODELS: ModelKnowledge[] = [
  // Qwen 3.8 Max — flat pricing across the full 1M context. Cache read is the
  // implicit-cache rate; explicit caching ($0.17 read / $2.50 write) not billed.
  {
    matches: [
      {
        apiType: ['anthropic', 'chatgpt', 'responses_api'],
        modelIdFuzz: [{ modelIdPrefix: 'qwen3.8-max' }],
      },
    ],
    inputPrice: 2.0,
    cacheReadPrice: 0.25,
    outputPrice: 6.0,
    reasoningMode: 'optional',
    supportedReasoningEfforts: [],
    deFactoThinking: true,
    supportsTools: true,
  },
  // Qwen 3.7 Max
  {
    matches: [
      {
        apiType: ['anthropic', 'chatgpt', 'responses_api'],
        modelIdFuzz: [{ modelIdPrefix: 'qwen3.7-max' }],
      },
    ],
    inputPrice: 2.5,
    cacheReadPrice: 0.5,
    outputPrice: 7.5,
    reasoningMode: 'optional',
    supportedReasoningEfforts: [],
    deFactoThinking: true,
    supportsTools: true,
  },
  // Qwen 3.7 Plus — tiered by context length. We bill the base (<256K) tier;
  // the >=256K tier lives in unsupportedHighContextPricing and is not applied.
  {
    matches: [
      {
        apiType: ['anthropic', 'chatgpt', 'responses_api'],
        modelIdFuzz: [{ modelIdPrefix: 'qwen3.7-plus' }],
      },
    ],
    inputPrice: 0.4,
    cacheReadPrice: 0.08,
    outputPrice: 1.6,
    unsupportedHighContextPricing: {
      thresholdTokens: 262144, // 256K
      inputPrice: 1.2,
      cacheReadPrice: 0.24,
      outputPrice: 4.8,
    },
    reasoningMode: 'optional',
    supportedReasoningEfforts: [],
    deFactoThinking: true,
    supportsTools: true,
  },
  // Qwen 3.6 Plus — no separate cached-input price (cache reads fall back to input)
  {
    matches: [
      {
        apiType: ['anthropic', 'chatgpt', 'responses_api'],
        modelIdFuzz: [{ modelIdPrefix: 'qwen3.6-plus' }],
      },
    ],
    inputPrice: 0.5,
    outputPrice: 3.0,
    reasoningMode: 'optional',
    supportedReasoningEfforts: [],
    deFactoThinking: true,
    supportsTools: true,
  },
];
