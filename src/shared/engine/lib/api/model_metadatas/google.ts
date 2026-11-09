import type { ModelKnowledge, ScheduledPrice } from '../../../../protocol/types';

// Gemini 2.5 Pro and everything from Gemini 3 on can't switch thinking off
// (`minimal`, where offered, still reasons a little), so they're 'always'. Only
// 2.5 Flash / Flash-Lite accept a zero thinking budget. From 3.6 Flash on,
// temperature / top_p / top_k are ignored (deprecated 2026-07-21; Google says
// later generations will reject them).

/** The current Flash generation's price from 2027-01-01, when its launch rate ends. */
const FLASH_2027_PRICE: ScheduledPrice = {
  effectiveFrom: '2027-01-01',
  inputPrice: 1.5,
  outputPrice: 7.5,
  cacheReadPrice: 0.15,
};

/** Both Gemini 4 models' price from 2026-12-01, when the introductory rate ends. */
const GEMINI_4_DECEMBER_PRICE: ScheduledPrice = {
  effectiveFrom: '2026-12-01',
  inputPrice: 4.0,
  outputPrice: 20.0,
  cacheReadPrice: 0.2,
};

export const GOOGLE_MODELS: ModelKnowledge[] = [
  // Gemini 4 Carbon (GA 2026-11-10) — same price, limits and thinking ladder
  // as Argon, which Google pitches as the one that spends fewer tokens per turn.
  {
    matches: [
      {
        apiType: ['google'],
        modelIdFuzz: [{ modelIdPrefix: 'gemini-4-carbon' }],
      },
    ],
    inputPrice: 2.0,
    outputPrice: 10.0,
    cacheReadPrice: 0.1,
    priceSchedule: [GEMINI_4_DECEMBER_PRICE],
    contextWindow: 1048576,
    maxOutputTokens: 65536,
    reasoningMode: 'always',
    supportedReasoningEfforts: ['low', 'medium', 'high'],
    supportsTemperature: false,
    supportsTools: true,
  },
  // Gemini 4 Argon — 2 / 10 through 2026-11-30, 4 / 20 from 2026-12-01.
  // thinking_level accepts low / medium (default) / high; a thinking_budget is
  // a 400. Output tops out at 65,536 per request: going past that needs long
  // decode (background execution), which this client doesn't do.
  {
    matches: [
      {
        apiType: ['google'],
        modelIdFuzz: [{ modelIdPrefix: 'gemini-4-argon' }],
      },
    ],
    inputPrice: 2.0,
    outputPrice: 10.0,
    cacheReadPrice: 0.1,
    priceSchedule: [GEMINI_4_DECEMBER_PRICE],
    contextWindow: 1048576,
    maxOutputTokens: 65536,
    reasoningMode: 'always',
    supportedReasoningEfforts: ['low', 'medium', 'high'],
    supportsTemperature: false,
    supportsTools: true,
  },
  // Gemini 3.8 Flash — launch rate through 2026-12-31.
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
    cacheReadPrice: 0.075,
    priceSchedule: [FLASH_2027_PRICE],
    contextWindow: 1048576,
    maxOutputTokens: 65536,
    reasoningMode: 'always',
    supportedReasoningEfforts: ['low', 'medium', 'high'],
    supportsTemperature: false,
    supportsTools: true,
  },
  // Gemini 3.7 Flash — deprecated 2026-10-08, requests route to 3.8 Flash and
  // follow its price.
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
    cacheReadPrice: 0.075,
    priceSchedule: [FLASH_2027_PRICE],
    contextWindow: 1048576,
    maxOutputTokens: 65536,
    reasoningMode: 'always',
    supportedReasoningEfforts: ['low', 'medium', 'high'],
    supportsTemperature: false,
    supportsTools: true,
  },
  // Gemini 3.6 Flash — cut to the 3.8 launch rate around 2026-08-13, through
  // 2026-12-31.
  {
    matches: [
      {
        apiType: ['google'],
        modelIdFuzz: [{ modelIdPrefix: 'gemini-3.6-flash' }],
      },
    ],
    inputPrice: 0.75,
    outputPrice: 3.75,
    cacheReadPrice: 0.075,
    priceSchedule: [FLASH_2027_PRICE],
    contextWindow: 1048576,
    maxOutputTokens: 65536,
    reasoningMode: 'always',
    supportedReasoningEfforts: ['minimal', 'low', 'medium', 'high'],
    supportsTemperature: false,
    supportsTools: true,
  },
  // Gemini 3.5 Flash-Lite (GA 2026-07-21). Default thinking level `minimal`;
  // a trailing model turn (prefill) is a 400.
  {
    matches: [
      {
        apiType: ['google'],
        modelIdFuzz: [{ modelIdPrefix: 'gemini-3.5-flash-lite' }],
      },
    ],
    inputPrice: 0.3,
    outputPrice: 2.5,
    cacheReadPrice: 0.03,
    contextWindow: 1048576,
    maxOutputTokens: 65536,
    reasoningMode: 'always',
    supportedReasoningEfforts: ['minimal', 'low', 'medium', 'high'],
    supportsTemperature: false,
    supportsTools: true,
  },
  // Gemini 3.5 Flash — deprecated 2026-10-08, requests route to 3.6 Flash.
  // Google doesn't say which rate routed calls bill at; last list price kept.
  {
    matches: [
      {
        apiType: ['google'],
        modelIdFuzz: [{ modelIdPrefix: 'gemini-3.5-flash' }],
      },
    ],
    inputPrice: 1.5,
    outputPrice: 9.0,
    cacheReadPrice: 0.15,
    contextWindow: 1000000,
    maxOutputTokens: 64000,
    reasoningMode: 'always',
    supportedReasoningEfforts: ['minimal', 'low', 'medium', 'high'],
    supportsTemperature: true,
    supportsTools: true,
  },
  // Gemini 3.1 Pro Preview — prompts over 200K bill at the tier rate.
  {
    matches: [
      {
        apiType: ['google'],
        modelIdFuzz: [{ modelIdPrefix: 'gemini-3.1-pro' }],
      },
    ],
    inputPrice: 2.0,
    outputPrice: 12.0,
    cacheReadPrice: 0.2,
    contextPricingTiers: [
      { thresholdTokens: 200000, inputPrice: 4.0, outputPrice: 18.0, cacheReadPrice: 0.4 },
    ],
    contextWindow: 1048576,
    maxOutputTokens: 65536,
    reasoningMode: 'always',
    supportedReasoningEfforts: ['low', 'medium', 'high'], // `minimal` is an error
    supportsTemperature: true,
    supportsTools: true,
  },
  // Gemini 3.1 Flash Lite Preview — earliest shutdown 2027-05-07.
  {
    matches: [
      {
        apiType: ['google'],
        modelIdFuzz: [{ modelIdPrefix: 'gemini-3.1-flash-lite' }],
      },
    ],
    inputPrice: 0.25,
    outputPrice: 1.5,
    cacheReadPrice: 0.025,
    contextWindow: 1048576,
    maxOutputTokens: 65535,
    reasoningMode: 'always',
    supportedReasoningEfforts: ['minimal', 'low', 'medium', 'high'],
    supportsTemperature: true,
    supportsTools: true,
  },
  // Gemini 3 Pro Preview — shut down 2026-03-09.
  {
    matches: [
      {
        apiType: ['google'],
        modelIdFuzz: [{ modelIdPrefix: 'gemini-3-pro' }],
      },
    ],
    inputPrice: 2.0,
    outputPrice: 12.0,
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
    cacheReadPrice: 0.05,
    contextWindow: 1048576,
    maxOutputTokens: 65535,
    reasoningMode: 'always',
    supportedReasoningEfforts: ['minimal', 'low', 'medium', 'high'],
    supportsTemperature: true,
    supportsTools: true,
  },
  // Gemini 2.5 Pro — deprecated 2026-11-02. From 2026-12-01 requests route to
  // Gemini 3.8 Flash and bill at its rates (no long-prompt tier there).
  {
    matches: [
      {
        apiType: ['google'],
        modelIdFuzz: [{ modelIdPrefix: 'gemini-2.5-pro' }],
      },
    ],
    inputPrice: 1.25,
    outputPrice: 10.0,
    cacheReadPrice: 0.125,
    contextPricingTiers: [
      { thresholdTokens: 200000, inputPrice: 2.5, outputPrice: 15.0, cacheReadPrice: 0.25 },
    ],
    priceSchedule: [
      {
        effectiveFrom: '2026-12-01',
        inputPrice: 0.75,
        outputPrice: 3.75,
        cacheReadPrice: 0.075,
        contextPricingTiers: [],
      },
      FLASH_2027_PRICE,
    ],
    contextWindow: 1048576,
    maxOutputTokens: 65535,
    reasoningMode: 'always',
    supportsTemperature: true,
    supportsTools: true,
  },
  // Gemini 2.5 Flash Lite (before generic flash to match first). Not
  // deprecated, but open only to recent users since 2026-09-18.
  {
    matches: [
      {
        apiType: ['google'],
        modelIdFuzz: [{ modelIdPrefix: 'gemini-2.5-flash-lite' }],
      },
    ],
    inputPrice: 0.1,
    outputPrice: 0.4,
    cacheReadPrice: 0.01,
    contextWindow: 1048576,
    maxOutputTokens: 65535,
    reasoningMode: 'optional',
    supportsTemperature: true,
    supportsTools: true,
  },
  // Gemini 2.5 Flash — deprecated 2026-11-02. From 2026-12-01 requests route
  // to Gemini 3.5 Flash-Lite, whose text price is the same.
  {
    matches: [
      {
        apiType: ['google'],
        modelIdFuzz: [{ modelIdPrefix: 'gemini-2.5-flash' }],
      },
    ],
    inputPrice: 0.3,
    outputPrice: 2.5,
    cacheReadPrice: 0.03,
    contextWindow: 1048576,
    maxOutputTokens: 65535,
    reasoningMode: 'optional',
    supportsTemperature: true,
    supportsTools: true,
  },
  // Gemini 2.0 Flash Lite — shut down 2026-06-01.
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
  // Gemini 2.0 Flash — shut down 2026-06-01.
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
