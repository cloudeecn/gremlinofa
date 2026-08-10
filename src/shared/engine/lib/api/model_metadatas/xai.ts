import type { ModelKnowledge } from '../../../../protocol/types';

export const XAI_MODELS: ModelKnowledge[] = [
  // === Grok-4.7 ===
  {
    // Single model, no reasoning/non-reasoning split (unlike 4.20/4.3).
    // Prompts of 200K tokens or more bill at double rates for the whole
    // request — recorded but not applied (see unsupportedHighContextPricing).
    matches: [
      { apiType: ['chatgpt', 'responses_api'], modelIdExact: ['grok-4.7'] },
      { apiType: ['chatgpt', 'responses_api'], modelIdFuzz: [{ modelIdPrefix: 'grok-4.7' }] },
    ],
    inputPrice: 2.0,
    outputPrice: 6.0,
    cacheReadPrice: 0.5,
    unsupportedHighContextPricing: {
      thresholdTokens: 200000,
      inputPrice: 4.0,
      outputPrice: 12.0,
      cacheReadPrice: 1.0,
    },
    contextWindow: 500000,
    reasoningMode: 'always',
    supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'], // default high
    webSearchPrice: 0.01,
  },

  // === Grok-4.6 ===
  // Requests over 200K bill at higher rates the model page doesn't list.
  {
    matches: [
      { apiType: ['chatgpt', 'responses_api'], modelIdExact: ['grok-4.6'] },
      { apiType: ['chatgpt', 'responses_api'], modelIdFuzz: [{ modelIdPrefix: 'grok-4.6' }] },
    ],
    inputPrice: 2.0,
    outputPrice: 6.0,
    cacheReadPrice: 0.5,
    contextWindow: 500000,
    reasoningMode: 'always',
    supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'], // default high
    webSearchPrice: 0.01,
  },

  // === Grok-4.5 ===
  {
    matches: [
      { apiType: ['chatgpt', 'responses_api'], modelIdExact: ['grok-4.5'] },
      { apiType: ['chatgpt', 'responses_api'], modelIdFuzz: [{ modelIdPrefix: 'grok-4.5' }] },
    ],
    inputPrice: 2.0,
    outputPrice: 6.0,
    cacheReadPrice: 0.3,
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
    inputPrice: 1.25,
    outputPrice: 2.5,
    cacheReadPrice: 0.2,
    contextWindow: 1000000,
    reasoningMode: 'optional',
    supportedReasoningEfforts: ['none', 'low', 'medium', 'high', 'xhigh'],
    webSearchPrice: 0.01,
  },

  // === Grok-4 series ===
  {
    matches: [
      { apiType: ['chatgpt', 'responses_api'], modelIdExact: ['grok-4'] },
      { apiType: ['chatgpt', 'responses_api'], modelIdFuzz: [{ modelIdPrefix: 'grok-4' }] },
    ],
    inputPrice: 3.0,
    outputPrice: 15.0,
    cacheReadPrice: 0.75,
    contextWindow: 256000,
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
    inputPrice: 0.2,
    outputPrice: 0.5,
    cacheReadPrice: 0.05,
    contextWindow: 2000000,
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
    inputPrice: 0.2,
    outputPrice: 0.5,
    cacheReadPrice: 0.05,
    contextWindow: 2000000,
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
    inputPrice: 0.2,
    outputPrice: 0.5,
    cacheReadPrice: 0.05,
    contextWindow: 2000000,
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
    inputPrice: 0.2,
    outputPrice: 0.5,
    cacheReadPrice: 0.05,
    contextWindow: 2000000,
    reasoningMode: 'none',
    webSearchPrice: 0.01,
  },

  // === Grok-4.20 series ===
  {
    matches: [
      {
        apiType: ['chatgpt', 'responses_api'],
        modelIdFuzz: [{ modelIdPrefix: 'grok-4.20', modelIdPostfix: '-reasoning' }],
      },
    ],
    inputPrice: 2.0,
    outputPrice: 6.0,
    cacheReadPrice: 0.2,
    contextWindow: 2000000,
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
    inputPrice: 2.0,
    outputPrice: 6.0,
    cacheReadPrice: 0.2,
    contextWindow: 2000000,
    reasoningMode: 'none',
    webSearchPrice: 0.01,
  },

  // === Grok-3 series ===
  {
    matches: [
      { apiType: ['chatgpt', 'responses_api'], modelIdExact: ['grok-3'] },
      { apiType: ['chatgpt', 'responses_api'], modelIdFuzz: [{ modelIdPrefix: 'grok-3' }] },
    ],
    inputPrice: 3.0,
    outputPrice: 15.0,
    cacheReadPrice: 0.75,
    contextWindow: 131072,
    reasoningMode: 'none',
    webSearchPrice: 0.01,
  },
  {
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

  // === Grok Code ===
  {
    matches: [
      { apiType: ['chatgpt', 'responses_api'], modelIdExact: ['grok-code-fast-1'] },
      { apiType: ['chatgpt', 'responses_api'], modelIdFuzz: [{ modelIdPrefix: 'grok-code-fast' }] },
    ],
    inputPrice: 0.2,
    outputPrice: 1.5,
    cacheReadPrice: 0.05,
    contextWindow: 256000,
    reasoningMode: 'always',
    webSearchPrice: 0.01,
  },
];
