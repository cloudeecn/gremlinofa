import type { ModelKnowledge } from '../../../../protocol/types';

// Moonshot AI Kimi (OpenAI- & Anthropic-compatible endpoints).
// Prices are USD per 1M tokens: input / cached-input read / output.
// Max context is 262,144 tokens across the K2 line, 1M for K3. Where prefixes overlap
// (e.g. kimi-k2.7-code vs kimi-k2.7-code-highspeed) the longer/more specific
// prefix wins via the specificity sort in modelMetadata.ts.
export const MOONSHOT_MODELS: ModelKnowledge[] = [
  // Kimi K3 — flagship 1M-context model. Always reasons; reasoning_effort
  // accepts low/high/max (default max), so no de facto thinking toggle.
  {
    matches: [
      {
        apiType: ['anthropic', 'chatgpt', 'responses_api'],
        modelIdExact: ['k3'],
        modelIdFuzz: [{ modelIdPrefix: 'kimi-k3' }],
      },
    ],
    inputPrice: 3.0,
    cacheReadPrice: 0.3,
    outputPrice: 15.0,
    contextWindow: 1048576,
    reasoningMode: 'always',
    supportedReasoningEfforts: ['low', 'high', 'max'],
    supportsTools: true,
  },
  // Kimi K2.7 Code (high-speed tier)
  {
    matches: [
      {
        apiType: ['anthropic', 'chatgpt', 'responses_api'],
        modelIdFuzz: [{ modelIdPrefix: 'kimi-k2.7-code-highspeed' }],
      },
    ],
    inputPrice: 1.9,
    cacheReadPrice: 0.38,
    outputPrice: 8.0,
    contextWindow: 262144,
    reasoningMode: 'optional',
    supportedReasoningEfforts: [],
    deFactoThinking: true,
    supportsTools: true,
  },
  // Kimi K2.7 Code
  {
    matches: [
      {
        apiType: ['anthropic', 'chatgpt', 'responses_api'],
        modelIdFuzz: [{ modelIdPrefix: 'kimi-k2.7-code' }],
      },
    ],
    inputPrice: 0.95,
    cacheReadPrice: 0.19,
    outputPrice: 4.0,
    contextWindow: 262144,
    reasoningMode: 'optional',
    supportedReasoningEfforts: [],
    deFactoThinking: true,
    supportsTools: true,
  },
  // Kimi K2.6
  {
    matches: [
      {
        apiType: ['anthropic', 'chatgpt', 'responses_api'],
        modelIdFuzz: [{ modelIdPrefix: 'kimi-k2.6' }],
      },
    ],
    inputPrice: 0.95,
    cacheReadPrice: 0.16,
    outputPrice: 4.0,
    contextWindow: 262144,
    reasoningMode: 'optional',
    supportedReasoningEfforts: [],
    deFactoThinking: true,
    supportsTools: true,
  },
  // Kimi K2.5
  {
    matches: [
      {
        apiType: ['anthropic', 'chatgpt', 'responses_api'],
        modelIdFuzz: [{ modelIdPrefix: 'kimi-k2.5' }],
      },
    ],
    inputPrice: 0.6,
    cacheReadPrice: 0.1,
    outputPrice: 3.0,
    contextWindow: 262144,
    reasoningMode: 'optional',
    supportedReasoningEfforts: [],
    deFactoThinking: true,
    supportsTools: true,
  },
];
