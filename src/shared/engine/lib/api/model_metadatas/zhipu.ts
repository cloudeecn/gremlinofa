import type { ModelKnowledge } from '../../../../protocol/types';

// Zhipu / Z.ai GLM (OpenAI- & Anthropic-compatible endpoints).
// Prices are USD per 1M tokens: input / cached-input read / output.
// (Cached-input *storage* fees are not tracked — only read pricing.)
// Overlapping prefixes (glm-4.7 vs -flash/-flashx, glm-4.5 vs -air/-airx/-x,
// glm-5 vs -5.1/-5.2/-5-turbo) resolve to the longest match via the
// specificity sort in modelMetadata.ts.

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
    deFactoThinking: true,
    supportsTools: true,
    ...extra,
  };
}

export const ZHIPU_MODELS: ModelKnowledge[] = [
  glm('glm-5.2', 1.4, 0.26, 4.4),
  glm('glm-5.1', 1.4, 0.26, 4.4),
  glm('glm-5-turbo', 1.2, 0.24, 4.0),
  glm('glm-5', 1.0, 0.2, 3.2),
  glm('glm-4.7-flashx', 0.07, 0.01, 0.4),
  glm('glm-4.7-flash', 0, 0, 0), // free
  glm('glm-4.7', 0.6, 0.11, 2.2),
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
    deFactoThinking: false,
  }),
];
