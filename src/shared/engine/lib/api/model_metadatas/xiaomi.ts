import type { ModelKnowledge } from '../../../../protocol/types';

export const XIAOMI_MODELS: ModelKnowledge[] = [
  {
    matches: [
      {
        apiType: ['anthropic', 'chatgpt', 'responses_api'],
        modelIdFuzz: [{ modelIdPrefix: 'mimo-v2-pro' }],
      },
    ],
    inputPrice: 1.0,
    cacheReadPrice: 0.2,
    outputPrice: 3.0,
    reasoningMode: 'optional',
    supportedReasoningEfforts: [],
    deFactoThinking: true,
  },
  {
    matches: [
      {
        apiType: ['anthropic', 'chatgpt', 'responses_api'],
        modelIdFuzz: [{ modelIdPrefix: 'mimo-v2-omni' }],
      },
    ],
    inputPrice: 0.4,
    cacheReadPrice: 0.08,
    outputPrice: 2.0,
    reasoningMode: 'optional',
    supportedReasoningEfforts: [],
    deFactoThinking: true,
  },
];
