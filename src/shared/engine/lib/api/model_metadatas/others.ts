import type { ModelKnowledge } from '../../../../protocol/types';

export const OTHER_MODELS: ModelKnowledge[] = [
  {
    matches: [
      {
        apiType: ['anthropic', 'chatgpt', 'responses_api'],
        modelIdFuzz: [{ modelIdPrefix: 'ernie-5.0-thinking' }],
      },
    ],
    inputPrice: 1.37,
    outputPrice: 5.48,
    reasoningMode: 'optional',
    supportedReasoningEfforts: [],
    deFactoThinking: true,
  },
];
