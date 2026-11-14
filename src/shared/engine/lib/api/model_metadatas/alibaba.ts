import type { ModelKnowledge } from '../../../../protocol/types';

// Alibaba Qwen (DashScope / OpenAI- & Anthropic-compatible endpoints).
// International (Singapore) prices, USD per 1M tokens. Every model here has a
// 1M context window. Context tiers are in binary K (32K = 32768, 256K =
// 262144), applied when the prompt is above the threshold.
//
// Effort levels are Responses-only (`reasoning.effort`, which outranks
// `enable_thinking` there). Chat Completions has no effort for these models,
// only `thinking_budget`, so the `enable-thinking` dialect never sends one.

/** Qwen 3.8's distinct levels on Responses; server default `xhigh`. */
const QWEN_3_8_EFFORTS: ModelKnowledge['supportedReasoningEfforts'] = ['low', 'medium', 'xhigh'];

const QWEN_API_TYPES: ModelKnowledge['matches'][number]['apiType'] = [
  'anthropic',
  'chatgpt',
  'responses_api',
];

const QWEN_COMMON = {
  contextWindow: 1048576,
  reasoningMode: 'optional',
  reasoningDialect: 'enable-thinking',
  reasoningHistoryParam: 'preserve_thinking',
  supportsTools: true,
} satisfies Partial<ModelKnowledge>;

export const ALIBABA_MODELS: ModelKnowledge[] = [
  // Qwen 3.8 Max (alias moved to the 0902 snapshot on 2026-09-05) and the
  // hosted open-weights qwen3.8-2.4t-a95b, same price. Flat across the full 1M
  // context. Cache read is the implicit-cache rate; explicit caching ($0.17
  // read / $2.50 write) not billed.
  {
    matches: [
      {
        apiType: QWEN_API_TYPES,
        modelIdFuzz: [{ modelIdPrefix: 'qwen3.8-max' }, { modelIdPrefix: 'qwen3.8-2.4t-a95b' }],
      },
    ],
    inputPrice: 2.0,
    cacheReadPrice: 0.25,
    outputPrice: 6.0,
    maxOutputTokens: 131072,
    supportedReasoningEfforts: QWEN_3_8_EFFORTS,
    ...QWEN_COMMON,
  },
  // Qwen 3.8 Flash. Implicit and explicit cache reads both bill 0.016.
  {
    matches: [{ apiType: QWEN_API_TYPES, modelIdFuzz: [{ modelIdPrefix: 'qwen3.8-flash' }] }],
    inputPrice: 0.15,
    cacheReadPrice: 0.016,
    outputPrice: 0.47,
    maxOutputTokens: 131072,
    supportedReasoningEfforts: QWEN_3_8_EFFORTS,
    ...QWEN_COMMON,
  },
  // Qwen 3.8 27B (2026-08-17), flat up to 1M. No published cache price.
  {
    matches: [{ apiType: QWEN_API_TYPES, modelIdFuzz: [{ modelIdPrefix: 'qwen3.8-27b' }] }],
    inputPrice: 0.5,
    outputPrice: 3.0,
    supportedReasoningEfforts: [],
    ...QWEN_COMMON,
  },
  // Qwen 3.7 Max
  {
    matches: [{ apiType: QWEN_API_TYPES, modelIdFuzz: [{ modelIdPrefix: 'qwen3.7-max' }] }],
    inputPrice: 2.5,
    cacheReadPrice: 0.5,
    outputPrice: 7.5,
    supportedReasoningEfforts: [],
    ...QWEN_COMMON,
  },
  // Qwen 3.7 Plus. Singapore lists it as "limited-time 20% off" with no
  // discounted figure and no end date, so the list price stays.
  {
    matches: [{ apiType: QWEN_API_TYPES, modelIdFuzz: [{ modelIdPrefix: 'qwen3.7-plus' }] }],
    inputPrice: 0.4,
    cacheReadPrice: 0.08,
    outputPrice: 1.6,
    contextPricingTiers: [
      { thresholdTokens: 262144, inputPrice: 1.2, cacheReadPrice: 0.24, outputPrice: 4.8 },
    ],
    supportedReasoningEfforts: [],
    ...QWEN_COMMON,
  },
  // Qwen 3.7 Flash (2026-07-21), three prompt-length tiers.
  {
    matches: [{ apiType: QWEN_API_TYPES, modelIdFuzz: [{ modelIdPrefix: 'qwen3.7-flash' }] }],
    inputPrice: 0.03,
    cacheReadPrice: 0.006,
    outputPrice: 0.13,
    contextPricingTiers: [
      { thresholdTokens: 32768, inputPrice: 0.1, cacheReadPrice: 0.02, outputPrice: 0.4 },
      { thresholdTokens: 262144, inputPrice: 0.2, cacheReadPrice: 0.04, outputPrice: 0.8 },
    ],
    maxOutputTokens: 131072,
    supportedReasoningEfforts: [],
    ...QWEN_COMMON,
  },
  // Qwen 3.6 Plus. Singapore has explicit caching only, so cache tokens bill
  // at the explicit rates.
  {
    matches: [{ apiType: QWEN_API_TYPES, modelIdFuzz: [{ modelIdPrefix: 'qwen3.6-plus' }] }],
    inputPrice: 0.5,
    cacheReadPrice: 0.05,
    cacheWritePrice: 0.625,
    outputPrice: 3.0,
    contextPricingTiers: [
      {
        thresholdTokens: 262144,
        inputPrice: 2.0,
        cacheReadPrice: 0.2,
        cacheWritePrice: 2.5,
        outputPrice: 6.0,
      },
    ],
    maxOutputTokens: 65536,
    supportedReasoningEfforts: [],
    ...QWEN_COMMON,
  },
  // Qwen 3.6 Flash. Explicit caching only, as on 3.6 Plus.
  {
    matches: [{ apiType: QWEN_API_TYPES, modelIdFuzz: [{ modelIdPrefix: 'qwen3.6-flash' }] }],
    inputPrice: 0.25,
    cacheReadPrice: 0.025,
    cacheWritePrice: 0.3125,
    outputPrice: 1.5,
    contextPricingTiers: [
      {
        thresholdTokens: 262144,
        inputPrice: 1.0,
        cacheReadPrice: 0.1,
        cacheWritePrice: 1.25,
        outputPrice: 4.0,
      },
    ],
    maxOutputTokens: 65536,
    supportedReasoningEfforts: [],
    ...QWEN_COMMON,
  },
];
