/**
 * Comprehensive Model Metadata Types
 * Unified schema for model information from OpenAI, Anthropic, xAI, OpenRouter, and other providers
 */

import type { ReasoningEffort } from '../../utils/reasoningEffort';

/**
 * Reasoning mode classification for models
 */
export type ModelReasoningMode =
  | 'always' // o-series, grok-4: reasoning can't be disabled
  | 'optional' // gpt-5, grok-3-mini: user can toggle via params
  | 'none'; // Most models, gpt-5-chat, grok-4-non-reasoning

/**
 * Anthropic-specific reasoning configuration
 */
export type AnthropicReasoningMode =
  | 'budget-based' // Uses budget_tokens parameter
  | 'none'; // No reasoning support

/**
 * Comprehensive model metadata including pricing, capabilities, and provider-specific quirks
 */
export interface ModelMetadata {
  // === Identification ===
  /** Model ID (e.g., "gpt-4o", "claude-sonnet-4") */
  id: string;

  /** Human-readable display name */
  displayName?: string;

  /** Provider/owner (e.g., "openai", "anthropic", "xai") */
  provider?: string;

  /** HuggingFace model ID if applicable */
  huggingFaceId?: string;

  // === Timestamps ===
  /** Unix timestamp when model was created/released */
  createdAt?: number;

  // === Description ===
  /** Model description and capabilities */
  description?: string;

  // === Context & Limits ===
  /** Max input context window in tokens */
  contextWindow: number;

  /** Max output/completion tokens */
  maxOutputTokens?: number;

  // === Pricing (per 1M tokens in USD, or per-unit for images/requests) ===
  /** Input/prompt token price per 1M tokens */
  inputPrice: number;

  /** Output/completion token price per 1M tokens */
  outputPrice: number;

  /** Cached input read price per 1M tokens */
  cacheReadPrice?: number;

  /** Cache write price per 1M tokens (Anthropic only) */
  cacheWritePrice?: number;

  /** Per-image price in USD */
  imagePrice?: number;

  /** Audio input price per 1M tokens */
  audioPrice?: number;

  /** Per web search request price in USD */
  webSearchPrice?: number;

  /** Internal reasoning token price per 1M tokens */
  reasoningPrice?: number;

  /** Per-request base price in USD (e.g., Perplexity charges per request) */
  requestPrice?: number;

  // === Architecture ===
  /** Modality description (e.g., "text->text", "text+image->text") */
  modality?: string;

  /** Supported input modalities */
  inputModalities?: string[];

  /** Supported output modalities */
  outputModalities?: string[];

  /** Tokenizer type (e.g., "GPT", "Claude", "Llama3", "Gemini") */
  tokenizer?: string;

  // === Reasoning Capabilities ===
  /**
   * Reasoning mode classification
   * - 'always': Model always reasons, can't be disabled (o-series, grok-4)
   * - 'optional': Reasoning can be toggled via parameters (gpt-5, grok-3-mini)
   * - 'none': No reasoning support (most models)
   */
  reasoningMode?: ModelReasoningMode;

  /**
   * Supported reasoning effort levels for OpenAI/xAI models
   * Used by mapReasoningEffort() to validate/map user-specified effort
   * Examples:
   * - o-series: ['low', 'medium', 'high']
   * - gpt-5: ['minimal', 'low', 'medium', 'high']
   * - gpt-5.1/5.2: ['none', 'minimal', 'low', 'medium', 'high']
   * - grok-3-mini: ['low', 'high']
   */
  supportedReasoningEfforts?: ReasoningEffort[];

  /**
   * Anthropic-specific reasoning configuration
   * Anthropic uses a different approach with budget_tokens instead of effort levels
   */
  anthropicReasoningMode?: AnthropicReasoningMode;

  // === Feature Support ===
  /** Supports streaming responses */
  supportsStreaming?: boolean;

  /** Accepts temperature parameter (some reasoning models ignore it) */
  supportsTemperature?: boolean;

  /** Supports function/tool calling */
  supportsTools?: boolean;

  /** Supports image input (vision) */
  supportsVision?: boolean;

  /** Supports audio input */
  supportsAudio?: boolean;

