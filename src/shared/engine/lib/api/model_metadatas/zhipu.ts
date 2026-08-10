import type { ModelKnowledge } from '../../../../protocol/types';

// Zhipu / Z.ai GLM (OpenAI- & Anthropic-compatible endpoints).
// Prices are USD per 1M tokens: input / cached-input read / output.
// (Cached-input *storage* fees are not tracked — only read pricing.)
// Overlapping prefixes (glm-4.7 / glm-5.3 vs -flash/-flashx, glm-4.5 vs
// -air/-airx/-x, glm-5 vs -5.1/-5.2/-5.3/-5-turbo) resolve to the longest
// match via the specificity sort in modelMetadata.ts.

/** Modern GLM (4.5+/5) are hybrid reasoning models with de-facto thinking + tools. */
function glm(
  modelIdPrefix: string,
  inputPrice: number,
  cacheReadPrice: number | undefined,
  outputPrice: number,
  extra: Partial<ModelKnowledge> = {}
): ModelKnowledge {
  return {
    matches: [
      { apiType: ['anthropic', 'chatgpt', 'responses_api'], modelIdFuzz: [{ modelIdPrefix }] },
    ],
    inputPrice,
    ...(cacheReadPrice !== undefined ? { cacheReadPrice } : {}),
    outputPrice,
    reasoningMode: 'optional',
    supportedReasoningEfforts: [],
    reasoningDialect: 'thinking-object',
    supportsTools: true,
    ...extra,
  };
}

/** `thinking.clear_thinking` arrived with GLM-4.7; earlier models reject or ignore it. */
const CLEAR_THINKING: Partial<ModelKnowledge> = { reasoningHistoryParam: 'clear_thinking' };

/**
 * GLM-5.3 family: 1M context, 128K output, thinking can't be disabled. Z.ai's
 * general API, Alibaba and OpenRouter 400 on `thinking: disabled`; only the
 * Z.ai coding plan still accepts it (and reasons anyway). `reasoning_effort`
 * rides beside `thinking`, server default `max`.
 */
const GLM_5_3: Partial<ModelKnowledge> = {
  contextWindow: 1048576,
  maxOutputTokens: 131072,
  reasoningMode: 'always',
  supportedReasoningEfforts: ['low', 'high', 'max'],
  ...CLEAR_THINKING,
};

export const ZHIPU_MODELS: ModelKnowledge[] = [
  // GLM-5.3-Flash list price; the launch promo (0.075 / 0.015 / 0.25) ended 2026-09-09.
  glm('glm-5.3-flashx', 0.37, 0.075, 1.25, GLM_5_3),
  glm('glm-5.3-flash', 0.15, 0.03, 0.5, GLM_5_3),
  glm('glm-5.3', 1.4, 0.26, 4.4, GLM_5_3),
  // GLM-5.2's documented effort ladder is high / max (default max); `low` and
  // `medium` map to high, `none` and `minimal` skip thinking.
  glm('glm-5.2', 1.4, 0.26, 4.4, { ...CLEAR_THINKING, supportedReasoningEfforts: ['high', 'max'] }),
  glm('glm-5.1', 1.4, 0.26, 4.4, CLEAR_THINKING),
  glm('glm-5-turbo', 1.2, 0.24, 4.0, CLEAR_THINKING),
  glm('glm-5', 1.0, 0.2, 3.2, CLEAR_THINKING),
  glm('glm-4.7-flashx', 0.07, 0.01, 0.4, CLEAR_THINKING),
  glm('glm-4.7-flash', 0, 0, 0, CLEAR_THINKING), // free
  glm('glm-4.7', 0.6, 0.11, 2.2, CLEAR_THINKING),
  glm('glm-4.6', 0.6, 0.11, 2.2),
  glm('glm-4.5-airx', 1.1, 0.22, 4.5),
  glm('glm-4.5-air', 0.2, 0.03, 1.1),
  glm('glm-4.5-x', 2.2, 0.45, 8.9),
  glm('glm-4.5-flash', 0, 0, 0), // free
  glm('glm-4.5', 0.6, 0.11, 2.2),
  // GLM-4-32B-0414 (128K) — older non-thinking base model; function calling only.
  glm('glm-4-32b-0414-128k', 0.1, undefined, 0.1, {
    contextWindow: 131072,
    reasoningMode: 'none',
    reasoningDialect: 'openai',
  }),
];
