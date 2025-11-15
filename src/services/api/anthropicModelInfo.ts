/**
 * Anthropic API Model Information
 * Includes pricing (per 1M tokens in USD) and context window sizes
 * Using 5-minute cache rates
 */

import type { ModelInfo } from './modelInfo';

export const ANTHROPIC_MODEL_INFO: Record<string, ModelInfo> = {
  'claude-opus-4-5': {
    inputPrice: 5,
    outputPrice: 25,
    cacheWritePrice: 6.25,
    cacheReadPrice: 0.5,
    contextWindow: 200000,
  },
  'claude-opus-4': {
    inputPrice: 15,
    outputPrice: 75,
    cacheWritePrice: 18.75,
    cacheReadPrice: 1.5,
    contextWindow: 200000,
  },
  'claude-sonnet-4-5': {
    inputPrice: 3,
    outputPrice: 15,
    cacheWritePrice: 3.75,
    cacheReadPrice: 0.3,
    contextWindow: 200000,
  },
  'claude-sonnet-4': {
    inputPrice: 3,
    outputPrice: 15,
    cacheWritePrice: 3.75,
    cacheReadPrice: 0.3,
    contextWindow: 200000,
  },
  'claude-3-7-sonnet': {
    inputPrice: 3,
    outputPrice: 15,
    cacheWritePrice: 3.75,
    cacheReadPrice: 0.3,
    contextWindow: 200000,
  },
  'claude-3-5-sonnet': {
    inputPrice: 3,
    outputPrice: 15,
    cacheWritePrice: 3.75,
    cacheReadPrice: 0.3,
    contextWindow: 200000,
  },
  'claude-haiku-4-5': {
    inputPrice: 1,
    outputPrice: 5,
    cacheWritePrice: 1.25,
    cacheReadPrice: 0.1,
    contextWindow: 200000,
  },
  'claude-3-5-haiku': {
    inputPrice: 0.8,
    outputPrice: 4,
    cacheWritePrice: 1,
    cacheReadPrice: 0.08,
    contextWindow: 200000,
  },
  'claude-opus-3': {
    inputPrice: 15,
    outputPrice: 75,
    cacheWritePrice: 18.75,
    cacheReadPrice: 1.5,
    contextWindow: 200000,
  },
  'claude-3-haiku': {
    inputPrice: 0.25,
    outputPrice: 1.25,
    cacheWritePrice: 0.3,
    cacheReadPrice: 0.03,
    contextWindow: 200000,
  },
};

/**
 * Get model information with smart matching
 * @param modelId The model ID to get information for
 * @returns ModelInfo object with pricing and context window
 */
export function getModelInfo(modelId: string): ModelInfo {
  // Try exact match first
  let modelInfo = ANTHROPIC_MODEL_INFO[modelId];

  // If no exact match, find the longest prefix match
  if (!modelInfo) {
    let longestMatch = '';
    for (const infoKey of Object.keys(ANTHROPIC_MODEL_INFO)) {
      if (modelId.startsWith(infoKey) && infoKey.length > longestMatch.length) {
        longestMatch = infoKey;
      }
    }
    if (longestMatch) {
      modelInfo = ANTHROPIC_MODEL_INFO[longestMatch];
    }
  }

  // If still no match, detect model class and use latest in that class
  if (!modelInfo) {
    const modelIdLower = modelId.toLowerCase();

    if (modelIdLower.includes('opus')) {
      // Latest Opus: claude-opus-4-1
      modelInfo = {
        inputPrice: 15,
        outputPrice: 75,
        cacheWritePrice: 18.75,
        cacheReadPrice: 1.5,
        contextWindow: 200000,
      };
    } else if (modelIdLower.includes('sonnet')) {
      // Latest Sonnet: claude-sonnet-4-5
      modelInfo = {
        inputPrice: 3,
        outputPrice: 15,
        cacheWritePrice: 3.75,
        cacheReadPrice: 0.3,
        contextWindow: 200000,
      };
    } else if (modelIdLower.includes('haiku')) {
      // Latest Haiku: claude-haiku-4-5
      modelInfo = {
        inputPrice: 1,
        outputPrice: 5,
        cacheWritePrice: 1.25,
        cacheReadPrice: 0.1,
        contextWindow: 200000,
      };
    } else {
      // Unknown model class - default to latest Sonnet (safe middle ground)
      modelInfo = {
        inputPrice: 3,
        outputPrice: 15,
        cacheWritePrice: 3.75,
        cacheReadPrice: 0.3,
        contextWindow: 200000,
      };
    }
  }

  return modelInfo;
}

/**
 * Format model information for display
 * @param info The ModelInfo object
 * @returns Formatted string like "In: $3/CacheW: $3.75/CacheR: $0.30/Out: $15 | 200k ctx"
 */
export function formatModelInfoForDisplay(info: ModelInfo): string {
  const contextK = Math.round(info.contextWindow / 1000);
  if (info.cacheWritePrice !== undefined) {
    return `In: $${info.inputPrice}/CacheW: $${info.cacheWritePrice}/CacheR: $${info.cacheReadPrice}/Out: $${info.outputPrice} | ${contextK}k ctx`;
  }
  return `In: $${info.inputPrice}/Cache: $${info.cacheReadPrice}/Out: $${info.outputPrice} | ${contextK}k ctx`;
}
