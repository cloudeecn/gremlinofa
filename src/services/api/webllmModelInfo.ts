/**
 * WebLLM Model Information
 * Local models running via WebGPU - all free (no API costs)
 *
 * Uses WebLLM's prebuiltAppConfig directly for accurate model metadata.
 * This ensures VRAM requirements and sizes stay in sync with WebLLM updates.
 */

import { prebuiltAppConfig } from '@mlc-ai/web-llm';
import type { ModelInfo } from './modelInfo';

export interface WebLLMModelInfo extends ModelInfo {
  /** Display name for the model */
  displayName: string;
  /** Download size in bytes */
  downloadSize: number;
  /** VRAM requirement in bytes */
  vramRequired: number;
  /** Whether the model can run on limited devices (e.g. Android phone) */
  lowResourceRequired: boolean;
}

/**
 * Build a lookup map from model_id to model record for fast access.
 */
const modelMap = new Map(prebuiltAppConfig.model_list.map(m => [m.model_id, m]));

/**
 * Get model information from WebLLM's prebuilt config.
 * @param modelId The exact model ID to look up
 * @returns WebLLMModelInfo object with pricing, context window, and size info
 * @throws Error if model is not found (should never happen since we only show models from the same list)
 */
export function getModelInfo(modelId: string): WebLLMModelInfo {
  const record = modelMap.get(modelId);
  if (!record) {
    throw new Error(`Model not found in WebLLM config: ${modelId}`);
  }

  return {
    displayName: modelId,
    inputPrice: 0,
    outputPrice: 0,
    cacheReadPrice: 0,
    // Context window from overrides if available, otherwise default to 4096
    contextWindow: record.overrides?.context_window_size ?? 4096,
    // VRAM in bytes (config has it in MB)
    vramRequired: (record.vram_required_MB ?? 0) * 1024 * 1024,
    // Download size from buffer_size_required_bytes
    downloadSize: record.buffer_size_required_bytes ?? 0,
    // Whether the model can run on limited devices
    lowResourceRequired: record.low_resource_required ?? false,
  };
}

/**
 * Format model information for display.
 * Shows "Free • <size> download | <context>k ctx"
 * @param info The WebLLMModelInfo object
 * @returns Formatted string for UI display
 */
export function formatModelInfoForDisplay(info: WebLLMModelInfo): string {
  const contextK = Math.round(info.contextWindow / 1000);
  if (info.downloadSize > 0) {
    const downloadGB = (info.downloadSize / (1024 * 1024 * 1024)).toFixed(1);
    return `Free • ${downloadGB}GB download | ${contextK}k ctx`;
  }
  // Download size unknown
  return `Free • unknown download size | ${contextK}k ctx`;
}

/**
 * Format file size for human-readable display.
 * @param bytes Size in bytes
 * @returns Formatted string like "2.3 GB" or "500 MB"
 */
export function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

/**
 * Check if a model supports reasoning (thinking) capabilities.
 * Currently, no WebLLM models have built-in reasoning support.
 * @param _modelId The model ID to check
 * @returns False (no WebLLM models currently support reasoning)
 */
export function isReasoningModel(_modelId: string): boolean {
  // WebLLM models don't have native reasoning support like o1/Claude
  return false;
}
