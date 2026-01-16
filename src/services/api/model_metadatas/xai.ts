import type { ModelKnowledge } from '../../../types';

export const XAI_MODELS: ModelKnowledge[] = [
  // === Grok-4 series ===
  {
    matches: [
      { apiType: ['chatgpt', 'responses_api'], modelIdExact: ['grok-4'] },
      { apiType: ['chatgpt', 'responses_api'], modelIdFuzz: [{ modelIdPrefix: 'grok-4' }] },
    ],
    inputPrice: 3.0,
    outputPrice: 15.0,
    cacheReadPrice: 3.0,
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
    cacheReadPrice: 0.2,
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
    cacheReadPrice: 0.2,
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
    cacheReadPrice: 0.2,
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
    cacheReadPrice: 3.0,
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
    cacheReadPrice: 0.3,
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
    cacheReadPrice: 0.2,
    contextWindow: 256000,
    reasoningMode: 'always',
    webSearchPrice: 0.01,
  },
];
