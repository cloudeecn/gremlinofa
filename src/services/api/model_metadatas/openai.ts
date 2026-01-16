import type { ModelKnowledge } from '../../../types';

export const OPENAI_MODELS: ModelKnowledge[] = [
  // === GPT-5.2 series ===
  {
    matches: [
      { apiType: ['chatgpt', 'responses_api'], modelIdExact: ['gpt-5.2'] },
      {
        apiType: ['chatgpt', 'responses_api'],
        modelIdFuzz: [{ modelIdPrefix: 'gpt-5.', unreliable: true }],
      }, // fuzz match all future gpt-5.*
      { apiType: ['chatgpt', 'responses_api'], modelIdFuzz: [{ modelIdPrefix: 'gpt-5.2' }] },
    ],
    inputPrice: 1.75,
    outputPrice: 14.0,
    cacheReadPrice: 0.175,
    contextWindow: 128000,
    reasoningMode: 'always',
    supportedReasoningEfforts: ['none', 'minimal', 'low', 'medium', 'high'],
    webSearchPrice: 0.01,
  },
  {
    matches: [
      { apiType: ['chatgpt', 'responses_api'], modelIdExact: ['gpt-5.2-chat-latest'] },
      {
        apiType: ['chatgpt', 'responses_api'],
        modelIdFuzz: [{ modelIdPrefix: 'gpt-5.2', modelIdPostfix: '-chat-latest' }],
      },
    ],
    inputPrice: 1.75,
    outputPrice: 14.0,
    cacheReadPrice: 0.175,
    contextWindow: 128000,
    reasoningMode: 'always',
    supportedReasoningEfforts: ['medium'],
    webSearchPrice: 0.01,
  },
  {
    matches: [
      { apiType: ['chatgpt', 'responses_api'], modelIdExact: ['gpt-5.2-codex'] },
      {
        apiType: ['chatgpt', 'responses_api'],
        modelIdFuzz: [{ modelIdPrefix: 'gpt-5.2', modelIdPostfix: '-codex' }],
      },
    ],
    inputPrice: 1.75,
    outputPrice: 14.0,
    cacheReadPrice: 0.175,
    contextWindow: 128000,
    reasoningMode: 'always',
    supportedReasoningEfforts: ['none', 'minimal', 'low', 'medium', 'high'],
    webSearchPrice: 0.01,
  },
  {
    matches: [
      { apiType: ['chatgpt', 'responses_api'], modelIdExact: ['gpt-5.2-pro'] },
      {
        apiType: ['chatgpt', 'responses_api'],
        modelIdFuzz: [{ modelIdPrefix: 'gpt-5.2-pro' }],
      },
      {
        apiType: ['chatgpt', 'responses_api'],
        modelIdFuzz: [{ modelIdPrefix: 'gpt-5.2', modelIdPostfix: '-pro' }],
      },
    ],
    inputPrice: 21.0,
    outputPrice: 168.0,
    contextWindow: 128000,
    reasoningMode: 'always',
    supportedReasoningEfforts: ['none', 'minimal', 'low', 'medium', 'high'],
    webSearchPrice: 0.01,
  },

  // === GPT-5.1 series ===
  {
    matches: [
      { apiType: ['chatgpt', 'responses_api'], modelIdExact: ['gpt-5.1'] },
      { apiType: ['chatgpt', 'responses_api'], modelIdFuzz: [{ modelIdPrefix: 'gpt-5.1' }] },
    ],
    inputPrice: 1.25,
    outputPrice: 10.0,
    cacheReadPrice: 0.125,
    contextWindow: 128000,
    reasoningMode: 'always',
    supportedReasoningEfforts: ['none', 'minimal', 'low', 'medium', 'high'],
    webSearchPrice: 0.01,
  },
  {
    matches: [
      { apiType: ['chatgpt', 'responses_api'], modelIdExact: ['gpt-5.1-chat-latest'] },
      {
        apiType: ['chatgpt', 'responses_api'],
        modelIdFuzz: [{ modelIdPrefix: 'gpt-5.1', modelIdPostfix: '-chat-latest' }],
      },
    ],
    inputPrice: 1.25,
    outputPrice: 10.0,
    cacheReadPrice: 0.125,
    contextWindow: 128000,
    reasoningMode: 'always',
    supportedReasoningEfforts: ['medium'],
    webSearchPrice: 0.01,
  },
  {
    matches: [
      { apiType: ['chatgpt', 'responses_api'], modelIdExact: ['gpt-5.1-codex-max'] },
      {
        apiType: ['chatgpt', 'responses_api'],
        modelIdFuzz: [{ modelIdPrefix: 'gpt-5.1', modelIdPostfix: '-codex-max' }],
      },
    ],
    inputPrice: 1.25,
    outputPrice: 10.0,
    cacheReadPrice: 0.125,
    contextWindow: 128000,
    reasoningMode: 'always',
    supportedReasoningEfforts: ['none', 'minimal', 'low', 'medium', 'high'],
    webSearchPrice: 0.01,
  },
  {
    matches: [
      { apiType: ['chatgpt', 'responses_api'], modelIdExact: ['gpt-5.1-codex'] },
      {
        apiType: ['chatgpt', 'responses_api'],
        modelIdFuzz: [{ modelIdPrefix: 'gpt-5.1', modelIdPostfix: '-codex' }],
      },
    ],
    inputPrice: 1.25,
    outputPrice: 10.0,
    cacheReadPrice: 0.125,
    contextWindow: 128000,
    reasoningMode: 'always',
    supportedReasoningEfforts: ['none', 'minimal', 'low', 'medium', 'high'],
    webSearchPrice: 0.01,
  },
  {
    matches: [
      { apiType: ['chatgpt', 'responses_api'], modelIdExact: ['gpt-5.1-codex-mini'] },
      {
        apiType: ['chatgpt', 'responses_api'],
        modelIdFuzz: [{ modelIdPrefix: 'gpt-5.1', modelIdPostfix: '-codex-mini' }],
      },
    ],
    inputPrice: 0.25,
    outputPrice: 2.0,
    cacheReadPrice: 0.025,
    contextWindow: 128000,
    reasoningMode: 'always',
    supportedReasoningEfforts: ['none', 'minimal', 'low', 'medium', 'high'],
    webSearchPrice: 0.01,
  },

  // === GPT-5 series ===
  {
    matches: [
      { apiType: ['chatgpt', 'responses_api'], modelIdExact: ['gpt-5'] },
      { apiType: ['chatgpt', 'responses_api'], modelIdFuzz: [{ modelIdPrefix: 'gpt-5' }] },
    ],
    inputPrice: 1.25,
    outputPrice: 10.0,
    cacheReadPrice: 0.125,
    contextWindow: 128000,
    reasoningMode: 'always',
    supportedReasoningEfforts: ['minimal', 'low', 'medium', 'high'],
    webSearchPrice: 0.01,
  },
  {
    matches: [
      { apiType: ['chatgpt', 'responses_api'], modelIdExact: ['gpt-5-mini'] },
      {
        apiType: ['chatgpt', 'responses_api'],
        modelIdFuzz: [{ modelIdPrefix: 'gpt-5', modelIdPostfix: '-mini' }],
      },
    ],
    inputPrice: 0.25,
    outputPrice: 2.0,
    cacheReadPrice: 0.025,
    contextWindow: 128000,
    reasoningMode: 'always',
    supportedReasoningEfforts: ['minimal', 'low', 'medium', 'high'],
    webSearchPrice: 0.01,
  },
  {
    matches: [
      { apiType: ['chatgpt', 'responses_api'], modelIdExact: ['gpt-5-nano'] },
      {
        apiType: ['chatgpt', 'responses_api'],
        modelIdFuzz: [{ modelIdPrefix: 'gpt-5', modelIdPostfix: '-nano' }],
      },
    ],
    inputPrice: 0.05,
    outputPrice: 0.4,
    cacheReadPrice: 0.005,
    contextWindow: 128000,
    reasoningMode: 'always',
    supportedReasoningEfforts: ['minimal', 'low', 'medium', 'high'],
    webSearchPrice: 0.01,
  },
  {
    matches: [
      { apiType: ['chatgpt', 'responses_api'], modelIdExact: ['gpt-5-chat-latest'] },
      {
        apiType: ['chatgpt', 'responses_api'],
        modelIdFuzz: [{ modelIdPrefix: 'gpt-5', modelIdPostfix: '-chat-latest' }],
      },
    ],
    inputPrice: 1.25,
    outputPrice: 10.0,
    cacheReadPrice: 0.125,
    contextWindow: 128000,
    reasoningMode: 'none',
    webSearchPrice: 0.01,
  },
  {
    matches: [
      { apiType: ['chatgpt', 'responses_api'], modelIdExact: ['gpt-5-codex'] },
      {
        apiType: ['chatgpt', 'responses_api'],
        modelIdFuzz: [{ modelIdPrefix: 'gpt-5', modelIdPostfix: '-codex' }],
      },
    ],
    inputPrice: 1.25,
    outputPrice: 10.0,
    cacheReadPrice: 0.125,
    contextWindow: 128000,
    reasoningMode: 'always',
    supportedReasoningEfforts: ['minimal', 'low', 'medium', 'high'],
    webSearchPrice: 0.01,
  },
  {
    matches: [
      { apiType: ['chatgpt', 'responses_api'], modelIdExact: ['gpt-5-pro'] },
      {
        apiType: ['chatgpt', 'responses_api'],
        modelIdFuzz: [{ modelIdPrefix: 'gpt-5-pro' }],
      },
      {
        apiType: ['chatgpt', 'responses_api'],
        modelIdFuzz: [{ modelIdPrefix: 'gpt-5', modelIdPostfix: '-pro' }],
      },
    ],
    inputPrice: 15.0,
    outputPrice: 120.0,
    contextWindow: 128000,
    reasoningMode: 'always',
    supportedReasoningEfforts: ['minimal', 'low', 'medium', 'high'],
    webSearchPrice: 0.01,
  },
  {
    matches: [
      { apiType: ['chatgpt', 'responses_api'], modelIdExact: ['gpt-5-search-api'] },
      {
        apiType: ['chatgpt', 'responses_api'],
        modelIdFuzz: [{ modelIdPrefix: 'gpt-5', modelIdPostfix: '-search-api' }],
      },
    ],
    inputPrice: 1.25,
    outputPrice: 10.0,
    cacheReadPrice: 0.125,
    contextWindow: 128000,
    reasoningMode: 'always',
    supportedReasoningEfforts: ['minimal', 'low', 'medium', 'high'],
    webSearchPrice: 0.01,
  },

  // === GPT-4.1 series ===
  {
    matches: [
      { apiType: ['chatgpt', 'responses_api'], modelIdExact: ['gpt-4.1'] },
      {
        apiType: ['chatgpt', 'responses_api'],
        modelIdFuzz: [{ modelIdPrefix: 'gpt-4.1' }, { modelIdPrefix: 'gpt-4' }],
      },
    ],
    inputPrice: 2.0,
    outputPrice: 8.0,
    cacheReadPrice: 0.5,
    contextWindow: 128000,
    reasoningMode: 'none',
    webSearchPrice: 0.01,
  },
  {
    matches: [
      { apiType: ['chatgpt', 'responses_api'], modelIdExact: ['gpt-4.1-mini'] },
      {
        apiType: ['chatgpt', 'responses_api'],
        modelIdFuzz: [
          { modelIdPrefix: 'gpt-4.1', modelIdPostfix: '-mini' },
          { modelIdPrefix: 'gpt-4', modelIdPostfix: '-mini' },
        ],
      },
    ],
    inputPrice: 0.4,
    outputPrice: 1.6,
    cacheReadPrice: 0.1,
    contextWindow: 128000,
    reasoningMode: 'none',
    webSearchPrice: 0.01,
  },
  {
    matches: [
      { apiType: ['chatgpt', 'responses_api'], modelIdExact: ['gpt-4.1-nano'] },
      {
        apiType: ['chatgpt', 'responses_api'],
        modelIdFuzz: [
          { modelIdPrefix: 'gpt-4.1', modelIdPostfix: '-nano' },
          { modelIdPrefix: 'gpt-4', modelIdPostfix: '-nano' },
        ],
      },
    ],
    inputPrice: 0.1,
    outputPrice: 0.4,
    cacheReadPrice: 0.025,
    contextWindow: 128000,
    reasoningMode: 'none',
    webSearchPrice: 0.01,
  },

  // === GPT-4o series ===
  {
    matches: [
      { apiType: ['chatgpt', 'responses_api'], modelIdExact: ['gpt-4o'] },
      { apiType: ['chatgpt', 'responses_api'], modelIdFuzz: [{ modelIdPrefix: 'gpt-4o' }] },
    ],
    inputPrice: 2.5,
    outputPrice: 10.0,
    cacheReadPrice: 1.25,
    contextWindow: 128000,
    reasoningMode: 'none',
    webSearchPrice: 0.01,
  },
  {
    matches: [
      { apiType: ['chatgpt', 'responses_api'], modelIdExact: ['gpt-4o-2024-05-13'] },
      {
        apiType: ['chatgpt', 'responses_api'],
        modelIdFuzz: [{ modelIdPrefix: 'gpt-4o', modelIdPostfix: '-2024-05-13' }],
      },
    ],
    inputPrice: 5.0,
    outputPrice: 15.0,
    contextWindow: 128000,
    reasoningMode: 'none',
    webSearchPrice: 0.01,
  },
  {
    matches: [
      { apiType: ['chatgpt', 'responses_api'], modelIdExact: ['gpt-4o-mini'] },
      {
        apiType: ['chatgpt', 'responses_api'],
        modelIdFuzz: [{ modelIdPrefix: 'gpt-4o', modelIdPostfix: '-mini' }],
      },
    ],
    inputPrice: 0.15,
    outputPrice: 0.6,
    cacheReadPrice: 0.075,
    contextWindow: 128000,
    reasoningMode: 'none',
    webSearchPrice: 0.01,
  },

  // === Realtime models ===
  {
    matches: [
      { apiType: ['chatgpt', 'responses_api'], modelIdExact: ['gpt-realtime'] },
      { apiType: ['chatgpt', 'responses_api'], modelIdFuzz: [{ modelIdPrefix: 'gpt-realtime' }] },
    ],
    inputPrice: 4.0,
    outputPrice: 16.0,
    cacheReadPrice: 0.4,
    contextWindow: 128000,
    reasoningMode: 'none',
  },
  {
    matches: [
      { apiType: ['chatgpt', 'responses_api'], modelIdExact: ['gpt-realtime-mini'] },
      {
        apiType: ['chatgpt', 'responses_api'],
        modelIdFuzz: [{ modelIdPrefix: 'gpt-realtime', modelIdPostfix: '-mini' }],
      },
    ],
    inputPrice: 0.6,
    outputPrice: 2.4,
    cacheReadPrice: 0.06,
    contextWindow: 128000,
    reasoningMode: 'none',
  },
  {
    matches: [
      { apiType: ['chatgpt', 'responses_api'], modelIdExact: ['gpt-4o-realtime-preview'] },
      {
        apiType: ['chatgpt', 'responses_api'],
        modelIdFuzz: [{ modelIdPrefix: 'gpt-4o', modelIdPostfix: '-realtime-preview' }],
      },
    ],
    inputPrice: 5.0,
    outputPrice: 20.0,
    cacheReadPrice: 2.5,
    contextWindow: 128000,
    reasoningMode: 'none',
  },
  {
    matches: [
      { apiType: ['chatgpt', 'responses_api'], modelIdExact: ['gpt-4o-mini-realtime-preview'] },
      {
        apiType: ['chatgpt', 'responses_api'],
        modelIdFuzz: [{ modelIdPrefix: 'gpt-4o-mini', modelIdPostfix: '-realtime-preview' }],
      },
    ],
    inputPrice: 0.6,
    outputPrice: 2.4,
    cacheReadPrice: 0.3,
    contextWindow: 128000,
    reasoningMode: 'none',
  },

  // === Audio models ===
  {
    matches: [
      { apiType: ['chatgpt', 'responses_api'], modelIdExact: ['gpt-audio'] },
      { apiType: ['chatgpt', 'responses_api'], modelIdFuzz: [{ modelIdPrefix: 'gpt-audio' }] },
    ],
    inputPrice: 2.5,
    outputPrice: 10.0,
    contextWindow: 128000,
    reasoningMode: 'none',
  },
  {
    matches: [
      { apiType: ['chatgpt', 'responses_api'], modelIdExact: ['gpt-audio-mini'] },
      {
        apiType: ['chatgpt', 'responses_api'],
        modelIdFuzz: [{ modelIdPrefix: 'gpt-audio', modelIdPostfix: '-mini' }],
      },
    ],
    inputPrice: 0.6,
    outputPrice: 2.4,
    contextWindow: 128000,
    reasoningMode: 'none',
  },
  {
    matches: [
      { apiType: ['chatgpt', 'responses_api'], modelIdExact: ['gpt-4o-audio-preview'] },
      {
        apiType: ['chatgpt', 'responses_api'],
        modelIdFuzz: [{ modelIdPrefix: 'gpt-4o', modelIdPostfix: '-audio-preview' }],
      },
    ],
    inputPrice: 2.5,
    outputPrice: 10.0,
    contextWindow: 128000,
    reasoningMode: 'none',
  },
  {
    matches: [
      { apiType: ['chatgpt', 'responses_api'], modelIdExact: ['gpt-4o-mini-audio-preview'] },
      {
        apiType: ['chatgpt', 'responses_api'],
        modelIdFuzz: [{ modelIdPrefix: 'gpt-4o-mini', modelIdPostfix: '-audio-preview' }],
      },
    ],
    inputPrice: 0.15,
    outputPrice: 0.6,
    contextWindow: 128000,
    reasoningMode: 'none',
  },

  // === o-series reasoning models ===
  {
    matches: [
      { apiType: ['chatgpt', 'responses_api'], modelIdExact: ['o1'] },
      { apiType: ['chatgpt', 'responses_api'], modelIdFuzz: [{ modelIdPrefix: 'o1' }] },
    ],
    inputPrice: 15.0,
    outputPrice: 60.0,
    cacheReadPrice: 7.5,
    contextWindow: 200000,
    reasoningMode: 'always',
    supportedReasoningEfforts: ['low', 'medium', 'high'],
    webSearchPrice: 0.01,
  },
  {
    matches: [
      { apiType: ['chatgpt', 'responses_api'], modelIdExact: ['o1-pro'] },
      {
        apiType: ['chatgpt', 'responses_api'],
        modelIdFuzz: [{ modelIdPrefix: 'o1', modelIdPostfix: '-pro' }],
      },
    ],
    inputPrice: 150.0,
    outputPrice: 600.0,
    contextWindow: 200000,
    reasoningMode: 'always',
    supportedReasoningEfforts: ['low', 'medium', 'high'],
    webSearchPrice: 0.01,
  },
  {
    matches: [
      { apiType: ['chatgpt', 'responses_api'], modelIdExact: ['o1-mini'] },
      {
        apiType: ['chatgpt', 'responses_api'],
        modelIdFuzz: [{ modelIdPrefix: 'o1', modelIdPostfix: '-mini' }],
      },
    ],
    inputPrice: 1.1,
    outputPrice: 4.4,
    cacheReadPrice: 0.55,
    contextWindow: 128000,
    reasoningMode: 'always',
    supportedReasoningEfforts: ['low', 'medium', 'high'],
    webSearchPrice: 0.01,
  },
  {
    matches: [
      { apiType: ['chatgpt', 'responses_api'], modelIdExact: ['o3'] },
      { apiType: ['chatgpt', 'responses_api'], modelIdFuzz: [{ modelIdPrefix: 'o3' }] },
    ],
    inputPrice: 2.0,
    outputPrice: 8.0,
    cacheReadPrice: 0.5,
    contextWindow: 128000,
    reasoningMode: 'always',
    supportedReasoningEfforts: ['low', 'medium', 'high'],
    webSearchPrice: 0.01,
  },
  {
    matches: [
      { apiType: ['chatgpt', 'responses_api'], modelIdExact: ['o3-pro'] },
      {
        apiType: ['chatgpt', 'responses_api'],
        modelIdFuzz: [{ modelIdPrefix: 'o3', modelIdPostfix: '-pro' }],
      },
    ],
    inputPrice: 20.0,
    outputPrice: 80.0,
    contextWindow: 128000,
    reasoningMode: 'always',
    supportedReasoningEfforts: ['low', 'medium', 'high'],
    webSearchPrice: 0.01,
  },
  {
    matches: [
      { apiType: ['chatgpt', 'responses_api'], modelIdExact: ['o3-deep-research'] },
      {
        apiType: ['chatgpt', 'responses_api'],
        modelIdFuzz: [{ modelIdPrefix: 'o3', modelIdPostfix: '-deep-research' }],
      },
    ],
    inputPrice: 10.0,
    outputPrice: 40.0,
    cacheReadPrice: 2.5,
    contextWindow: 128000,
    reasoningMode: 'always',
    supportedReasoningEfforts: ['low', 'medium', 'high'],
    webSearchPrice: 0.01,
  },
  {
    matches: [
      { apiType: ['chatgpt', 'responses_api'], modelIdExact: ['o3-mini'] },
      {
        apiType: ['chatgpt', 'responses_api'],
        modelIdFuzz: [{ modelIdPrefix: 'o3', modelIdPostfix: '-mini' }],
      },
    ],
    inputPrice: 1.1,
    outputPrice: 4.4,
    cacheReadPrice: 0.55,
    contextWindow: 128000,
    reasoningMode: 'always',
    supportedReasoningEfforts: ['low', 'medium', 'high'],
    webSearchPrice: 0.01,
  },
  {
    matches: [
      { apiType: ['chatgpt', 'responses_api'], modelIdExact: ['o4-mini'] },
      {
        apiType: ['chatgpt', 'responses_api'],
        modelIdFuzz: [{ modelIdPrefix: 'o4', modelIdPostfix: '-mini' }],
      },
    ],
    inputPrice: 1.1,
    outputPrice: 4.4,
    cacheReadPrice: 0.275,
    contextWindow: 128000,
    reasoningMode: 'always',
    supportedReasoningEfforts: ['low', 'medium', 'high'],
    webSearchPrice: 0.01,
  },
  {
    matches: [
      { apiType: ['chatgpt', 'responses_api'], modelIdExact: ['o4-mini-deep-research'] },
      {
        apiType: ['chatgpt', 'responses_api'],
        modelIdFuzz: [{ modelIdPrefix: 'o4-mini', modelIdPostfix: '-deep-research' }],
      },
    ],
    inputPrice: 2.0,
    outputPrice: 8.0,
    cacheReadPrice: 0.5,
    contextWindow: 128000,
    reasoningMode: 'always',
    supportedReasoningEfforts: ['low', 'medium', 'high'],
    webSearchPrice: 0.01,
  },

  // === Search models ===
  {
    matches: [
      { apiType: ['chatgpt', 'responses_api'], modelIdExact: ['gpt-4o-search-preview'] },
      {
        apiType: ['chatgpt', 'responses_api'],
        modelIdFuzz: [{ modelIdPrefix: 'gpt-4o', modelIdPostfix: '-search-preview' }],
      },
    ],
    inputPrice: 2.5,
    outputPrice: 10.0,
    contextWindow: 128000,
    reasoningMode: 'none',
    webSearchPrice: 0.01,
  },
  {
    matches: [
      { apiType: ['chatgpt', 'responses_api'], modelIdExact: ['gpt-4o-mini-search-preview'] },
      {
        apiType: ['chatgpt', 'responses_api'],
        modelIdFuzz: [{ modelIdPrefix: 'gpt-4o-mini', modelIdPostfix: '-search-preview' }],
      },
    ],
    inputPrice: 0.15,
    outputPrice: 0.6,
    contextWindow: 128000,
    reasoningMode: 'none',
    webSearchPrice: 0.01,
  },

  // === Specialized models ===
  {
    matches: [
      { apiType: ['chatgpt', 'responses_api'], modelIdExact: ['codex-mini-latest'] },
      {
        apiType: ['chatgpt', 'responses_api'],
        modelIdFuzz: [{ modelIdPrefix: 'codex', modelIdPostfix: '-mini-latest' }],
      },
    ],
    inputPrice: 1.5,
    outputPrice: 6.0,
    cacheReadPrice: 0.375,
    contextWindow: 128000,
    reasoningMode: 'none',
    webSearchPrice: 0.01,
  },
  {
    matches: [
      { apiType: ['chatgpt', 'responses_api'], modelIdExact: ['computer-use-preview'] },
      {
        apiType: ['chatgpt', 'responses_api'],
        modelIdFuzz: [{ modelIdPrefix: 'computer-use' }],
      },
    ],
    inputPrice: 3.0,
    outputPrice: 12.0,
    contextWindow: 128000,
    reasoningMode: 'none',
    webSearchPrice: 0.01,
  },

  // === Image generation models ===
  {
    matches: [
      { apiType: ['chatgpt', 'responses_api'], modelIdExact: ['gpt-image-1.5'] },
      {
        apiType: ['chatgpt', 'responses_api'],
        modelIdFuzz: [{ modelIdPrefix: 'gpt-image-1.5' }],
      },
    ],
    inputPrice: 5.0,
    outputPrice: 10.0,
    cacheReadPrice: 1.25,
    contextWindow: 128000,
    reasoningMode: 'none',
  },
  {
    matches: [
      { apiType: ['chatgpt', 'responses_api'], modelIdExact: ['chatgpt-image-latest'] },
      {
        apiType: ['chatgpt', 'responses_api'],
        modelIdFuzz: [{ modelIdPrefix: 'chatgpt-image' }],
      },
    ],
    inputPrice: 5.0,
    outputPrice: 10.0,
    cacheReadPrice: 1.25,
    contextWindow: 128000,
    reasoningMode: 'none',
  },
  {
    matches: [
      { apiType: ['chatgpt', 'responses_api'], modelIdExact: ['gpt-image-1'] },
      {
        apiType: ['chatgpt', 'responses_api'],
        modelIdFuzz: [{ modelIdPrefix: 'gpt-image-1' }],
      },
    ],
    inputPrice: 5.0,
    cacheReadPrice: 1.25,
    contextWindow: 128000,
    reasoningMode: 'none',
  },
  {
    matches: [
      { apiType: ['chatgpt', 'responses_api'], modelIdExact: ['gpt-image-1-mini'] },
      {
        apiType: ['chatgpt', 'responses_api'],
        modelIdFuzz: [{ modelIdPrefix: 'gpt-image-1', modelIdPostfix: '-mini' }],
      },
    ],
    inputPrice: 2.0,
    cacheReadPrice: 0.2,
    contextWindow: 128000,
    reasoningMode: 'none',
  },
];
