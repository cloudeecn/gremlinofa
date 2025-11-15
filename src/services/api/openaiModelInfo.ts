/**
 * OpenAI API Model Information
 * Includes pricing (per 1M tokens in USD) and context window sizes
 */

import type { ModelInfo } from './modelInfo';

export const OPENAI_MODEL_INFO: Record<string, ModelInfo> = {
  // GPT-5 series
  'gpt-5': {
    inputPrice: 1.25,
    outputPrice: 10.0,
    cacheReadPrice: 0.125,
    contextWindow: 128000,
  },
  'gpt-5-mini': {
    inputPrice: 0.25,
    outputPrice: 2.0,
    cacheReadPrice: 0.025,
    contextWindow: 128000,
  },
  'gpt-5-nano': {
    inputPrice: 0.05,
    outputPrice: 0.4,
    cacheReadPrice: 0.005,
    contextWindow: 128000,
  },
  'gpt-5-chat-latest': {
    inputPrice: 1.25,
    outputPrice: 10.0,
    cacheReadPrice: 0.125,
    contextWindow: 128000,
  },
  'gpt-5-codex': {
    inputPrice: 1.25,
    outputPrice: 10.0,
    cacheReadPrice: 0.125,
    contextWindow: 128000,
  },
  'gpt-5-pro': {
    inputPrice: 15.0,
    outputPrice: 120.0,
    cacheReadPrice: 15.0,
    contextWindow: 128000,
  },
  'gpt-5-search-api': {
    inputPrice: 1.25,
    outputPrice: 10.0,
    cacheReadPrice: 0.125,
    contextWindow: 128000,
  },

  // GPT-4.1 series
  'gpt-4.1': {
    inputPrice: 2.0,
    outputPrice: 8.0,
    cacheReadPrice: 0.5,
    contextWindow: 128000,
  },
  'gpt-4.1-mini': {
    inputPrice: 0.4,
    outputPrice: 1.6,
    cacheReadPrice: 0.1,
    contextWindow: 128000,
  },
  'gpt-4.1-nano': {
    inputPrice: 0.1,
    outputPrice: 0.4,
    cacheReadPrice: 0.025,
    contextWindow: 128000,
  },

  // GPT-4o series (most capable)
  'gpt-4o': {
    inputPrice: 2.5,
    outputPrice: 10.0,
    cacheReadPrice: 1.25,
    contextWindow: 128000,
  },
  'gpt-4o-2024-05-13': {
    inputPrice: 5.0,
    outputPrice: 15.0,
    cacheReadPrice: 5.0,
    contextWindow: 128000,
  },
  'gpt-4o-mini': {
    inputPrice: 0.15,
    outputPrice: 0.6,
    cacheReadPrice: 0.075,
    contextWindow: 128000,
  },

  // Realtime models
  'gpt-realtime': {
    inputPrice: 4.0,
    outputPrice: 16.0,
    cacheReadPrice: 0.4,
    contextWindow: 128000,
  },
  'gpt-realtime-mini': {
    inputPrice: 0.6,
    outputPrice: 2.4,
    cacheReadPrice: 0.06,
    contextWindow: 128000,
  },
  'gpt-4o-realtime-preview': {
    inputPrice: 5.0,
    outputPrice: 20.0,
    cacheReadPrice: 2.5,
    contextWindow: 128000,
  },
  'gpt-4o-mini-realtime-preview': {
    inputPrice: 0.6,
    outputPrice: 2.4,
    cacheReadPrice: 0.3,
    contextWindow: 128000,
  },

  // Audio models
  'gpt-audio': {
    inputPrice: 2.5,
    outputPrice: 10.0,
    cacheReadPrice: 2.5,
    contextWindow: 128000,
  },
  'gpt-audio-mini': {
    inputPrice: 0.6,
    outputPrice: 2.4,
    cacheReadPrice: 0.6,
    contextWindow: 128000,
  },
  'gpt-4o-audio-preview': {
    inputPrice: 2.5,
    outputPrice: 10.0,
    cacheReadPrice: 2.5,
    contextWindow: 128000,
  },
  'gpt-4o-mini-audio-preview': {
    inputPrice: 0.15,
    outputPrice: 0.6,
    cacheReadPrice: 0.15,
    contextWindow: 128000,
  },

  // o-series reasoning models (o1, o3, o4)
  o1: {
    inputPrice: 15.0,
    outputPrice: 60.0,
    cacheReadPrice: 7.5,
    contextWindow: 200000,
  },
  'o1-pro': {
    inputPrice: 150.0,
    outputPrice: 600.0,
    cacheReadPrice: 150.0,
    contextWindow: 200000,
  },
  'o1-mini': {
    inputPrice: 1.1,
    outputPrice: 4.4,
    cacheReadPrice: 0.55,
    contextWindow: 128000,
  },
  o3: {
    inputPrice: 2.0,
    outputPrice: 8.0,
    cacheReadPrice: 0.5,
    contextWindow: 128000,
  },
  'o3-pro': {
    inputPrice: 20.0,
    outputPrice: 80.0,
    cacheReadPrice: 20.0,
    contextWindow: 128000,
  },
  'o3-deep-research': {
    inputPrice: 10.0,
    outputPrice: 40.0,
    cacheReadPrice: 2.5,
    contextWindow: 128000,
  },
  'o3-mini': {
    inputPrice: 1.1,
    outputPrice: 4.4,
    cacheReadPrice: 0.55,
    contextWindow: 128000,
  },
  'o4-mini': {
    inputPrice: 1.1,
    outputPrice: 4.4,
    cacheReadPrice: 0.275,
    contextWindow: 128000,
  },
  'o4-mini-deep-research': {
    inputPrice: 2.0,
    outputPrice: 8.0,
    cacheReadPrice: 0.5,
    contextWindow: 128000,
  },

  // Search models
  'gpt-4o-search-preview': {
    inputPrice: 2.5,
    outputPrice: 10.0,
    cacheReadPrice: 2.5,
    contextWindow: 128000,
  },
  'gpt-4o-mini-search-preview': {
    inputPrice: 0.15,
    outputPrice: 0.6,
    cacheReadPrice: 0.15,
    contextWindow: 128000,
  },

  // Specialized models
  'codex-mini-latest': {
    inputPrice: 1.5,
    outputPrice: 6.0,
    cacheReadPrice: 0.375,
    contextWindow: 128000,
  },
  'computer-use-preview': {
    inputPrice: 3.0,
    outputPrice: 12.0,
    cacheReadPrice: 3.0,
    contextWindow: 128000,
  },

  // xAI Grok models (OpenAI-compatible)
  'grok-4': {
    inputPrice: 3.0,
    outputPrice: 15.0,
    cacheReadPrice: 3.0,
    contextWindow: 128000,
  },
  'grok-3': {
    inputPrice: 3.0,
    outputPrice: 15.0,
    cacheReadPrice: 3.0,
    contextWindow: 128000,
  },
  'grok-3-mini': {
    inputPrice: 0.3,
    outputPrice: 0.5,
    cacheReadPrice: 0.3,
    contextWindow: 128000,
  },
  'grok-4-fast-reasoning': {
    inputPrice: 0.2,
    outputPrice: 0.5,
    cacheReadPrice: 0.2,
    contextWindow: 128000,
  },
  'grok-4-fast-non-reasoning': {
    inputPrice: 0.2,
    outputPrice: 0.5,
    cacheReadPrice: 0.2,
    contextWindow: 128000,
  },
  'grok-code-fast-1': {
    inputPrice: 0.2,
    outputPrice: 1.5,
    cacheReadPrice: 0.2,
    contextWindow: 128000,
  },
};

