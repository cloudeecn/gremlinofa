import type { ModelKnowledge } from '../../../../protocol/types';

// First-party DeepSeek 400s when a tool-call turn comes back without its
// `reasoning_content` (Chat Completions) or `reasoning_text` (Responses).
// Hosts that don't enforce it (Alibaba, OpenRouter) get a harmless empty
// placeholder at worst.
//
// Prices are the peak list rate; off-peak (everything outside 01:00-04:00 and
// 06:00-10:00 UTC on weekdays) bills half. Effort is `low` / `high` / `max`,
// server default `high`: `reasoning_effort` beside `thinking` on Chat
// Completions, `reasoning.effort` on Responses, where `none` is the only off
// switch (`thinking` isn't read there).
export const DEEPSEEK_MODELS: ModelKnowledge[] = [
  {
    // V4.1 Flash. `deepseek-v4-flash` is a retired name DeepSeek now serves
    // and bills as V4.1 Flash; `deepseek-v4.1-flash` is the OpenRouter and
    // Alibaba spelling.
    matches: [
      {
        apiType: ['anthropic', 'chatgpt', 'responses_api'],
        modelIdFuzz: [
          { modelIdPrefix: 'deepseek-flash' },
          { modelIdPrefix: 'deepseek-v4.1-flash' },
          { modelIdPrefix: 'deepseek-v4-flash' },
        ],
      },
    ],
    inputPrice: 0.3,
    cacheReadPrice: 0.006,
    outputPrice: 1.2,
    contextWindow: 1048576,
    maxOutputTokens: 393216,
    reasoningMode: 'optional',
    supportedReasoningEfforts: ['low', 'high', 'max'],
    reasoningDialect: 'thinking-object',
    mandatesReasoningReplay: true,
  },
  {
    matches: [
      {
        apiType: ['anthropic', 'chatgpt', 'responses_api'],
        modelIdFuzz: [{ modelIdPrefix: 'deepseek-v4-pro' }],
      },
    ],
    inputPrice: 1.32,
    cacheReadPrice: 0.044,
    outputPrice: 3.96,
    contextWindow: 1048576,
    maxOutputTokens: 393216,
    reasoningMode: 'optional',
    supportedReasoningEfforts: ['low', 'high', 'max'],
    reasoningDialect: 'thinking-object',
    mandatesReasoningReplay: true,
  },
  // deepseek-chat / deepseek-reasoner: discontinued on DeepSeek's own API on
  // 2026-07-24, kept for older chats and hosts that still use the names.
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
    reasoningDialect: 'thinking-object',
    mandatesReasoningReplay: true,
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
    reasoningDialect: 'thinking-object',
    mandatesReasoningReplay: true,
  },
];
