import type { ModelKnowledge } from '../../../../protocol/types';

// Gemini 2.5 Pro and everything from Gemini 3 on can't switch thinking off
// (`minimal`, where offered, still reasons a little), so they're 'always'. Only
// 2.5 Flash / Flash-Lite accept a zero thinking budget.
export const GOOGLE_MODELS: ModelKnowledge[] = [
  // Gemini 4 Argon — introductory pricing through 2026-11-30. From 2026-12-01
  // it becomes 4 / 20 in-out, 0.2 cache read. thinking_level accepts low /
  // medium (default) / high; a thinking_budget is a 400. temperature, top_p and
  // top_k are ignored. Output tops out at 65,536 per request: going past that
  // needs long decode (background execution), which this client doesn't do.
  {
    matches: [
      {
        apiType: ['google'],
        modelIdFuzz: [{ modelIdPrefix: 'gemini-4-argon' }],
      },
    ],
    inputPrice: 2.0,
    outputPrice: 10.0,
    reasoningPrice: 10.0,
    cacheReadPrice: 0.1,
    contextWindow: 1048576,
    maxOutputTokens: 65536,
    reasoningMode: 'always',
    supportedReasoningEfforts: ['low', 'medium', 'high'],
    supportsTemperature: false,
    supportsTools: true,
  },
  // Gemini 3.8 Flash — introductory pricing through 2026-12-31 (same as 3.7).
  // From 2027-01-01 it becomes 1.5 / 7.5 in-out, 0.15 cache read.
  // thinking_level accepts low / medium (default) / high — MINIMAL is a validation error.
  {
    matches: [
      {
        apiType: ['google'],
        modelIdFuzz: [{ modelIdPrefix: 'gemini-3.8-flash' }],
      },
    ],
    inputPrice: 0.75,
    outputPrice: 3.75,
    reasoningPrice: 3.75,
    cacheReadPrice: 0.075,
    contextWindow: 1048576,
    maxOutputTokens: 65536,
    reasoningMode: 'always',
    supportedReasoningEfforts: ['low', 'medium', 'high'],
    supportsTemperature: true,
    supportsTools: true,
  },
  // Gemini 3.7 Flash — introductory pricing through 2026-12-31.
  // From 2027-01-01 it becomes 1.5 / 7.5 in-out, 0.15 cache read.
  // thinking_level accepts low / medium (default) / high — MINIMAL is a validation error.
  {
    matches: [
      {
        apiType: ['google'],
        modelIdFuzz: [{ modelIdPrefix: 'gemini-3.7-flash' }],
      },
    ],
    inputPrice: 0.75,
    outputPrice: 3.75,
    reasoningPrice: 3.75,
    cacheReadPrice: 0.075,
    contextWindow: 1048576,
    maxOutputTokens: 65536,
    reasoningMode: 'always',
    supportedReasoningEfforts: ['low', 'medium', 'high'],
    supportsTemperature: true,
    supportsTools: true,
  },
  // Gemini 3.6 Flash
  {
    matches: [
      {
        apiType: ['google'],
        modelIdFuzz: [{ modelIdPrefix: 'gemini-3.6-flash' }],
      },
    ],
    inputPrice: 1.5,
    outputPrice: 7.5,
    reasoningPrice: 7.5,
    cacheReadPrice: 0.15,
    contextWindow: 1048576,
    maxOutputTokens: 65536,
    reasoningMode: 'always',
    supportedReasoningEfforts: ['minimal', 'low', 'medium', 'high'],
    supportsTemperature: true,
    supportsTools: true,
  },
  // Gemini 3.5 Flash
  {
    matches: [
      {
        apiType: ['google'],
        modelIdFuzz: [{ modelIdPrefix: 'gemini-3.5-flash' }],
      },
    ],
    inputPrice: 1.5,
    outputPrice: 9.0,
    reasoningPrice: 9.0,
    cacheReadPrice: 0.15,
    contextWindow: 1000000,
    maxOutputTokens: 64000,
    reasoningMode: 'always',
    supportedReasoningEfforts: ['minimal', 'low', 'medium', 'high'],
    supportsTemperature: true,
    supportsTools: true,
  },
  // Gemini 3.1 Pro Preview
  {
    matches: [
      {
        apiType: ['google'],
        modelIdFuzz: [{ modelIdPrefix: 'gemini-3.1-pro' }],
      },
    ],
    inputPrice: 2.0,
    outputPrice: 12.0,
    reasoningPrice: 12.0,
    cacheReadPrice: 0.2,
    contextWindow: 1048576,
    maxOutputTokens: 65535,
    reasoningMode: 'always',
    supportedReasoningEfforts: ['low', 'medium', 'high'], // `minimal` is an error
    supportsTemperature: true,
    supportsTools: true,
  },
  // Gemini 3.1 Flash Lite Preview
  {
    matches: [
      {
        apiType: ['google'],
        modelIdFuzz: [{ modelIdPrefix: 'gemini-3.1-flash-lite' }],
      },
    ],
    inputPrice: 0.25,
    outputPrice: 1.5,
    reasoningPrice: 1.5,
    cacheReadPrice: 0.025,
    contextWindow: 1048576,
    maxOutputTokens: 65535,
    reasoningMode: 'always',
    supportedReasoningEfforts: ['minimal', 'low', 'medium', 'high'],
    supportsTemperature: true,
    supportsTools: true,
  },
  // Gemini 3 Pro Preview
  {
    matches: [
      {
        apiType: ['google'],
        modelIdFuzz: [{ modelIdPrefix: 'gemini-3-pro' }],
      },
    ],
    inputPrice: 2.0,
    outputPrice: 12.0,
    reasoningPrice: 12.0,
    cacheReadPrice: 0.2,
    contextWindow: 1048576,
    maxOutputTokens: 65535,
    reasoningMode: 'always',
    supportedReasoningEfforts: ['low', 'high'],
    supportsTemperature: true,
    supportsTools: true,
  },
  // Gemini 3 Flash Preview
  {
    matches: [
      {
        apiType: ['google'],
        modelIdFuzz: [{ modelIdPrefix: 'gemini-3-flash' }],
      },
    ],
    inputPrice: 0.5,
    outputPrice: 3.0,
    reasoningPrice: 3.0,
    cacheReadPrice: 0.05,
    contextWindow: 1048576,
    maxOutputTokens: 65535,
    reasoningMode: 'always',
    supportedReasoningEfforts: ['minimal', 'low', 'medium', 'high'],
    supportsTemperature: true,
    supportsTools: true,
  },
  // Gemini 2.5 Pro (GA)
  {
    matches: [
      {
        apiType: ['google'],
        modelIdFuzz: [{ modelIdPrefix: 'gemini-2.5-pro' }],
      },
    ],
    inputPrice: 1.25,
    outputPrice: 10.0,
    reasoningPrice: 10.0,
    cacheReadPrice: 0.125,
    contextWindow: 1048576,
    maxOutputTokens: 65535,
    reasoningMode: 'always',
    supportsTemperature: true,
    supportsTools: true,
  },
  // Gemini 2.5 Flash Lite (before generic flash to match first)
  {
    matches: [
      {
        apiType: ['google'],
        modelIdFuzz: [{ modelIdPrefix: 'gemini-2.5-flash-lite' }],
      },
    ],
    inputPrice: 0.1,
    outputPrice: 0.4,
    reasoningPrice: 0.4,
    cacheReadPrice: 0.01,
    contextWindow: 1048576,
    maxOutputTokens: 65535,
    reasoningMode: 'optional',
    supportsTemperature: true,
    supportsTools: true,
  },
  // Gemini 2.5 Flash (GA)
  {
    matches: [
      {
        apiType: ['google'],
        modelIdFuzz: [{ modelIdPrefix: 'gemini-2.5-flash' }],
      },
    ],
    inputPrice: 0.3,
    outputPrice: 2.5,
    reasoningPrice: 2.5,
    cacheReadPrice: 0.03,
    contextWindow: 1048576,
    maxOutputTokens: 65535,
    reasoningMode: 'optional',
    supportsTemperature: true,
    supportsTools: true,
  },
  // Gemini 2.0 Flash Lite (before generic 2.0 flash to match first)
  {
    matches: [
      {
        apiType: ['google'],
        modelIdFuzz: [{ modelIdPrefix: 'gemini-2.0-flash-lite' }],
      },
    ],
    inputPrice: 0.075,
    outputPrice: 0.3,
    contextWindow: 1048576,
    maxOutputTokens: 8192,
    reasoningMode: 'none',
    supportsTemperature: true,
    supportsTools: true,
  },
  // Gemini 2.0 Flash (legacy, no reasoning)
  {
    matches: [
      {
        apiType: ['google'],
        modelIdFuzz: [{ modelIdPrefix: 'gemini-2.0-flash' }],
      },
    ],
    inputPrice: 0.1,
    outputPrice: 0.4,
    cacheReadPrice: 0.025,
    contextWindow: 1048576,
    maxOutputTokens: 8192,
    reasoningMode: 'none',
    supportsTemperature: true,
    supportsTools: true,
  },
];
