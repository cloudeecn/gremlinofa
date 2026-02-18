import type { ModelKnowledge } from '../../../types';

export const ANTHROPIC_MODELS: ModelKnowledge[] = [
  {
    matches: [
      {
        apiType: ['anthropic'],
        modelIdFuzz: [
          { modelIdPrefix: 'claude-opus', unreliable: true }, // fuzz match all future opus
          { modelIdPrefix: 'claude-opus-4-6' },
          { modelIdPrefix: 'anthropic.claude-opus-4-6' },
        ],
      },
    ],
    inputPrice: 5,
    outputPrice: 25,
    cacheWritePrice: 6.25,
    cacheReadPrice: 0.5,
    webSearchPrice: 0.01,
    contextWindow: 200000,
    maxOutputTokens: 128000,
    supportsExtendedContext: true,
  },
  {
    matches: [
      {
        apiType: ['anthropic'],
        modelIdFuzz: [
          { modelIdPrefix: 'claude-opus-4-5' },
          { modelIdPrefix: 'anthropic.claude-opus-4-5' },
        ],
      },
    ],
    inputPrice: 5,
    outputPrice: 25,
    cacheWritePrice: 6.25,
    cacheReadPrice: 0.5,
    webSearchPrice: 0.01,
    contextWindow: 200000,
    maxOutputTokens: 64000,
  },
  {
    matches: [
      {
        apiType: ['anthropic'],
        modelIdFuzz: [
          { modelIdPrefix: 'claude-opus-4' },
          { modelIdPrefix: 'anthropic.claude-opus-4' },
        ],
      },
    ],
    inputPrice: 15,
    outputPrice: 75,
    cacheWritePrice: 18.75,
    cacheReadPrice: 1.5,
    webSearchPrice: 0.01,
    contextWindow: 200000,
    maxOutputTokens: 64000,
  },
  {
    matches: [
      {
        apiType: ['anthropic'],
        modelIdFuzz: [
          { modelIdPrefix: 'claude-sonnet', unreliable: true }, // fuzz match all future sonnet
          { modelIdPrefix: 'claude-sonnet-4-5' },
          { modelIdPrefix: 'anthropic.claude-sonnet-4-5' },
        ],
      },
    ],
    inputPrice: 3,
    outputPrice: 15,
    cacheWritePrice: 3.75,
    cacheReadPrice: 0.3,
    webSearchPrice: 0.01,
    contextWindow: 200000,
    maxOutputTokens: 64000,
    supportsExtendedContext: true,
  },
  {
    matches: [
      {
        apiType: ['anthropic'],
        modelIdFuzz: [
          { modelIdPrefix: 'claude-sonnet-4' },
          { modelIdPrefix: 'anthropic.claude-sonnet-4' },
        ],
      },
    ],
    inputPrice: 3,
    outputPrice: 15,
    cacheWritePrice: 3.75,
    cacheReadPrice: 0.3,
    webSearchPrice: 0.01,
    contextWindow: 200000,
    maxOutputTokens: 16384,
    supportsExtendedContext: true,
  },
  {
    matches: [
      {
        apiType: ['anthropic'],
        modelIdFuzz: [
          { modelIdPrefix: 'claude-3-7-sonnet' },
          { modelIdPrefix: 'anthropic.claude-3-7-sonnet' },
        ],
      },
    ],
    inputPrice: 3,
    outputPrice: 15,
    cacheWritePrice: 3.75,
    cacheReadPrice: 0.3,
    webSearchPrice: 0.01,
    contextWindow: 200000,
    maxOutputTokens: 8192,
  },
  {
    matches: [
      {
        apiType: ['anthropic'],
        modelIdFuzz: [
          { modelIdPrefix: 'claude-3-5-sonnet' },
          { modelIdPrefix: 'anthropic.claude-3-5-sonnet' },
        ],
      },
    ],
    inputPrice: 3,
    outputPrice: 15,
    cacheWritePrice: 3.75,
    cacheReadPrice: 0.3,
    webSearchPrice: 0.01,
    contextWindow: 200000,
    maxOutputTokens: 8192,
  },
  {
    matches: [
      {
        apiType: ['anthropic'],
        modelIdFuzz: [
          { modelIdPrefix: 'claude-haiku', unreliable: true }, // fuzz match all haiku
          { modelIdPrefix: 'claude-haiku-4-5' },
          { modelIdPrefix: 'anthropic.claude-haiku-4-5' },
        ],
      },
    ],
    inputPrice: 1,
    outputPrice: 5,
    cacheWritePrice: 1.25,
    cacheReadPrice: 0.1,
    webSearchPrice: 0.01,
    contextWindow: 200000,
    maxOutputTokens: 8192,
  },
  {
    matches: [
      {
        apiType: ['anthropic'],
        modelIdFuzz: [
          { modelIdPrefix: 'claude-3-5-haiku' },
          { modelIdPrefix: 'anthropic.claude-3-5-haiku' },
        ],
      },
    ],
    inputPrice: 0.8,
    outputPrice: 4,
    cacheWritePrice: 1,
    cacheReadPrice: 0.08,
    webSearchPrice: 0.01,
    contextWindow: 200000,
    maxOutputTokens: 8192,
  },
  {
    matches: [
      {
        apiType: ['anthropic'],
        modelIdFuzz: [
          { modelIdPrefix: 'claude-opus-3' },
          { modelIdPrefix: 'anthropic.claude-opus-3' },
        ],
      },
    ],
    inputPrice: 15,
    outputPrice: 75,
    cacheWritePrice: 18.75,
    cacheReadPrice: 1.5,
    webSearchPrice: 0.01,
    contextWindow: 200000,
    maxOutputTokens: 4096,
  },
  {
    matches: [
      {
        apiType: ['anthropic'],
        modelIdFuzz: [
          { modelIdPrefix: 'claude-3-haiku' },
          { modelIdPrefix: 'anthropic.claude-3-haiku' },
        ],
      },
    ],
    inputPrice: 0.25,
    outputPrice: 1.25,
    cacheWritePrice: 0.3,
    cacheReadPrice: 0.03,
    webSearchPrice: 0.01,
    contextWindow: 200000,
    maxOutputTokens: 4096,
  },
];
