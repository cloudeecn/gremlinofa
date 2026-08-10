import type { ModelKnowledge } from '../../../../protocol/types';

export const OPENAI_MODELS: ModelKnowledge[] = [
  // === GPT-6 series (Astra / Sol / Luna) ===
  {
    // Astra is the flagship; the low-specificity `gpt-6` fuzz match makes it
    // the profile future gpt-6* ids inherit until they get their own entries.
    // >272K-input requests bill 2x input/cache and 1.5x output for the whole
    // request — recorded but not applied (see unsupportedHighContextPricing).
    // Fast mode (2x rates) is not modeled.
    matches: [
      { apiType: ['chatgpt', 'responses_api'], modelIdExact: ['gpt-6-astra'] },
      { apiType: ['chatgpt', 'responses_api'], modelIdFuzz: [{ modelIdPrefix: 'gpt-6-astra' }] },
      {
        apiType: ['chatgpt', 'responses_api'],
        modelIdFuzz: [{ modelIdPrefix: 'gpt-6', unreliable: true }], // fuzz match all future gpt-6*
      },
    ],
    inputPrice: 10.0,
    outputPrice: 50.0,
    reasoningPrice: 50.0,
    cacheReadPrice: 1.0,
    cacheWritePrice: 12.5,
    unsupportedHighContextPricing: {
      thresholdTokens: 272000,
      inputPrice: 20.0,
      cacheReadPrice: 2.0,
      cacheWritePrice: 25.0,
      outputPrice: 75.0,
    },
    contextWindow: 1050000,
    maxOutputTokens: 128000,
    reasoningMode: 'always',
    supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'], // no 'none'/'minimal' on gpt-6
    webSearchPrice: 0.01,
    supportsVerbosity: true,
    reasoningHistoryParam: 'reasoning_context',
  },
  {
    // GPT-6.1 Sol: Sol pricing with a 5% cache rate, but `none` / `minimal` are
    // gone and Chat Completions has no tool calling. The `gpt-6.1` + `-sol`
    // fuzz outranks the `gpt-6` + `-sol` one below.
    matches: [
      { apiType: ['chatgpt', 'responses_api'], modelIdExact: ['gpt-6.1-sol'] },
      { apiType: ['chatgpt', 'responses_api'], modelIdFuzz: [{ modelIdPrefix: 'gpt-6.1-sol' }] },
      {
        apiType: ['chatgpt', 'responses_api'],
        modelIdFuzz: [{ modelIdPrefix: 'gpt-6.1', modelIdPostfix: '-sol' }],
      },
    ],
    inputPrice: 2.0,
    outputPrice: 10.0,
    reasoningPrice: 10.0,
    cacheReadPrice: 0.1,
    cacheWritePrice: 2.5,
    unsupportedHighContextPricing: {
      thresholdTokens: 272000,
      inputPrice: 4.0,
      cacheReadPrice: 0.2,
      cacheWritePrice: 5.0,
      outputPrice: 15.0,
    },
    contextWindow: 1050000,
    maxOutputTokens: 128000,
    reasoningMode: 'always',
    supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    webSearchPrice: 0.01,
    supportsVerbosity: true,
    reasoningHistoryParam: 'reasoning_context',
  },
  {
    matches: [
      { apiType: ['chatgpt', 'responses_api'], modelIdExact: ['gpt-6-sol'] },
      { apiType: ['chatgpt', 'responses_api'], modelIdFuzz: [{ modelIdPrefix: 'gpt-6-sol' }] },
      {
        apiType: ['chatgpt', 'responses_api'],
        modelIdFuzz: [{ modelIdPrefix: 'gpt-6', modelIdPostfix: '-sol' }],
      },
    ],
    inputPrice: 2.0,
    outputPrice: 10.0,
    reasoningPrice: 10.0,
    cacheReadPrice: 0.2,
    cacheWritePrice: 2.5,
    unsupportedHighContextPricing: {
      thresholdTokens: 272000,
      inputPrice: 4.0,
      cacheReadPrice: 0.4,
      cacheWritePrice: 5.0,
      outputPrice: 15.0,
    },
    contextWindow: 1050000,
    maxOutputTokens: 128000,
    reasoningMode: 'optional',
    // Unlike Astra, Sol and Luna take `none` — Chat Completions function
    // calling requires it.
    supportedReasoningEfforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
    webSearchPrice: 0.01,
    supportsVerbosity: true,
    reasoningHistoryParam: 'reasoning_context',
  },
  {
    matches: [
      { apiType: ['chatgpt', 'responses_api'], modelIdExact: ['gpt-6-luna'] },
      { apiType: ['chatgpt', 'responses_api'], modelIdFuzz: [{ modelIdPrefix: 'gpt-6-luna' }] },
      {
        apiType: ['chatgpt', 'responses_api'],
        modelIdFuzz: [{ modelIdPrefix: 'gpt-6', modelIdPostfix: '-luna' }],
      },
    ],
    inputPrice: 0.1,
    outputPrice: 0.5,
    reasoningPrice: 0.5,
    cacheReadPrice: 0.01,
    cacheWritePrice: 0.125,
    unsupportedHighContextPricing: {
      thresholdTokens: 272000,
      inputPrice: 0.2,
      cacheReadPrice: 0.02,
      cacheWritePrice: 0.25,
      outputPrice: 0.75,
    },
    contextWindow: 1050000,
    maxOutputTokens: 128000,
    reasoningMode: 'optional',
    supportedReasoningEfforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
    webSearchPrice: 0.01,
    supportsVerbosity: true,
    reasoningHistoryParam: 'reasoning_context',
  },

  // === GPT-5.6 series (Sol / Terra / Luna) ===
  // Repriced downward on 2026-07-30 and again since; rates below are the
  // current ones. The >272K-input tier (2x input/cache, 1.5x output) applies
  // here as on gpt-6 but is not yet recorded.
  {
    matches: [
      // 'gpt-5.6' is an official alias routing to Sol
      { apiType: ['chatgpt', 'responses_api'], modelIdExact: ['gpt-5.6', 'gpt-5.6-sol'] },
      { apiType: ['chatgpt', 'responses_api'], modelIdFuzz: [{ modelIdPrefix: 'gpt-5.6' }] },
      {
        apiType: ['chatgpt', 'responses_api'],
        modelIdFuzz: [{ modelIdPrefix: 'gpt-5.6', modelIdPostfix: '-sol' }],
      },
    ],
    inputPrice: 4.0,
    outputPrice: 20.0,
    reasoningPrice: 20.0,
    cacheReadPrice: 0.4,
    cacheWritePrice: 5.0,
    contextWindow: 1050000,
    reasoningMode: 'optional',
    supportedReasoningEfforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
    webSearchPrice: 0.01,
    supportsVerbosity: true,
    reasoningHistoryParam: 'reasoning_context',
  },
  {
    matches: [
      { apiType: ['chatgpt', 'responses_api'], modelIdExact: ['gpt-5.6-terra'] },
      {
        apiType: ['chatgpt', 'responses_api'],
        modelIdFuzz: [{ modelIdPrefix: 'gpt-5.6-terra' }],
      },
      {
        apiType: ['chatgpt', 'responses_api'],
        modelIdFuzz: [{ modelIdPrefix: 'gpt-5.6', modelIdPostfix: '-terra' }],
      },
    ],
    inputPrice: 2.0,
    outputPrice: 12.0,
    reasoningPrice: 12.0,
    cacheReadPrice: 0.2,
    cacheWritePrice: 2.5,
    contextWindow: 1050000,
    reasoningMode: 'optional',
    supportedReasoningEfforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
    webSearchPrice: 0.01,
    supportsVerbosity: true,
    reasoningHistoryParam: 'reasoning_context',
  },
  {
    matches: [
      { apiType: ['chatgpt', 'responses_api'], modelIdExact: ['gpt-5.6-luna'] },
      {
        apiType: ['chatgpt', 'responses_api'],
        modelIdFuzz: [{ modelIdPrefix: 'gpt-5.6-luna' }],
      },
      {
        apiType: ['chatgpt', 'responses_api'],
        modelIdFuzz: [{ modelIdPrefix: 'gpt-5.6', modelIdPostfix: '-luna' }],
      },
    ],
    inputPrice: 0.2,
    outputPrice: 1.2,
    reasoningPrice: 1.2,
    cacheReadPrice: 0.02,
    cacheWritePrice: 0.25,
    contextWindow: 1050000,
    reasoningMode: 'optional',
    supportedReasoningEfforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
    webSearchPrice: 0.01,
    supportsVerbosity: true,
    reasoningHistoryParam: 'reasoning_context',
  },

  // === GPT-5.5 / 5.4 / 5.3 series ===
  // Each sub-model needs an exact id, a `5.x` + postfix fuzz that outranks the
  // `gpt-5` + postfix ones further down, and a prefix for dated snapshots
  // (which don't end in the postfix). >272K-input requests bill 2x input and
  // 1.5x output for the whole request — recorded but not applied.
  {
    matches: [
      { apiType: ['chatgpt', 'responses_api'], modelIdExact: ['gpt-5.5'] },
      { apiType: ['chatgpt', 'responses_api'], modelIdFuzz: [{ modelIdPrefix: 'gpt-5.5' }] },
    ],
    inputPrice: 5.0,
    outputPrice: 30.0,
    reasoningPrice: 30.0,
    cacheReadPrice: 0.5,
    unsupportedHighContextPricing: {
      thresholdTokens: 272000,
      inputPrice: 10.0,
      cacheReadPrice: 1.0,
      outputPrice: 45.0,
    },
    contextWindow: 1050000,
    maxOutputTokens: 128000,
    reasoningMode: 'optional',
    supportedReasoningEfforts: ['none', 'low', 'medium', 'high', 'xhigh'],
    webSearchPrice: 0.01,
    supportsVerbosity: true,
    reasoningHistoryParam: 'reasoning_context',
  },
  {
    matches: [
      { apiType: ['chatgpt', 'responses_api'], modelIdExact: ['gpt-5.5-pro'] },
      { apiType: ['chatgpt', 'responses_api'], modelIdFuzz: [{ modelIdPrefix: 'gpt-5.5-pro' }] },
      {
        apiType: ['chatgpt', 'responses_api'],
        modelIdFuzz: [{ modelIdPrefix: 'gpt-5.5', modelIdPostfix: '-pro' }],
      },
    ],
    // No cached-input discount.
    inputPrice: 30.0,
    outputPrice: 180.0,
    reasoningPrice: 180.0,
    contextWindow: 1050000,
    maxOutputTokens: 128000,
    reasoningMode: 'always',
    supportedReasoningEfforts: ['medium', 'high', 'xhigh'],
    webSearchPrice: 0.01,
    supportsVerbosity: true,
    reasoningHistoryParam: 'reasoning_context',
  },
  {
    matches: [
      { apiType: ['chatgpt', 'responses_api'], modelIdExact: ['gpt-5.4'] },
      {
        apiType: ['chatgpt', 'responses_api'],
        modelIdFuzz: [{ modelIdPrefix: 'gpt-5.', unreliable: true }],
      }, // fuzz match all future gpt-5.*
      { apiType: ['chatgpt', 'responses_api'], modelIdFuzz: [{ modelIdPrefix: 'gpt-5.4' }] },
    ],
    inputPrice: 2.5,
    outputPrice: 15.0,
    reasoningPrice: 15.0,
    cacheReadPrice: 0.25,
    unsupportedHighContextPricing: {
      thresholdTokens: 272000,
      inputPrice: 5.0,
      cacheReadPrice: 0.5,
      outputPrice: 22.5,
    },
    contextWindow: 1050000,
    maxOutputTokens: 128000,
    reasoningMode: 'optional',
    supportedReasoningEfforts: ['none', 'low', 'medium', 'high', 'xhigh'],
    webSearchPrice: 0.01,
    supportsVerbosity: true,
    reasoningHistoryParam: 'reasoning_context',
  },
  {
    matches: [
      { apiType: ['chatgpt', 'responses_api'], modelIdExact: ['gpt-5.4-pro'] },
      { apiType: ['chatgpt', 'responses_api'], modelIdFuzz: [{ modelIdPrefix: 'gpt-5.4-pro' }] },
      {
        apiType: ['chatgpt', 'responses_api'],
        modelIdFuzz: [{ modelIdPrefix: 'gpt-5.4', modelIdPostfix: '-pro' }],
      },
    ],
    inputPrice: 30.0,
    outputPrice: 180.0,
    reasoningPrice: 180.0,
    unsupportedHighContextPricing: {
      thresholdTokens: 272000,
      inputPrice: 60.0,
      outputPrice: 270.0,
    },
    contextWindow: 1050000,
    maxOutputTokens: 128000,
    reasoningMode: 'always',
    supportedReasoningEfforts: ['medium', 'high', 'xhigh'],
    webSearchPrice: 0.01,
    supportsVerbosity: true,
    reasoningHistoryParam: 'reasoning_context',
  },
  {
    matches: [
      { apiType: ['chatgpt', 'responses_api'], modelIdExact: ['gpt-5.4-mini'] },
      { apiType: ['chatgpt', 'responses_api'], modelIdFuzz: [{ modelIdPrefix: 'gpt-5.4-mini' }] },
      {
        apiType: ['chatgpt', 'responses_api'],
        modelIdFuzz: [{ modelIdPrefix: 'gpt-5.4', modelIdPostfix: '-mini' }],
      },
    ],
    inputPrice: 0.75,
    outputPrice: 4.5,
    reasoningPrice: 4.5,
    cacheReadPrice: 0.075,
    contextWindow: 400000,
    maxOutputTokens: 128000,
    reasoningMode: 'optional',
    supportedReasoningEfforts: ['none', 'low', 'medium', 'high', 'xhigh'],
    webSearchPrice: 0.01,
    supportsVerbosity: true,
    reasoningHistoryParam: 'reasoning_context',
  },
  {
    matches: [
      { apiType: ['chatgpt', 'responses_api'], modelIdExact: ['gpt-5.4-nano'] },
      { apiType: ['chatgpt', 'responses_api'], modelIdFuzz: [{ modelIdPrefix: 'gpt-5.4-nano' }] },
      {
        apiType: ['chatgpt', 'responses_api'],
        modelIdFuzz: [{ modelIdPrefix: 'gpt-5.4', modelIdPostfix: '-nano' }],
      },
    ],
    inputPrice: 0.2,
    outputPrice: 1.25,
    reasoningPrice: 1.25,
    cacheReadPrice: 0.02,
    contextWindow: 400000,
    maxOutputTokens: 128000,
    reasoningMode: 'optional',
    supportedReasoningEfforts: ['none', 'low', 'medium', 'high', 'xhigh'],
    webSearchPrice: 0.01,
    supportsVerbosity: true,
    reasoningHistoryParam: 'reasoning_context',
  },
  {
    matches: [
      { apiType: ['chatgpt', 'responses_api'], modelIdExact: ['gpt-5.3-codex'] },
      { apiType: ['chatgpt', 'responses_api'], modelIdFuzz: [{ modelIdPrefix: 'gpt-5.3-codex' }] },
      {
        apiType: ['chatgpt', 'responses_api'],
        modelIdFuzz: [{ modelIdPrefix: 'gpt-5.3', modelIdPostfix: '-codex' }],
      },
    ],
    inputPrice: 1.75,
    outputPrice: 14.0,
    reasoningPrice: 14.0,
    cacheReadPrice: 0.175,
    contextWindow: 400000,
    maxOutputTokens: 128000,
    reasoningMode: 'always',
    supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
    webSearchPrice: 0.01,
    supportsVerbosity: true,
  },
  {
    // Deprecated.
    matches: [
      { apiType: ['chatgpt', 'responses_api'], modelIdExact: ['gpt-5.3-chat-latest'] },
      {
        apiType: ['chatgpt', 'responses_api'],
        modelIdFuzz: [{ modelIdPrefix: 'gpt-5.3', modelIdPostfix: '-chat-latest' }],
      },
    ],
    inputPrice: 1.75,
    outputPrice: 14.0,
    reasoningPrice: 14.0,
    cacheReadPrice: 0.175,
    contextWindow: 128000,
    maxOutputTokens: 16384,
    reasoningMode: 'always',
    supportedReasoningEfforts: ['medium'],
    webSearchPrice: 0.01,
    supportsVerbosity: true,
  },

  // === GPT-5.2 series ===
  {
    matches: [
      { apiType: ['chatgpt', 'responses_api'], modelIdExact: ['gpt-5.2'] },
      { apiType: ['chatgpt', 'responses_api'], modelIdFuzz: [{ modelIdPrefix: 'gpt-5.2' }] },
    ],
    inputPrice: 1.75,
    outputPrice: 14.0,
    reasoningPrice: 14.0,
    cacheReadPrice: 0.175,
    contextWindow: 128000,
    reasoningMode: 'optional',
    supportedReasoningEfforts: ['none', 'low', 'medium', 'high', 'xhigh'],
    webSearchPrice: 0.01,
    supportsVerbosity: true,
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
    reasoningPrice: 14.0,
    cacheReadPrice: 0.175,
    contextWindow: 128000,
    reasoningMode: 'always',
    supportedReasoningEfforts: ['medium'],
    webSearchPrice: 0.01,
    supportsVerbosity: true,
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
    reasoningPrice: 14.0,
    cacheReadPrice: 0.175,
    contextWindow: 128000,
    reasoningMode: 'always',
    supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
    webSearchPrice: 0.01,
    supportsVerbosity: true,
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
    reasoningPrice: 168.0,
    contextWindow: 128000,
    reasoningMode: 'always',
    supportedReasoningEfforts: ['medium', 'high', 'xhigh'],
    webSearchPrice: 0.01,
    supportsVerbosity: true,
  },

  // === GPT-5.1 series ===
  {
    matches: [
      { apiType: ['chatgpt', 'responses_api'], modelIdExact: ['gpt-5.1'] },
      { apiType: ['chatgpt', 'responses_api'], modelIdFuzz: [{ modelIdPrefix: 'gpt-5.1' }] },
    ],
    inputPrice: 1.25,
    outputPrice: 10.0,
    reasoningPrice: 10.0,
    cacheReadPrice: 0.125,
    contextWindow: 128000,
    reasoningMode: 'optional',
    supportedReasoningEfforts: ['none', 'low', 'medium', 'high'],
    webSearchPrice: 0.01,
    supportsVerbosity: true,
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
    reasoningPrice: 10.0,
    cacheReadPrice: 0.125,
    contextWindow: 128000,
    reasoningMode: 'always',
    supportedReasoningEfforts: ['medium'],
    webSearchPrice: 0.01,
    supportsVerbosity: true,
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
    reasoningPrice: 10.0,
    cacheReadPrice: 0.125,
    contextWindow: 128000,
    reasoningMode: 'always',
    supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
    webSearchPrice: 0.01,
    supportsVerbosity: true,
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
    reasoningPrice: 10.0,
    cacheReadPrice: 0.125,
    contextWindow: 128000,
    reasoningMode: 'always',
    supportedReasoningEfforts: ['low', 'medium', 'high'],
    webSearchPrice: 0.01,
    supportsVerbosity: true,
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
    reasoningPrice: 2.0,
    cacheReadPrice: 0.025,
    contextWindow: 128000,
    reasoningMode: 'always',
    supportedReasoningEfforts: ['low', 'medium', 'high'],
    webSearchPrice: 0.01,
    supportsVerbosity: true,
  },

  // === GPT-5 series ===
  {
    matches: [
      { apiType: ['chatgpt', 'responses_api'], modelIdExact: ['gpt-5'] },
      { apiType: ['chatgpt', 'responses_api'], modelIdFuzz: [{ modelIdPrefix: 'gpt-5' }] },
    ],
    inputPrice: 1.25,
    outputPrice: 10.0,
    reasoningPrice: 10.0,
    cacheReadPrice: 0.125,
    contextWindow: 128000,
    reasoningMode: 'always',
    supportedReasoningEfforts: ['minimal', 'low', 'medium', 'high'],
    webSearchPrice: 0.01,
    supportsVerbosity: true,
  },
  {
    matches: [
      { apiType: ['chatgpt', 'responses_api'], modelIdExact: ['gpt-5-mini'] },
      {
        apiType: ['chatgpt', 'responses_api'],
        modelIdFuzz: [{ modelIdPrefix: 'gpt-5', modelIdPostfix: '-mini' }],
      },
      { apiType: ['chatgpt', 'responses_api'], modelIdFuzz: [{ modelIdPrefix: 'gpt-5-mini' }] }, // dated snapshots
    ],
    inputPrice: 0.25,
    outputPrice: 2.0,
    reasoningPrice: 2.0,
    cacheReadPrice: 0.025,
    contextWindow: 128000,
    reasoningMode: 'always',
    supportedReasoningEfforts: ['minimal', 'low', 'medium', 'high'],
    webSearchPrice: 0.01,
    supportsVerbosity: true,
  },
  {
    matches: [
      { apiType: ['chatgpt', 'responses_api'], modelIdExact: ['gpt-5-nano'] },
      {
        apiType: ['chatgpt', 'responses_api'],
        modelIdFuzz: [{ modelIdPrefix: 'gpt-5', modelIdPostfix: '-nano' }],
      },
      { apiType: ['chatgpt', 'responses_api'], modelIdFuzz: [{ modelIdPrefix: 'gpt-5-nano' }] }, // dated snapshots
    ],
    inputPrice: 0.05,
    outputPrice: 0.4,
    reasoningPrice: 0.4,
    cacheReadPrice: 0.005,
    contextWindow: 128000,
    reasoningMode: 'always',
    supportedReasoningEfforts: ['minimal', 'low', 'medium', 'high'],
    webSearchPrice: 0.01,
    supportsVerbosity: true,
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
    supportsVerbosity: true,
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
    reasoningPrice: 10.0,
    cacheReadPrice: 0.125,
    contextWindow: 128000,
    reasoningMode: 'always',
    supportedReasoningEfforts: ['low', 'medium', 'high'],
    webSearchPrice: 0.01,
    supportsVerbosity: true,
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
    reasoningPrice: 120.0,
    contextWindow: 128000,
    reasoningMode: 'always',
    supportedReasoningEfforts: ['high'],
    webSearchPrice: 0.01,
    supportsVerbosity: true,
  },
  {
    matches: [
      { apiType: ['chatgpt', 'responses_api'], modelIdExact: ['gpt-5-search-api'] },
      {
        apiType: ['chatgpt', 'responses_api'],
        modelIdFuzz: [{ modelIdPrefix: 'gpt-5', modelIdPostfix: '-search-api' }],
      },
      {
        apiType: ['chatgpt', 'responses_api'],
        modelIdFuzz: [{ modelIdPrefix: 'gpt-5-search-api' }],
      }, // dated snapshots
    ],
    inputPrice: 1.25,
    outputPrice: 10.0,
    reasoningPrice: 10.0,
    cacheReadPrice: 0.125,
    contextWindow: 128000,
    reasoningMode: 'always',
    // Rejects `reasoning_effort` ("Unrecognized request argument supplied").
    supportedReasoningEfforts: [],
    webSearchPrice: 0.01,
  },

  // === GPT-4.1 series ===
  {
    matches: [
      { apiType: ['chatgpt', 'responses_api'], modelIdExact: ['gpt-4.1'] },
      { apiType: ['chatgpt', 'responses_api'], modelIdFuzz: [{ modelIdPrefix: 'gpt-4.1' }] },
      // The `gpt-4` catch-all ranks on its own length; sharing a match with
      // `gpt-4.1` lent it that longer prefix's rank and beat `gpt-4o`.
      { apiType: ['chatgpt', 'responses_api'], modelIdFuzz: [{ modelIdPrefix: 'gpt-4' }] },
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
        modelIdFuzz: [{ modelIdPrefix: 'gpt-4.1', modelIdPostfix: '-mini' }],
      },
      { apiType: ['chatgpt', 'responses_api'], modelIdFuzz: [{ modelIdPrefix: 'gpt-4.1-mini' }] }, // dated snapshots
      // Own match, so it ranks below the gpt-4o + -mini fuzz
      {
        apiType: ['chatgpt', 'responses_api'],
        modelIdFuzz: [{ modelIdPrefix: 'gpt-4', modelIdPostfix: '-mini' }],
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
        modelIdFuzz: [{ modelIdPrefix: 'gpt-4.1', modelIdPostfix: '-nano' }],
      },
      { apiType: ['chatgpt', 'responses_api'], modelIdFuzz: [{ modelIdPrefix: 'gpt-4.1-nano' }] }, // dated snapshots
      // Own match, so it ranks below the gpt-4o + -nano fuzz
      {
        apiType: ['chatgpt', 'responses_api'],
        modelIdFuzz: [{ modelIdPrefix: 'gpt-4', modelIdPostfix: '-nano' }],
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
      { apiType: ['chatgpt', 'responses_api'], modelIdFuzz: [{ modelIdPrefix: 'gpt-4o-mini' }] }, // dated snapshots
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
    reasoningPrice: 60.0,
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
    reasoningPrice: 600.0,
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
    reasoningPrice: 4.4,
    cacheReadPrice: 0.55,
    contextWindow: 128000,
    reasoningMode: 'always',
    supportedReasoningEfforts: [], // o1-mini takes no `reasoning_effort`
    webSearchPrice: 0.01,
  },
  {
    matches: [
      { apiType: ['chatgpt', 'responses_api'], modelIdExact: ['o3'] },
      { apiType: ['chatgpt', 'responses_api'], modelIdFuzz: [{ modelIdPrefix: 'o3' }] },
    ],
    inputPrice: 2.0,
    outputPrice: 8.0,
    reasoningPrice: 8.0,
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
    reasoningPrice: 80.0,
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
    reasoningPrice: 40.0,
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
    reasoningPrice: 4.4,
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
    reasoningPrice: 4.4,
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
    reasoningPrice: 8.0,
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
    // o4-mini based; Azure lists it with reasoning effort.
    reasoningMode: 'always',
    supportedReasoningEfforts: ['low', 'medium', 'high'],
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
