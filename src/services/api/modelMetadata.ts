/**
 * Comprehensive Model Metadata Types
 * Unified schema for model information from OpenAI, Anthropic, xAI, OpenRouter, and other providers
 */

import type { APIDefinition, ModelKnowledge, Model } from '../../types';
import { ANTHROPIC_MODELS } from './model_metadatas/anthropic';
import { OPENAI_MODELS } from './model_metadatas/openai';
import { XAI_MODELS } from './model_metadatas/xai';

// Combined model knowledge from all providers
const ALL_MODEL_KNOWLEDGE: ModelKnowledge[] = [
  ...ANTHROPIC_MODELS,
  ...OPENAI_MODELS,
  ...XAI_MODELS,
];

// Flattened match entry with single match condition
interface FlattenedModelKnowledge {
  knowledge: ModelKnowledge;
  match: ModelKnowledge['matches'][0];
}

interface ModelKnowledgeStorage {
  exactModelIdIndex: Map<string, ModelKnowledge>;
  modelKnowledges: FlattenedModelKnowledge[];
}

// apiDefinitionId -> ModelKnowledgeStorage map
const modelKnowledgesCache: Map<string, ModelKnowledgeStorage> = new Map();

/**
 * Check if endpoint matches the apiDefinition's baseUrl
 * - undefined endpoint: pass (no restriction)
 * - empty array: fail (explicitly no endpoints allowed)
 * - array with elements: pass if baseUrl exactly matches any entry (string or RegExp.test())
 */
function matchesEndpoint(baseUrl: string, endpoints: Array<RegExp | string> | undefined): boolean {
  if (endpoints === undefined) return true;
  if (endpoints.length === 0) return false;
  return endpoints.some(ep => {
    if (ep instanceof RegExp) {
      return ep.test(baseUrl);
    }
    return baseUrl === ep;
  });
}

/**
 * Calculate match specificity score for sorting
 * Higher score = more specific match
 */
function getMatchSpecificityScore(match: ModelKnowledge['matches'][0]): number {
  let score = 0;

  // Exact matches are most specific (handled separately via index)
  // For fuzz matches, prioritize by prefix/postfix presence and length
  if (match.modelIdFuzz) {
    for (const fuzz of match.modelIdFuzz) {
      const hasPrefix = !!fuzz.modelIdPrefix;
      const hasPostfix = !!fuzz.modelIdPostfix;
      const prefixLen = fuzz.modelIdPrefix?.length ?? 0;
      const postfixLen = fuzz.modelIdPostfix?.length ?? 0;

      // Score by presence: both > postfix only > prefix only
      let presenceScore = 0;
      if (hasPrefix && hasPostfix) {
        presenceScore = 3000;
      } else if (hasPostfix) {
        presenceScore = 2000;
      } else if (hasPrefix) {
        presenceScore = 1000;
      }

      // Add length for specificity
      const lengthScore = prefixLen + postfixLen;

      score = Math.max(score, presenceScore + lengthScore);
    }
  }

  return score;
}

/**
 * Compare two flattened entries for sorting (descending by specificity)
 */
function compareMatchSpecificity(a: FlattenedModelKnowledge, b: FlattenedModelKnowledge): number {
  const scoreA = getMatchSpecificityScore(a.match);
  const scoreB = getMatchSpecificityScore(b.match);
  return scoreB - scoreA;
}

/**
 * Build model knowledge storage for an API definition
 */
function buildModelKnowledgeStorage(apiDefinition: APIDefinition): ModelKnowledgeStorage {
  const storage: ModelKnowledgeStorage = {
    exactModelIdIndex: new Map(),
    modelKnowledges: [],
  };

  const { apiType, baseUrl } = apiDefinition;

  // Step 1 & 2: Flatten and filter matches
  for (const knowledge of ALL_MODEL_KNOWLEDGE) {
    for (const match of knowledge.matches) {
      // Check apiType match
      if (!match.apiType.includes(apiType)) continue;

      // Check endpoint match
      if (!matchesEndpoint(baseUrl, match.endpoint)) continue;

      // Create flattened entry
      const flattened: FlattenedModelKnowledge = { knowledge, match };

      // Add to exact index if has exact matches
      if (match.modelIdExact) {
        for (const exactId of match.modelIdExact) {
          // First match wins for exact index
          if (!storage.exactModelIdIndex.has(exactId)) {
            storage.exactModelIdIndex.set(exactId, knowledge);
          }
        }
      }

      // Add to fuzz list if has fuzz patterns
      if (match.modelIdFuzz && match.modelIdFuzz.length > 0) {
        storage.modelKnowledges.push(flattened);
      }
    }
  }

  // Step 3: Sort fuzz matches by specificity
  storage.modelKnowledges.sort(compareMatchSpecificity);

  return storage;
}

