import type { ModelKnowledge } from '../../../../protocol/types';

// Every Claude model from the 4.6 generation on (Haiku 5.5 included) serves
// its 1M window by default: no `context-1m` beta header, no long-context
// premium except Haiku 5.5's >100K tier. Sonnet 4.5 and older are 200K.

const SONNET_4_6 = {
  inputPrice: 3,
  outputPrice: 15,
  cacheWritePrice: 3.75,
  cacheReadPrice: 0.3,
  webSearchPrice: 0.01,
  maxOutputTokens: 128000,
  supportsAdaptiveReasoning: true,
  // `xhigh` arrived with Opus 4.7; 4.6 takes max but not xhigh.
  supportedReasoningEfforts: ['low', 'medium', 'high', 'max'],
} satisfies Partial<ModelKnowledge>;

export const ANTHROPIC_MODELS: ModelKnowledge[] = [
  {
    // Fable 5.2 — newest Fable, so it carries the `claude-fable` catch-all in
    // its own low-specificity match. Mythos 5.2 is the same model for verified
    // organizations, same price. Cache reads at 0.025x input, as on 5.1.
    matches: [
      {
        apiType: ['anthropic', 'claude-agent'],
        modelIdFuzz: [
          { modelIdPrefix: 'claude-fable-5-2' },
          { modelIdPrefix: 'anthropic.claude-fable-5-2' },
          { modelIdPrefix: 'claude-mythos-5-2' },
          { modelIdPrefix: 'anthropic.claude-mythos-5-2' },
        ],
      },
      {
        apiType: ['anthropic', 'claude-agent'],
        modelIdFuzz: [
          { modelIdPrefix: 'claude-fable', unreliable: true }, // fuzz match all future fable
          { modelIdPrefix: 'claude-mythos', unreliable: true },
        ],
      },
    ],
    inputPrice: 8,
    outputPrice: 40,
    cacheWritePrice: 10,
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
    // Fable 5.1 / Mythos 5.1 — cache reads at 0.025x input ($0.25/MTok)
    // instead of the standard 0.1x.
    matches: [
      {
        apiType: ['anthropic', 'claude-agent'],
        modelIdFuzz: [
          { modelIdPrefix: 'claude-fable-5-1' },
          { modelIdPrefix: 'anthropic.claude-fable-5-1' },
          { modelIdPrefix: 'claude-mythos-5-1' },
          { modelIdPrefix: 'anthropic.claude-mythos-5-1' },
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
    // Fable 5 / Mythos 5 — a distinct model class (adaptive thinking only).
    // Exact id plus a year-scoped fuzz: a bare `claude-fable-5` prefix would
    // swallow every future 5.x id and pin it here instead of letting the
    // catch-all hand it the newest profile.
    matches: [
      {
        apiType: ['anthropic', 'claude-agent'],
        modelIdExact: [
          'claude-fable-5',
          'anthropic.claude-fable-5',
          'claude-mythos-5',
          'anthropic.claude-mythos-5',
        ],
      },
      {
        apiType: ['anthropic', 'claude-agent'],
        modelIdFuzz: [
          { modelIdPrefix: 'claude-fable-5-2026' },
          { modelIdPrefix: 'anthropic.claude-fable-5-2026' },
          { modelIdPrefix: 'claude-mythos-5-2026' },
          { modelIdPrefix: 'anthropic.claude-mythos-5-2026' },
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
    // instead of the family-standard 10%.
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
    // be disabled only at effort `high` or below.
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
    contextWindow: 1000000,
    maxOutputTokens: 128000,
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
    contextWindow: 1000000,
    maxOutputTokens: 128000,
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
    contextWindow: 1000000,
    maxOutputTokens: 128000,
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
    // own entries below. Cache reads at 0.05x input. Thinks by default and
    // rejects `disabled`: its off switch is `thinking: {type: 'between_tools'}`,
    // which isn't sent yet (the Agent SDK type lacks it), so until then it's
    // treated as always-on.
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
    cacheReadPrice: 0.1,
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
    // off. Exact id plus a year-scoped fuzz, as on Opus 5, so a future
    // `claude-sonnet-5-x` reaches the catch-all.
    matches: [
      {
        apiType: ['anthropic', 'claude-agent'],
        modelIdExact: ['claude-sonnet-5', 'anthropic.claude-sonnet-5'],
      },
      {
        apiType: ['anthropic', 'claude-agent'],
        modelIdFuzz: [
          { modelIdPrefix: 'claude-sonnet-5-2026' },
          { modelIdPrefix: 'anthropic.claude-sonnet-5-2026' },
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
    thinkingOffType: 'disabled',
    supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
  {
    matches: [
      {
        apiType: ['anthropic'],
        modelIdFuzz: [
          { modelIdPrefix: 'claude-sonnet-4-6' },
          { modelIdPrefix: 'anthropic.claude-sonnet-4-6' },
        ],
      },
    ],
    ...SONNET_4_6,
    contextWindow: 1000000,
  },
  {
    // claude-agent: Claude Code serves Sonnet 4.6 at 1M only through its
    // `[1m]` variant, which needs usage credits on every plan, so 1M is
    // unsupported there and the window is 200K.
    matches: [
      {
        apiType: ['claude-agent'],
        modelIdFuzz: [
          { modelIdPrefix: 'claude-sonnet-4-6' },
          { modelIdPrefix: 'anthropic.claude-sonnet-4-6' },
        ],
      },
    ],
    ...SONNET_4_6,
    contextWindow: 200000,
  },
  {
    // Deprecated; retires 2026-11-30.
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
    // Haiku 5.5 — newest haiku, carries the `claude-haiku` catch-all. Priced by
    // prompt length: a request over 100,000 prompt tokens (cache reads and
    // writes included) bills every token at 5x. Adaptive thinking only, on by
    // default; `disabled` is accepted at effort `high` or below.
    matches: [
      {
        apiType: ['anthropic', 'claude-agent'],
        modelIdFuzz: [
          { modelIdPrefix: 'claude-haiku-5-5' },
          { modelIdPrefix: 'anthropic.claude-haiku-5-5' },
        ],
      },
      {
        apiType: ['anthropic', 'claude-agent'],
        modelIdFuzz: [
          { modelIdPrefix: 'claude-haiku', unreliable: true }, // fuzz match all future haiku
        ],
      },
    ],
    inputPrice: 0.1,
    outputPrice: 0.5,
    cacheWritePrice: 0.125,
    cacheReadPrice: 0.01,
    contextPricingTiers: [
      {
        thresholdTokens: 100000,
        inputPrice: 0.5,
        outputPrice: 2.5,
        cacheWritePrice: 0.625,
        cacheReadPrice: 0.05,
      },
    ],
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
    maxOutputTokens: 64000,
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
