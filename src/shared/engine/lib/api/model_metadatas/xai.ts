import type { ModelKnowledge } from '../../../../protocol/types';

// A prompt of 200K tokens or more bills every token of the request at the
// `contextPricingTiers` rate (threshold 199999: tiers apply strictly above it).
const LONG_PROMPT = 199999;

// Grok 4.3's rates, which the slugs retired on 2026-05-15 (grok-4, grok-4-0709,
// the 4 / 4.1 fast models, grok-3) now redirect to and bill at.
const GROK_4_3_PRICING = {
  inputPrice: 1.25,
  outputPrice: 2.5,
  cacheReadPrice: 0.2,
  contextPricingTiers: [
    { thresholdTokens: LONG_PROMPT, inputPrice: 2.5, outputPrice: 5.0, cacheReadPrice: 0.4 },
  ],
  contextWindow: 1000000,
} satisfies Partial<ModelKnowledge>;

export const XAI_MODELS: ModelKnowledge[] = [
  // === Grok-4.7 ===
  {
    // Single model, no reasoning/non-reasoning split (unlike 4.20/4.3). Newest
    // Grok, so it carries the `grok-4` catch-all for unknown 4.x ids.
    matches: [
      { apiType: ['chatgpt', 'responses_api'], modelIdExact: ['grok-4.7'] },
      { apiType: ['chatgpt', 'responses_api'], modelIdFuzz: [{ modelIdPrefix: 'grok-4.7' }] },
      {
        apiType: ['chatgpt', 'responses_api'],
        modelIdFuzz: [{ modelIdPrefix: 'grok-4', unreliable: true }], // fuzz match all future grok-4.x
      },
    ],
    inputPrice: 2.0,
    outputPrice: 6.0,
    cacheReadPrice: 0.5,
    contextPricingTiers: [
      { thresholdTokens: LONG_PROMPT, inputPrice: 4.0, outputPrice: 12.0, cacheReadPrice: 1.0 },
    ],
    contextWindow: 500000,
    reasoningMode: 'always',
    supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'], // default high
    webSearchPrice: 0.01,
  },

  // === Grok-4.6 ===
  {
    matches: [
      { apiType: ['chatgpt', 'responses_api'], modelIdExact: ['grok-4.6'] },
      { apiType: ['chatgpt', 'responses_api'], modelIdFuzz: [{ modelIdPrefix: 'grok-4.6' }] },
    ],
    inputPrice: 2.0,
    outputPrice: 6.0,
    cacheReadPrice: 0.5,
    contextPricingTiers: [
      { thresholdTokens: LONG_PROMPT, inputPrice: 4.0, outputPrice: 12.0, cacheReadPrice: 1.0 },
    ],
    contextWindow: 500000,
    reasoningMode: 'always',
    supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'], // default high
    webSearchPrice: 0.01,
  },

  // === Grok-4.5 ===
  {
    matches: [
      // `grok-build-latest` aliases grok-4.5, not grok-build-0.1.
      { apiType: ['chatgpt', 'responses_api'], modelIdExact: ['grok-4.5', 'grok-build-latest'] },
      { apiType: ['chatgpt', 'responses_api'], modelIdFuzz: [{ modelIdPrefix: 'grok-4.5' }] },
    ],
    inputPrice: 2.0,
    outputPrice: 6.0,
    cacheReadPrice: 0.3,
    contextPricingTiers: [
      { thresholdTokens: LONG_PROMPT, inputPrice: 4.0, outputPrice: 12.0, cacheReadPrice: 0.6 },
    ],
    contextWindow: 500000,
    reasoningMode: 'always',
    // `xhigh` arrived with grok-4.6; this model treats it as `high`.
    supportedReasoningEfforts: ['low', 'medium', 'high'],
    webSearchPrice: 0.01,
  },

  // === Grok-4.3 ===
  // The one current Grok that can switch reasoning off (`none`); default `low`.
  {
    matches: [
      { apiType: ['chatgpt', 'responses_api'], modelIdExact: ['grok-4.3'] },
      { apiType: ['chatgpt', 'responses_api'], modelIdFuzz: [{ modelIdPrefix: 'grok-4.3' }] },
    ],
    ...GROK_4_3_PRICING,
    reasoningMode: 'optional',
    supportedReasoningEfforts: ['none', 'low', 'medium', 'high', 'xhigh'],
    webSearchPrice: 0.01,
  },

  // === Grok-4.20 series ===
  // Repriced to Grok 4.3's rates (and 2M → 1M context) around 2026-05.
  {
    matches: [
      {
        apiType: ['chatgpt', 'responses_api'],
        modelIdFuzz: [{ modelIdPrefix: 'grok-4.20', modelIdPostfix: '-reasoning' }],
      },
    ],
    ...GROK_4_3_PRICING,
    reasoningMode: 'always',
    supportedReasoningEfforts: [],
    webSearchPrice: 0.01,
  },
  {
    matches: [
      {
        apiType: ['chatgpt', 'responses_api'],
        modelIdFuzz: [{ modelIdPrefix: 'grok-4.20', modelIdPostfix: '-non-reasoning' }],
      },
    ],
    ...GROK_4_3_PRICING,
    reasoningMode: 'none',
    webSearchPrice: 0.01,
  },
  {
    // Bare and beta aliases (`grok-4.20`, `grok-4.20-0309`, `-beta-latest`)
    // and `grok-4.20-multi-agent-*`, all at the same price.
    matches: [
      { apiType: ['chatgpt', 'responses_api'], modelIdFuzz: [{ modelIdPrefix: 'grok-4.20' }] },
    ],
    ...GROK_4_3_PRICING,
    reasoningMode: 'always',
    supportedReasoningEfforts: [],
    webSearchPrice: 0.01,
  },

  // === Retired 2026-05-15, redirected to grok-4.3 ===
  // Reasoning variants run at effort `low` there, the others at `none`.
  {
    matches: [{ apiType: ['chatgpt', 'responses_api'], modelIdExact: ['grok-4', 'grok-4-0709'] }],
    ...GROK_4_3_PRICING,
    reasoningMode: 'always',
    supportedReasoningEfforts: [],
    webSearchPrice: 0.01,
  },
  {
    matches: [
      { apiType: ['chatgpt', 'responses_api'], modelIdExact: ['grok-4-fast-reasoning'] },
      {
        apiType: ['chatgpt', 'responses_api'],
        modelIdFuzz: [{ modelIdPrefix: 'grok-4', modelIdPostfix: '-fast-reasoning' }],
      },
    ],
    ...GROK_4_3_PRICING,
    reasoningMode: 'always',
    supportedReasoningEfforts: [],
    webSearchPrice: 0.01,
  },
  {
    matches: [
      { apiType: ['chatgpt', 'responses_api'], modelIdExact: ['grok-4-fast-non-reasoning'] },
      {
        apiType: ['chatgpt', 'responses_api'],
        modelIdFuzz: [{ modelIdPrefix: 'grok-4', modelIdPostfix: '-fast-non-reasoning' }],
      },
    ],
    ...GROK_4_3_PRICING,
    reasoningMode: 'none',
    webSearchPrice: 0.01,
  },
  {
    matches: [
      { apiType: ['chatgpt', 'responses_api'], modelIdExact: ['grok-4-1-fast-reasoning'] },
      {
        apiType: ['chatgpt', 'responses_api'],
        modelIdFuzz: [{ modelIdPrefix: 'grok-4-1', modelIdPostfix: '-fast-reasoning' }],
      },
    ],
    ...GROK_4_3_PRICING,
    reasoningMode: 'always',
    supportedReasoningEfforts: [],
    webSearchPrice: 0.01,
  },
  {
    matches: [
      { apiType: ['chatgpt', 'responses_api'], modelIdExact: ['grok-4-1-fast-non-reasoning'] },
      {
        apiType: ['chatgpt', 'responses_api'],
        modelIdFuzz: [{ modelIdPrefix: 'grok-4-1', modelIdPostfix: '-fast-non-reasoning' }],
      },
    ],
    ...GROK_4_3_PRICING,
    reasoningMode: 'none',
    webSearchPrice: 0.01,
  },
  {
    matches: [
      { apiType: ['chatgpt', 'responses_api'], modelIdExact: ['grok-3'] },
      { apiType: ['chatgpt', 'responses_api'], modelIdFuzz: [{ modelIdPrefix: 'grok-3' }] },
    ],
    ...GROK_4_3_PRICING,
    reasoningMode: 'none',
    webSearchPrice: 0.01,
  },
  {
    // Retired (gone from the model list by 2026-05); last known price.
    matches: [
      { apiType: ['chatgpt', 'responses_api'], modelIdExact: ['grok-3-mini'] },
      {
        apiType: ['chatgpt', 'responses_api'],
        modelIdFuzz: [{ modelIdPrefix: 'grok-3', modelIdPostfix: '-mini' }],
      },
    ],
    inputPrice: 0.3,
    outputPrice: 0.5,
    cacheReadPrice: 0.075,
    contextWindow: 131072,
    reasoningMode: 'always',
    supportedReasoningEfforts: ['low', 'high'],
    webSearchPrice: 0.01,
  },

  // === Grok Build ===
  {
    // grok-build-0.1 (public beta 2026-05-29). The old `grok-code-fast-1`
    // slugs are its aliases now.
    matches: [
      {
        apiType: ['chatgpt', 'responses_api'],
        modelIdFuzz: [{ modelIdPrefix: 'grok-build-0' }, { modelIdPrefix: 'grok-code-fast' }],
      },
    ],
    inputPrice: 1.0,
    outputPrice: 2.0,
    cacheReadPrice: 0.2,
    contextPricingTiers: [
      { thresholdTokens: LONG_PROMPT, inputPrice: 2.0, outputPrice: 4.0, cacheReadPrice: 0.4 },
    ],
    contextWindow: 256000,
    reasoningMode: 'always',
    webSearchPrice: 0.01,
  },
];