/**
 * Get or build model knowledge storage for an API definition
 */
const getModelKnowledges = (apiDefinition: APIDefinition): ModelKnowledgeStorage => {
  const apiDefinitionId = apiDefinition.id;
  let storage = modelKnowledgesCache.get(apiDefinitionId);
  if (storage) return storage;

  storage = buildModelKnowledgeStorage(apiDefinition);
  modelKnowledgesCache.set(apiDefinitionId, storage);
  return storage;
};

/**
 * Check if modelId matches a fuzz pattern (prefix and/or postfix)
 */
function fuzzMatchModelId(
  modelId: string,
  fuzzPatterns: NonNullable<ModelKnowledge['matches'][0]['modelIdFuzz']>
): boolean {
  return fuzzPatterns.some(fuzz => {
    const { modelIdPrefix, modelIdPostfix } = fuzz;
    const matchesPrefix = !modelIdPrefix || modelId.startsWith(modelIdPrefix);
    const matchesPostfix = !modelIdPostfix || modelId.endsWith(modelIdPostfix);
    return matchesPrefix && matchesPostfix;
  });
}

/**
 * Deep clone ModelKnowledge fields into a Model (excluding matches)
 */
function cloneKnowledgeToModel(
  knowledge: ModelKnowledge
): Omit<Model, 'id' | 'name' | 'apiType' | 'matchedMode'> {
  const {
    matches: _matches, // Exclude matches
    ...metadata
  } = knowledge;

  // Deep clone to avoid mutation
  return JSON.parse(JSON.stringify(metadata));
}

/**
 * Get model metadata for a specific model ID
 */
export const getModelMetadataFor = (apiDefinition: APIDefinition, modelId: string): Model => {
  const storage = getModelKnowledges(apiDefinition);

  // Try exact match first
  const exactMatch = storage.exactModelIdIndex.get(modelId);
  if (exactMatch) {
    return {
      id: modelId,
      name: modelId,
      apiType: apiDefinition.apiType,
      matchedMode: 'exact',
      ...cloneKnowledgeToModel(exactMatch),
    };
  }

  // Try fuzz match
  for (const { knowledge, match } of storage.modelKnowledges) {
    if (match.modelIdFuzz && fuzzMatchModelId(modelId, match.modelIdFuzz)) {
      return {
        id: modelId,
        name: modelId,
        apiType: apiDefinition.apiType,
        matchedMode: 'fuzz',
        ...cloneKnowledgeToModel(knowledge),
      };
    }
  }

  // No match - return default with minimal info
  return {
    id: modelId,
    name: modelId,
    apiType: apiDefinition.apiType,
    matchedMode: 'default',
  };
};

/**
 * Clear cached model knowledge (useful when API definitions change)
 */
export const clearModelKnowledgeCache = (apiDefinitionId?: string): void => {
  if (apiDefinitionId) {
    modelKnowledgesCache.delete(apiDefinitionId);
  } else {
    modelKnowledgesCache.clear();
  }
};

// ============================================================================
// Pricing & Cost Utilities
// ============================================================================

/**
 * Check if cost calculation is unreliable for a model/usage combination.
 * Cost is unreliable when:
 * - Model's matchedMode is 'unreliable' or 'default' (unknown model)
 * - Any price is undefined when corresponding count is non-zero
 *
 * @param model - Model with pricing info
 * @param inputTokens - Input/prompt tokens
 * @param outputTokens - Output/completion tokens
 * @param reasoningTokens - Internal reasoning tokens (o-series, gpt-5)
 * @param cacheCreationTokens - Anthropic cache write tokens
 * @param cacheReadTokens - Cache hit tokens
 * @param webSearchCount - Number of web search requests
 * @returns True if cost calculation is unreliable
 */