  /** Supports video input */
  supportsVideo?: boolean;

  /** Built-in web search capability */
  supportsWebSearch?: boolean;

  /** Supports structured output (JSON mode/schema) */
  supportsStructuredOutput?: boolean;

  // === WebLLM Specific ===
  /** VRAM requirement in bytes (WebLLM local models) */
  vramRequired?: number;

  /** Model download size in bytes (WebLLM local models) */
  downloadSize?: number;

  /** Can run on limited devices like Android phones (WebLLM) */
  lowResourceRequired?: boolean;

  // === Moderation ===
  /** Content moderation/filtering enabled */
  isModerated?: boolean;
}

/**
 * Helper to detect reasoning mode from model ID
 * This encapsulates the quirky model-specific rules
 */
export function detectReasoningMode(modelId: string, apiType: string): ModelReasoningMode {
  if (apiType === 'webllm') return 'none';

  const modelLower = modelId.toLowerCase();

  // Always reasoning (can't disable)
  if (modelLower.match(/^o\d/)) return 'always'; // o1, o3, o4 series
  if (modelLower.startsWith('grok-4') && !modelLower.includes('non-reasoning')) return 'always';

  // Optional reasoning (can toggle)
  if (modelLower.startsWith('gpt-5') && !modelLower.includes('-chat')) return 'optional';
  if (modelLower.startsWith('grok-3-mini')) return 'optional';
  if (modelLower.startsWith('grok-4-fast')) return 'optional';

  // Explicitly no reasoning
  if (modelLower.includes('gpt-5') && modelLower.includes('-chat')) return 'none';
  if (modelLower.includes('non-reasoning')) return 'none';

  // Default: no reasoning
  return 'none';
}

/**
 * Helper to get supported reasoning efforts for a model
 */
export function getSupportedReasoningEfforts(modelId: string): ReasoningEffort[] | undefined {
  const modelLower = modelId.toLowerCase();

  // o-series: low/medium/high only
  if (modelLower.match(/^o\d/)) {
    return ['low', 'medium', 'high'];
  }

  // gpt-5.1/5.2: all levels including 'none'
  if (modelLower.startsWith('gpt-5.1') || modelLower.startsWith('gpt-5.2')) {
    return ['none', 'minimal', 'low', 'medium', 'high'];
  }

  // gpt-5: all except 'none'
  if (modelLower.startsWith('gpt-5') && !modelLower.includes('-chat')) {
    return ['minimal', 'low', 'medium', 'high'];
  }

  // grok-3-mini: only low/high
  if (modelLower.startsWith('grok-3-mini')) {
    return ['low', 'high'];
  }

  // grok-4-fast: reasoning toggle but no effort control
  if (modelLower.startsWith('grok-4-fast')) {
    return []; // Supports reasoning but not effort parameter
  }

  return undefined;
}

/**
 * Helper to detect if a model supports streaming
 * Based on quirks in openaiClient.ts supportStreaming()
 */
export function detectSupportsStreaming(modelId: string, apiType: string): boolean {
  if (apiType === 'webllm') return true;
  if (apiType === 'anthropic') return true;
  if (apiType === 'responses_api') return true;

  const modelLower = modelId.toLowerCase();

  // OpenAI Chat Completions quirks
  if (apiType === 'chatgpt') {
    // o-series except o1 don't stream
    if (modelLower.startsWith('o') && !modelLower.startsWith('o1')) {
      return false;
    }
    // gpt-5 series except nano/chat don't stream
    if (
      modelLower.startsWith('gpt-5') &&
      !(modelLower.startsWith('gpt-5-nano') || modelLower.startsWith('gpt-5-chat'))
    ) {
      return false;
    }
  }

  return true;
}

/**
 * Helper to detect if model supports temperature parameter
 * Reasoning models often ignore temperature
 */
export function detectSupportsTemperature(modelId: string): boolean {
  const modelLower = modelId.toLowerCase();

  // o-series and reasoning-focused models typically ignore temperature
  if (modelLower.match(/^o\d/)) return false;
  if (modelLower.includes('reasoning')) return false;

  return true;
}
