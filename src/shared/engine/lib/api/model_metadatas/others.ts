import type { ModelKnowledge } from '../../../../protocol/types';
import { cny } from './currency';

// Baidu Qianfan publishes CNY prices only; see `cny()`.
export const OTHER_MODELS: ModelKnowledge[] = [
  {
    // ERNIE 5.1 (2026-05). Prompts over 32K bill at the higher tier. The 128K
    // window comes from third-party listings; Baidu's page doesn't state it.
    matches: [
      {
        apiType: ['anthropic', 'chatgpt', 'responses_api'],
        modelIdFuzz: [{ modelIdPrefix: 'ernie-5.1' }],
      },
    ],
    inputPrice: cny(4),
    outputPrice: cny(18),
    contextPricingTiers: [{ thresholdTokens: 32000, inputPrice: cny(6), outputPrice: cny(22) }],
    contextWindow: 128000,
  },
  {
    // No longer on Baidu's price list (checked 2026-11-09); last known price.
    matches: [
      {
        apiType: ['anthropic', 'chatgpt', 'responses_api'],
        modelIdFuzz: [{ modelIdPrefix: 'ernie-5.0-thinking' }],
      },
    ],
    inputPrice: cny(10),
    outputPrice: cny(40),
    reasoningMode: 'optional',
    supportedReasoningEfforts: [],
    reasoningDialect: 'thinking-object',
  },
];
