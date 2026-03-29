import type { ModelKnowledge } from '../../../types';

export const DEEPSEEK_MODELS: ModelKnowledge[] = [
  {
    matches: [
      {
        apiType: ['anthropic', 'chatgpt', 'responses_api'],
        modelIdFuzz: [{ modelIdPrefix: 'deepseek-chat' }],
      },
    ],
    inputPrice: 0.28,
    cacheReadPrice: 0.028,
    outputPrice: 0.42,
    reasoningMode: 'optional',
    supportedReasoningEfforts: [],
    deFactoThinking: true,
  },
  {
    matches: [
      {
        apiType: ['anthropic', 'chatgpt', 'responses_api'],
        modelIdFuzz: [{ modelIdPrefix: 'deepseek-reasoner' }],
      },
    ],
    inputPrice: 0.28,
    cacheReadPrice: 0.028,
    outputPrice: 0.42,
    reasoningMode: 'always',
    supportedReasoningEfforts: [],
    deFactoThinking: true,
  },
];
