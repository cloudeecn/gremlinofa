/**
 * Shared Model Information Types
 * Used by all API providers (OpenAI, Anthropic, etc.)
 */

export interface ModelInfo {
  // Pricing (all per 1M tokens in USD)
  inputPrice: number;
  outputPrice: number;
  cacheReadPrice: number;
  cacheWritePrice?: number; // Optional, used by Anthropic

  // Model capabilities
  contextWindow: number; // Context window size in tokens
}
