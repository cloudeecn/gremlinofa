import type { ModelKnowledge } from '../../../../protocol/types';

export const GOOGLE_MODELS: ModelKnowledge[] = [
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
    reasoningMode: 'optional',
    supportedReasoningEfforts: ['minimal', 'low', 'medium', 'high'],
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
    reasoningMode: 'optional',
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
    reasoningMode: 'optional',
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
    reasoningMode: 'optional',
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
    reasoningMode: 'optional',
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
