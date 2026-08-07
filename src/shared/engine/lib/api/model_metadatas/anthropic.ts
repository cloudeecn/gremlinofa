import type { ModelKnowledge } from '../../../../protocol/types';

export const ANTHROPIC_MODELS: ModelKnowledge[] = [
  {
    // Fable — a distinct model class (adaptive thinking only). Context window is
    // a 200K placeholder until the real spec lands; no `[1m]` suffix needed.
    matches: [
      {
        apiType: ['anthropic', 'claude-agent'],
        modelIdFuzz: [
          { modelIdPrefix: 'claude-fable-5' },
          { modelIdPrefix: 'anthropic.claude-fable-5' },
        ],
      },
    ],
    inputPrice: 10,
    outputPrice: 50,
    cacheWritePrice: 12.5,
    cacheReadPrice: 1,
    webSearchPrice: 0.01,
    contextWindow: 200000,
    maxOutputTokens: 64000,
    supportsAdaptiveReasoning: true,
    onlyAdaptiveReasoning: true,
    supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
  {
    // Opus 4.8 — newest opus; carries the `claude-opus` catch-all in its own
    // low-specificity match so otherwise-unknown future opus ids inherit the
    // adaptive-only 4.8 profile, while specific older ids still resolve to their
    // own dedicated entries below.
    matches: [
      {
        apiType: ['anthropic', 'claude-agent'],
        modelIdFuzz: [
          { modelIdPrefix: 'claude-opus-4-8' },
          { modelIdPrefix: 'anthropic.claude-opus-4-8' },
        ],
      },
      {
        apiType: ['anthropic', 'claude-agent'],
        modelIdFuzz: [
          { modelIdPrefix: 'claude-opus', unreliable: true }, // fuzz match all future opus
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
    supportsAdaptiveReasoning: true,
    onlyAdaptiveReasoning: true,
    supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
  {
    matches: [
      {
        apiType: ['anthropic', 'claude-agent'],
        modelIdFuzz: [
          { modelIdPrefix: 'claude-opus-4-7' },
          { modelIdPrefix: 'anthropic.claude-opus-4-7' },
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
    supportsAdaptiveReasoning: true,
    onlyAdaptiveReasoning: true,
    supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
  {
    matches: [
      {
        apiType: ['anthropic', 'claude-agent'],
        modelIdFuzz: [
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
    supportsAdaptiveReasoning: true,
    // `xhigh` arrived with Opus 4.7; 4.6 takes max but not xhigh.
    supportedReasoningEfforts: ['low', 'medium', 'high', 'max'],
  },
  {
    matches: [
      {
        apiType: ['anthropic', 'claude-agent'],
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
    // Opus 4.0 / 4.1 — legacy $15/$75 tier. Enumerated rather than a bare
    // `claude-opus-4` prefix: without the catch-all here anymore, a broad prefix
    // would greedily swallow a future `claude-opus-4-9`. Keeping it to the known
    // 4.0/4.1 ids lets 4-9 fall through to the adaptive-only 4.8 catch-all.
    matches: [
      {
        apiType: ['anthropic', 'claude-agent'],
        modelIdFuzz: [
          { modelIdPrefix: 'claude-opus-4-0' },
          { modelIdPrefix: 'anthropic.claude-opus-4-0' },
          { modelIdPrefix: 'claude-opus-4-1' },
          { modelIdPrefix: 'anthropic.claude-opus-4-1' },
          { modelIdPrefix: 'claude-opus-4-2025' }, // original Opus 4.0 dated snapshot (claude-opus-4-20250514)
          { modelIdPrefix: 'anthropic.claude-opus-4-2025' },
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
    // Sonnet 5 — same pricing as Sonnet 4.6, adaptive thinking only. The
    // `claude-sonnet` catch-all lives in its own low-specificity match so it
    // only wins for otherwise-unknown future sonnets; specific `-4-x` ids still
    // resolve to their own dedicated entries below.
    matches: [
      {
        apiType: ['anthropic', 'claude-agent'],
        modelIdFuzz: [
          { modelIdPrefix: 'claude-sonnet-5' },
          { modelIdPrefix: 'anthropic.claude-sonnet-5' },
        ],
      },
      {
        apiType: ['anthropic', 'claude-agent'],
        modelIdFuzz: [
          { modelIdPrefix: 'claude-sonnet', unreliable: true }, // fuzz match all future sonnet
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
    supportsAdaptiveReasoning: true,
    onlyAdaptiveReasoning: true,
    supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
  {
    matches: [
      {
        apiType: ['anthropic', 'claude-agent'],
        modelIdFuzz: [
          { modelIdPrefix: 'claude-sonnet-4-6' },
          { modelIdPrefix: 'anthropic.claude-sonnet-4-6' },
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
    supportsAdaptiveReasoning: true,
    // `xhigh` arrived with Opus 4.7; 4.6 takes max but not xhigh.
    supportedReasoningEfforts: ['low', 'medium', 'high', 'max'],
  },
  {
    matches: [
      {
        apiType: ['anthropic', 'claude-agent'],
        modelIdFuzz: [
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
        apiType: ['anthropic', 'claude-agent'],
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
        apiType: ['anthropic', 'claude-agent'],
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
        apiType: ['anthropic', 'claude-agent'],
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
    // Haiku 5 — proactive entry: same pricing as Haiku 4.5, adaptive thinking
    // only (educated guess so the real Haiku 5 needs no code change). Catch-all
    // sits in its own low-specificity match, same as Sonnet 5 above.
    matches: [
      {
        apiType: ['anthropic', 'claude-agent'],
        modelIdFuzz: [
          { modelIdPrefix: 'claude-haiku-5' },
          { modelIdPrefix: 'anthropic.claude-haiku-5' },
        ],
      },
      {
        apiType: ['anthropic', 'claude-agent'],
        modelIdFuzz: [
          { modelIdPrefix: 'claude-haiku', unreliable: true }, // fuzz match all future haiku
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
    supportsAdaptiveReasoning: true,
    onlyAdaptiveReasoning: true,
    // Unverified along with the rest of this entry. `max` is documented as
    // "Claude 4.6 and later"; `xhigh` is a curated list no haiku appears on.
    supportedReasoningEfforts: ['low', 'medium', 'high', 'max'],
  },
  {
    matches: [
      {
        apiType: ['anthropic', 'claude-agent'],
        modelIdFuzz: [
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
        apiType: ['anthropic', 'claude-agent'],
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
        apiType: ['anthropic', 'claude-agent'],
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
        apiType: ['anthropic', 'claude-agent'],
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