export function isCostUnreliable(
  model: Model,
  inputTokens: number,
  outputTokens: number,
  reasoningTokens?: number,
  cacheCreationTokens?: number,
  cacheReadTokens?: number,
  webSearchCount?: number
): boolean {
  // Model metadata is unreliable or unknown
  if (model.matchedMode === 'unreliable' || model.matchedMode === 'default') {
    return true;
  }

  // Check if any price is undefined when count is non-zero
  if (inputTokens > 0 && model.inputPrice === undefined) return true;
  if (outputTokens > 0 && model.outputPrice === undefined) return true;
  if (reasoningTokens && reasoningTokens > 0 && model.reasoningPrice === undefined) return true;
  if (cacheCreationTokens && cacheCreationTokens > 0 && model.cacheWritePrice === undefined)
    return true;
  if (cacheReadTokens && cacheReadTokens > 0 && model.cacheReadPrice === undefined) return true;
  if (webSearchCount && webSearchCount > 0 && model.webSearchPrice === undefined) return true;

  return false;
}

/**
 * Calculate cost for a message based on model pricing.
 * Stateless function that works with any Model or ModelMetadata object.
 *
 * @param model - Model with pricing info (null returns 0)
 * @param inputTokens - Input/prompt tokens
 * @param outputTokens - Output/completion tokens
 * @param reasoningTokens - Internal reasoning tokens (o-series, gpt-5)
 * @param cacheCreationTokens - Anthropic cache write tokens
 * @param cacheReadTokens - Cache hit tokens
 * @param webSearchCount - Number of web search requests
 * @returns Total cost in USD
 */
export function calculateCost(
  model: Model,
  inputTokens: number,
  outputTokens: number,
  reasoningTokens?: number,
  cacheCreationTokens?: number,
  cacheReadTokens?: number,
  webSearchCount?: number
): number {
  let cost = 0;

  // Token-based costs (per 1M tokens)
  if (model.inputPrice) {
    cost += (inputTokens / 1_000_000) * model.inputPrice;
  }
  if (model.outputPrice) {
    cost += (outputTokens / 1_000_000) * model.outputPrice;
  }
  if (model.reasoningPrice && reasoningTokens) {
    cost += (reasoningTokens / 1_000_000) * model.reasoningPrice;
  }
  if (model.cacheWritePrice && cacheCreationTokens) {
    cost += (cacheCreationTokens / 1_000_000) * model.cacheWritePrice;
  }
  if (model.cacheReadPrice && cacheReadTokens) {
    cost += (cacheReadTokens / 1_000_000) * model.cacheReadPrice;
  }

  // Per-request costs
  if (model.webSearchPrice && webSearchCount) {
    cost += webSearchCount * model.webSearchPrice;
  }
  if (model.requestPrice) {
    cost += model.requestPrice;
  }

  return cost;
}

/**
 * Format model pricing for UI display.
 * Shows input/cache/output prices and context window.
 *
 * @param model - Model with pricing info
 * @returns Formatted string like "In: $2.5/Cache: $1.25/Out: $10 | 128k ctx" or "Free | 4k ctx"
 */
export function formatModelPricing(model: Model | null): string {
  if (!model) return 'Unknown';

  const contextK = model.contextWindow ? Math.round(model.contextWindow / 1000) : 0;
  const contextStr = contextK > 0 ? `${contextK}k ctx` : '';

  // Check if model is free (all prices are 0 or undefined)
  const isFree =
    !model.inputPrice && !model.outputPrice && !model.cacheReadPrice && !model.cacheWritePrice;

  if (isFree) {
    if (model.downloadSize && model.downloadSize > 0) {
      const downloadGB = (model.downloadSize / (1024 * 1024 * 1024)).toFixed(1);
      return `Free " ${downloadGB}GB download${contextStr ? ` | ${contextStr}` : ''}`;
    }
    return `Free${contextStr ? ` | ${contextStr}` : ''}`;
  }

  // Build pricing string
  const parts: string[] = [];
  if (model.inputPrice !== undefined) {
    parts.push(`In: $${model.inputPrice}`);
  }
  if (model.cacheReadPrice !== undefined) {
    parts.push(`Cache: $${model.cacheReadPrice}`);
  }
  if (model.outputPrice !== undefined) {
    parts.push(`Out: $${model.outputPrice}`);
  }

  const priceStr = parts.join('/');
  return contextStr ? `${priceStr} | ${contextStr}` : priceStr;
}

// ============================================================================
// Size Formatting Utilities
// ============================================================================

/**
 * Format byte size for human-readable display.
 *
 * @param bytes - Size in bytes
 * @returns Formatted string like "2.3 GB" or "500 MB"
 */
export function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}
