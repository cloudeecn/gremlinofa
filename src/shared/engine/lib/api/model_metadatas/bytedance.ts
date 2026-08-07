import type { ModelKnowledge } from '../../../../protocol/types';

export const BYTEDANCE_MODELS: ModelKnowledge[] = [
  // Doubao Seed 2.1 Pro
  {
    matches: [
      {
        apiType: ['anthropic', 'chatgpt', 'responses_api'],
        modelIdFuzz: [{ modelIdPrefix: 'doubao-seed-2-1-pro' }],
      },
    ],
    inputPrice: 0.93,
    cacheReadPrice: 0.186,
    outputPrice: 4.65,
    contextWindow: 256000,
    maxOutputTokens: 128000,
    reasoningMode: 'optional',
    supportedReasoningEfforts: [],
    deFactoThinking: true,
    supportsTools: true,
  },
  // Doubao Seed 2.0 Pro
  {
    matches: [
      {
        apiType: ['anthropic', 'chatgpt', 'responses_api'],
        modelIdFuzz: [{ modelIdPrefix: 'doubao-seed-2-0-pro' }],
      },
    ],
    inputPrice: 0.4822,
    cacheReadPrice: 0.09644,
    outputPrice: 2.411,
    contextWindow: 256000,
    maxOutputTokens: 128000,
    reasoningMode: 'optional',
    supportedReasoningEfforts: [],
    deFactoThinking: true,
    supportsTools: true,
  },
  // Doubao Seed 2.0 Code Preview — same pricing as pro
  {
    matches: [
      {
        apiType: ['anthropic', 'chatgpt', 'responses_api'],
        modelIdFuzz: [{ modelIdPrefix: 'doubao-seed-2-0-code' }],
      },
    ],
    inputPrice: 0.4822,
    cacheReadPrice: 0.09644,
    outputPrice: 2.411,
    contextWindow: 256000,
    maxOutputTokens: 128000,
    reasoningMode: 'optional',
    supportedReasoningEfforts: [],
    deFactoThinking: true,
    supportsTools: true,
  },
  // Doubao Seed 2.0 Lite (covers -260215 and -260428 snapshots, same price)
  {
    matches: [
      {
        apiType: ['anthropic', 'chatgpt', 'responses_api'],
        modelIdFuzz: [{ modelIdPrefix: 'doubao-seed-2-0-lite' }],
      },
    ],
    inputPrice: 0.09041,
    cacheReadPrice: 0.018082,
    outputPrice: 0.54246,
    contextWindow: 256000,
    maxOutputTokens: 32000,
    reasoningMode: 'optional',
    supportedReasoningEfforts: [],
    deFactoThinking: true,
    supportsTools: true,
  },
  // Doubao Seed 2.0 Mini — bare ID is canonical; -260428 snapshot is ~6% cheaper
  // but a single prefix entry has to pick one, so picking canonical/live.
  {
    matches: [
      {
        apiType: ['anthropic', 'chatgpt', 'responses_api'],
        modelIdFuzz: [{ modelIdPrefix: 'doubao-seed-2-0-mini' }],
      },
    ],
    inputPrice: 0.030136,
    cacheReadPrice: 0.006027,
    outputPrice: 0.30136,
    contextWindow: 256000,
    maxOutputTokens: 32000,
    reasoningMode: 'optional',
    supportedReasoningEfforts: [],
    deFactoThinking: true,
    supportsTools: true,
  },
  // Doubao Seed 1.8
  {
    matches: [
      {
        apiType: ['anthropic', 'chatgpt', 'responses_api'],
        modelIdFuzz: [{ modelIdPrefix: 'doubao-seed-1-8' }],
      },
    ],
    inputPrice: 0.10959,
    cacheReadPrice: 0.021918,
    outputPrice: 0.273975,
    contextWindow: 256000,
    maxOutputTokens: 64000,
    reasoningMode: 'optional',
    supportedReasoningEfforts: [],
    deFactoThinking: true,
    supportsTools: true,
  },
];
