import type { ModelKnowledge } from '../../../../protocol/types';

export const ANTHROPIC_MODELS: ModelKnowledge[] = [
  {
    // Fable 5.1 — cache reads at 0.025x input ($0.25/MTok) instead of the
    // standard 0.1x. Longer prefix outranks the `claude-fable-5` entry below.
    matches: [
      {
        apiType: ['anthropic', 'claude-agent'],
        modelIdFuzz: [
          { modelIdPrefix: 'claude-fable-5-1' },
          { modelIdPrefix: 'anthropic.claude-fable-5-1' },
        ],
      },
    ],
    inputPrice: 10,
    outputPrice: 50,
    cacheWritePrice: 12.5,
    cacheReadPrice: 0.25,
    webSearchPrice: 0.01,
    contextWindow: 1000000,
    maxOutputTokens: 128000,
    supportsAdaptiveReasoning: true,
    onlyAdaptiveReasoning: true,
    reasoningMode: 'always', // can't switch thinking off; toggle off → lowest effort
    supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
  {
    // Fable — a distinct model class (adaptive thinking only). 1M context is
    // the default, not the `[1m]`-suffix opt-in, so no suffix needed.
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
    contextWindow: 1000000,
    maxOutputTokens: 128000,
    supportsAdaptiveReasoning: true,
    onlyAdaptiveReasoning: true,
    reasoningMode: 'always', // can't switch thinking off; toggle off → lowest effort
    supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
  {
    // Opus 5.5 — newest opus; carries the `claude-opus` catch-all in its own
    // low-specificity match so otherwise-unknown future opus ids inherit the
    // adaptive-only 5.5 profile, while specific older ids still resolve to their
    // own dedicated entries below. Cache reads are 5% of input ($0.20/MTok)
    // instead of the family-standard 10%. 1M context is the default here — no
    // `[1m]` opt-in — so no `supportsExtendedContext`.
    matches: [
      {
        apiType: ['anthropic', 'claude-agent'],
        modelIdFuzz: [
          { modelIdPrefix: 'claude-opus-5-5' },
          { modelIdPrefix: 'anthropic.claude-opus-5-5' },
        ],
      },
      {
        apiType: ['anthropic', 'claude-agent'],
        modelIdFuzz: [
          { modelIdPrefix: 'claude-opus', unreliable: true }, // fuzz match all future opus
        ],
      },
    ],
    inputPrice: 4,
    outputPrice: 20,
    cacheWritePrice: 5,
    cacheReadPrice: 0.2,
    webSearchPrice: 0.01,
    contextWindow: 1000000,
    maxOutputTokens: 128000,
    supportsAdaptiveReasoning: true,
    onlyAdaptiveReasoning: true,
    reasoningMode: 'always', // can't switch thinking off; toggle off → lowest effort
    supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
  {
    // Opus 5 — needs its own entry now that the `claude-opus` catch-all points
    // at 5.5, which is priced lower. Adaptive-only: `thinking.type: enabled`
    // 400s, so a budget must never pick it. Thinking is on by default and can
    // be disabled only at effort `high` or below. 1M context is the default, as
    // on 5.5.
    // Matched by exact id plus a year-scoped fuzz for dated snapshots — a bare
    // `claude-opus-5` prefix would swallow every future 5.x id and pin it to
    // this legacy tier instead of letting the catch-all hand it the newest one.
    matches: [
      {
        apiType: ['anthropic', 'claude-agent'],
        modelIdExact: ['claude-opus-5', 'anthropic.claude-opus-5'],
      },
      {
        apiType: ['anthropic', 'claude-agent'],
        modelIdFuzz: [
          { modelIdPrefix: 'claude-opus-5-2026' },
          { modelIdPrefix: 'anthropic.claude-opus-5-2026' },
        ],
      },
    ],
    inputPrice: 5,
    outputPrice: 25,
    cacheWritePrice: 6.25,
    cacheReadPrice: 0.5,
    webSearchPrice: 0.01,
    contextWindow: 1000000,
    maxOutputTokens: 128000,
    supportsAdaptiveReasoning: true,
    onlyAdaptiveReasoning: true,
    thinkingOffType: 'disabled',
    supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
  {
    matches: [
      {
        apiType: ['anthropic', 'claude-agent'],
        modelIdFuzz: [
          { modelIdPrefix: 'claude-opus-4-8' },
          { modelIdPrefix: 'anthropic.claude-opus-4-8' },
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
    // The one extended-thinking-only model that takes effort, beside budget_tokens.
    supportedReasoningEfforts: ['low', 'medium', 'high'],
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
    // Sonnet 5.5 — newest sonnet, so it carries the `claude-sonnet` catch-all in
    // its own low-specificity match; specific older ids still resolve to their
    // own entries below. Thinks by default and rejects `disabled`: its off switch
    // is `thinking: {type: 'between_tools'}`, which isn't sent yet (the Agent SDK
    // type lacks it), so until then it's treated as always-on.
    matches: [
      {
        apiType: ['anthropic', 'claude-agent'],
        modelIdFuzz: [
          { modelIdPrefix: 'claude-sonnet-5-5' },
          { modelIdPrefix: 'anthropic.claude-sonnet-5-5' },
        ],
      },
      {
        apiType: ['anthropic', 'claude-agent'],
        modelIdFuzz: [
          { modelIdPrefix: 'claude-sonnet', unreliable: true }, // fuzz match all future sonnet
        ],
      },
    ],
    inputPrice: 2,
    outputPrice: 10,
    cacheWritePrice: 2.5,
    cacheReadPrice: 0.2,
    webSearchPrice: 0.01,
    contextWindow: 1000000,
    maxOutputTokens: 128000,
    supportsAdaptiveReasoning: true,
    onlyAdaptiveReasoning: true,
    reasoningMode: 'always',
    supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
  {
    // Sonnet 5 — adaptive thinking only, on by default; `disabled` switches it
    // off.
    matches: [
      {
        apiType: ['anthropic', 'claude-agent'],
        modelIdFuzz: [
          { modelIdPrefix: 'claude-sonnet-5' },
          { modelIdPrefix: 'anthropic.claude-sonnet-5' },
        ],
      },
    ],
    inputPrice: 2,
    outputPrice: 10,
    cacheWritePrice: 2.5,
    cacheReadPrice: 0.2,
    webSearchPrice: 0.01,
    contextWindow: 200000,
    maxOutputTokens: 64000,
    supportsExtendedContext: true,
    supportsAdaptiveReasoning: true,
    onlyAdaptiveReasoning: true,
    thinkingOffType: 'disabled',
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
