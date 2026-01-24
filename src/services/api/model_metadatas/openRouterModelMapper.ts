// ============================================================================
// OpenRouter Model Mapping
// ============================================================================

import type { Model, ReasoningEffort } from '../../../types';

/**
 * OpenRouter model response structure.
 * Only includes fields we use for mapping.
 */
export interface OpenRouterModel {
  id: string;
  name?: string;
  description?: string;
  context_length?: number;
  pricing?: {
    prompt?: string; // per-token price as string
    completion?: string;
    request?: string;
    image?: string;
    web_search?: string;
    internal_reasoning?: string;
    input_cache_read?: string;
    input_cache_write?: string;
  };
  top_provider?: {
    context_length?: number;
    max_completion_tokens?: number;
    is_moderated?: boolean;
  };
  supported_parameters?: string[];
}

/**
 * Convert OpenRouter per-token price string to per-1M-token number.
 * OpenRouter prices are per-token (e.g., "0.000002"), we store per-1M tokens.
 */
function convertOpenRouterPrice(priceStr: string | undefined): number | undefined {
  if (!priceStr) return undefined;
  const price = parseFloat(priceStr);
  if (isNaN(price) || price === 0) return price === 0 ? 0 : undefined;
  return price * 1_000_000;
}

/**
 * Infer reasoning capabilities from supported_parameters.
 */
function inferReasoningFromParams(
  params: string[] | undefined
): { reasoningMode?: Model['reasoningMode']; supportedEfforts?: ReasoningEffort[] } | undefined {
  if (!params) return undefined;

  const hasReasoning = params.includes('reasoning') || params.includes('include_reasoning');
  if (!hasReasoning) return undefined;

  // Model supports reasoning - mark as optional since it can be toggled
  return {
    reasoningMode: 'optional',
    supportedEfforts: ['none', 'minimal', 'low', 'medium', 'high'],
  };
}

/**
 * Populate Model fields from OpenRouter API response.
 * Mutates model in-place. API data overrides hardcoded values.
 *
 * @param model - Model object to populate (from getModelMetadataFor)
 * @param rawModel - Raw model data from OpenRouter API
 */
export function populateFromOpenRouterModel(model: Model, rawModel: OpenRouterModel): void {
  // Check if this looks like an OpenRouter response (has OpenRouter-specific fields)
  if (!rawModel.context_length && !rawModel.pricing && !rawModel.top_provider) {
    return; // Standard OpenAI response, nothing to populate
  }

  // Name
  if (rawModel.name) {
    model.name = rawModel.name;
  }

  // Context window
  if (rawModel.context_length) {
    model.contextWindow = rawModel.context_length;
  }

  // Max output tokens
  if (rawModel.top_provider?.max_completion_tokens) {
    model.maxOutputTokens = rawModel.top_provider.max_completion_tokens;
  }

  // Pricing
  if (rawModel.pricing) {
    const p = rawModel.pricing;

    const inputPrice = convertOpenRouterPrice(p.prompt);
    if (inputPrice !== undefined) model.inputPrice = inputPrice;

    const outputPrice = convertOpenRouterPrice(p.completion);
    if (outputPrice !== undefined) model.outputPrice = outputPrice;

    const cacheReadPrice = convertOpenRouterPrice(p.input_cache_read);
    if (cacheReadPrice !== undefined) model.cacheReadPrice = cacheReadPrice;

    const cacheWritePrice = convertOpenRouterPrice(p.input_cache_write);
    if (cacheWritePrice !== undefined) model.cacheWritePrice = cacheWritePrice;

    const reasoningPrice = convertOpenRouterPrice(p.internal_reasoning);
    if (reasoningPrice !== undefined) model.reasoningPrice = reasoningPrice;

    // Web search is per-request, not per-token
    if (p.web_search) {
      const webPrice = parseFloat(p.web_search);
      if (!isNaN(webPrice) && webPrice > 0) model.webSearchPrice = webPrice;
    }

    // Request price is per-request
    if (p.request) {
      const reqPrice = parseFloat(p.request);
      if (!isNaN(reqPrice) && reqPrice > 0) model.requestPrice = reqPrice;
    }
  }

  // Infer capabilities from supported_parameters
  if (rawModel.supported_parameters) {
    model.supportsTemperature = rawModel.supported_parameters.includes('temperature');
    model.supportsTools =
      rawModel.supported_parameters.includes('tools') ||
      rawModel.supported_parameters.includes('tool_choice');

    // Reasoning inference (only if not already set by hardcoded knowledge)
    if (!model.reasoningMode) {
      const reasoning = inferReasoningFromParams(rawModel.supported_parameters);
      if (reasoning) {
        model.reasoningMode = reasoning.reasoningMode;
        if (reasoning.supportedEfforts) {
          model.supportedReasoningEfforts = reasoning.supportedEfforts;
        }
      }
    }
  }

  // If we populated pricing from API and matchedMode was 'default', upgrade to 'fuzz'
  // This makes cost calculations reliable since we have API-provided pricing
  if (
    model.matchedMode === 'default' &&
    (model.inputPrice !== undefined || model.outputPrice !== undefined)
  ) {
    model.matchedMode = 'fuzz';
  }
}