/**
 * Get model information with smart matching
 * @param modelId The model ID to get information for
 * @returns ModelInfo object with pricing and context window
 */
export function getModelInfo(modelId: string): ModelInfo {
  // Try exact match first
  let modelInfo = OPENAI_MODEL_INFO[modelId];

  // If no exact match, find the longest prefix match
  if (!modelInfo) {
    let longestMatch = '';
    for (const infoKey of Object.keys(OPENAI_MODEL_INFO)) {
      if (modelId.startsWith(infoKey) && infoKey.length > longestMatch.length) {
        longestMatch = infoKey;
      }
    }
    if (longestMatch) {
      modelInfo = OPENAI_MODEL_INFO[longestMatch];
    }
  }

  // If still no match, detect model series and use latest in that series
  if (!modelInfo) {
    const modelIdLower = modelId.toLowerCase();

    // GPT-5 series
    if (modelIdLower.startsWith('gpt-5')) {
      modelInfo = {
        inputPrice: 1.25,
        outputPrice: 10.0,
        cacheReadPrice: 0.125,
        contextWindow: 128000,
      };
    }
    // o-series reasoning models
    else if (modelIdLower.match(/^o\d/)) {
      // o1 non-mini has 200k context
      if (modelIdLower.startsWith('o1') && !modelIdLower.includes('mini')) {
        modelInfo = {
          inputPrice: 15.0,
          outputPrice: 60.0,
          cacheReadPrice: 7.5,
          contextWindow: 200000,
        };
      } else {
        // Default to o1 pricing with 128k context
        modelInfo = {
          inputPrice: 15.0,
          outputPrice: 60.0,
          cacheReadPrice: 7.5,
          contextWindow: 128000,
        };
      }
    }
    // GPT-4o series
    else if (modelIdLower.includes('gpt-4o-mini')) {
      modelInfo = {
        inputPrice: 0.15,
        outputPrice: 0.6,
        cacheReadPrice: 0.075,
        contextWindow: 128000,
      };
    } else if (modelIdLower.includes('gpt-4o')) {
      modelInfo = {
        inputPrice: 2.5,
        outputPrice: 10.0,
        cacheReadPrice: 1.25,
        contextWindow: 128000,
      };
    }
    // GPT-4.1 series
    else if (modelIdLower.includes('gpt-4.1')) {
      modelInfo = {
        inputPrice: 2.0,
        outputPrice: 8.0,
        cacheReadPrice: 0.5,
        contextWindow: 128000,
      };
    }
    // Unknown model - default to GPT-4o pricing (safe middle ground)
    else {
      modelInfo = {
        inputPrice: 2.5,
        outputPrice: 10.0,
        cacheReadPrice: 1.25,
        contextWindow: 128000,
      };
    }
  }

  return modelInfo;
}

/**
 * Format model information for display
 * @param info The ModelInfo object
 * @returns Formatted string like "In: $2.5/Cache: $1.25/Out: $10 | 128k ctx"
 */
export function formatModelInfoForDisplay(info: ModelInfo): string {
  const contextK = Math.round(info.contextWindow / 1000);
  return `In: $${info.inputPrice}/Cache: $${info.cacheReadPrice}/Out: $${info.outputPrice} | ${contextK}k ctx`;
}

/**
 * Check if a model is a reasoning model (o-series or GPT-5)
 * @param modelId The model ID to check
 * @returns True if it's an o-series model (o1, o3, o4, etc.) or GPT-5
 */
export function isReasoningModel(modelId: string): boolean {
  const modelIdLower = modelId.toLowerCase();
  return /^o\d/.test(modelId) || modelIdLower.startsWith('gpt-5');
}
