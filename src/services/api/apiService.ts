import type {
  APIDefinition,
  APIType,
  Message,
  MessageStopReason,
  Model,
  ToolUseBlock,
  ToolOptions,
} from '../../types';
import { AnthropicClient } from './anthropicClient';
import type { APIClient, StreamChunk, StreamResult } from './baseClient';
import { BedrockClient } from './bedrockClient';
import { getModelMetadataFor } from './modelMetadata';
import {
  populateFromOpenRouterModel,
  type OpenRouterModel,
} from './model_metadatas/openRouterModelMapper';
import { OpenAIClient } from './openaiClient';
import { ResponsesClient } from './responsesClient';
import { GoogleClient } from './googleClient';
import { WebLLMClient } from './webllmClient';

/**
 * Fetch models from a custom endpoint using plain fetch (no auth).
 * Auto-detects response format:
 * - OpenAI-compatible: { "data": [{ "id": "...", ... }] }
 * - Plain object array: [{ "id": "...", ... }]
 * - String array: ["model-1", "model-2"]
 */
async function fetchModelsFromEndpoint(apiDefinition: APIDefinition): Promise<Model[]> {
  const endpoint = apiDefinition.modelsEndpoint!;
  console.debug(`[APIService] Fetching models from custom endpoint: ${endpoint}`);

  const response = await fetch(endpoint);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch models from ${endpoint}: ${response.status} ${response.statusText}`
    );
  }

  const json = await response.json();

  // Auto-detect format and extract model array
  let rawModels: unknown[];
  if (json && typeof json === 'object' && 'data' in json && Array.isArray(json.data)) {
    // OpenAI-compatible format: { data: [...] }
    rawModels = json.data;
  } else if (Array.isArray(json)) {
    // Plain array format
    rawModels = json;
  } else {
    throw new Error(`Unexpected response format from ${endpoint}`);
  }

  // Convert to Model[]
  const models: Model[] = rawModels.map((item: unknown) => {
    // Handle string array format
    if (typeof item === 'string') {
      return getModelMetadataFor(apiDefinition, item);
    }

    // Handle object format
    if (typeof item === 'object' && item !== null) {
      const obj = item as Record<string, unknown>;
      const modelId = (obj.id as string) || (obj.name as string) || String(obj);

      // Get base metadata from hardcoded knowledge
      const model = getModelMetadataFor(apiDefinition, modelId);

      // Overlay API-provided metadata (OpenRouter format support)
      populateFromOpenRouterModel(model, obj as unknown as OpenRouterModel);

      // Use name from API if provided
      if (obj.name && typeof obj.name === 'string') {
        model.name = obj.name;
      } else if (obj.display_name && typeof obj.display_name === 'string') {
        model.name = obj.display_name;
      }

      return model;
    }

    // Fallback for unexpected item types
    return getModelMetadataFor(apiDefinition, String(item));
  });

  console.debug(`[APIService] Fetched ${models.length} models from custom endpoint`);
  return models;
}

/**
 * Merge extraModelIds from an API definition into a discovered model list.
 * Extra models already present in discoveredModels are skipped (deduplication).
 * Each extra model ID is resolved via getModelMetadataFor for pricing/metadata enrichment.
 */
export function mergeExtraModels(discoveredModels: Model[], apiDefinition: APIDefinition): Model[] {
  const extraIds = apiDefinition.extraModelIds;
  if (!extraIds || extraIds.length === 0) return discoveredModels;

  const existingIds = new Set(discoveredModels.map(m => m.id));
  const extraModels: Model[] = [];

  for (const modelId of extraIds) {
    const trimmed = modelId.trim();
    if (!trimmed || existingIds.has(trimmed)) continue;
    existingIds.add(trimmed);
    extraModels.push(getModelMetadataFor(apiDefinition, trimmed));
  }

  return extraModels.length > 0 ? [...discoveredModels, ...extraModels] : discoveredModels;
}

// Main API service that routes to the correct client
class APIService {
  private clients: Map<APIType, APIClient> = new Map();

  constructor() {
    // Initialize clients
    this.clients.set('responses_api', new ResponsesClient());
    this.clients.set('anthropic', new AnthropicClient());
    this.clients.set('chatgpt', new OpenAIClient());
    this.clients.set('webllm', new WebLLMClient());
    this.clients.set('bedrock', new BedrockClient());
    this.clients.set('google', new GoogleClient());
  }

  // Get the appropriate client for an API type
  private getClient(apiType: APIType): APIClient | null {
    return this.clients.get(apiType) || null;
  }

  // Discover models for a given API definition
  async discoverModels(apiDefinition: APIDefinition): Promise<Model[]> {
    // Provider doesn't support model listing — return only extra models
    if (apiDefinition.modelsEndpointDisabled) {
      return mergeExtraModels([], apiDefinition);
    }

    let models: Model[];

    // Use custom models endpoint if configured
    if (apiDefinition.modelsEndpoint) {
      models = await fetchModelsFromEndpoint(apiDefinition);
    } else {
      const client = this.getClient(apiDefinition.apiType);

      if (!client) {
        throw new Error(`Cannot get client for ${apiDefinition.apiType}`);
      }

      models = await client.discoverModels(apiDefinition);
    }

    return mergeExtraModels(models, apiDefinition);
  }

  shouldPrependPrefill(apiDefinition: APIDefinition): boolean {
    const client = this.getClient(apiDefinition.apiType);

    if (!client) {
      return false;
    }

    return client.shouldPrependPrefill(apiDefinition);
  }

  // Send a message with streaming
  async *sendMessageStream(
    messages: Message<unknown>[],
    modelId: string,
    apiDefinition: APIDefinition,
    options: {
      temperature?: number;
      maxTokens: number;
      // Anthropic-specific reasoning
      enableReasoning: boolean;
      reasoningBudgetTokens: number;
      thinkingKeepTurns?: number; // undefined = model default, -1 = all, 0+ = thinking_turns
      // OpenAI/Responses-specific reasoning
      reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
      reasoningSummary?: 'auto' | 'concise' | 'detailed';
      // Common options
      systemPrompt?: string;
      preFillResponse?: string;
      webSearchEnabled?: boolean;
      enabledTools?: string[];
      toolOptions?: Record<string, ToolOptions>;
      disableStream?: boolean;
      extendedContext?: boolean;
      // Context tidy (checkpoint tool)
      checkpointMessageId?: string;
      tidyToolNames?: Set<string>;
    }
  ): AsyncGenerator<StreamChunk, StreamResult<unknown>, unknown> {
    const client = this.getClient(apiDefinition.apiType);

    if (!client) {
      throw new Error(`Cannot get client for ${apiDefinition.apiType}`);
    }

    // Use the real client
    return yield* client.sendMessageStream(messages, modelId, apiDefinition, options);
  }

  /**
   * Map provider-specific stop reason to MessageStopReason.
   * Used when saving messages after streaming completes.
   *
   * @param apiType - The API type (modelFamily)
   * @param stopReason - Raw stop reason from API
   * @returns Normalized stop reason
   */
  mapStopReason(apiType: APIType | undefined, stopReason: string | null): MessageStopReason {
    if (!stopReason) return 'end_turn';

    // Provider-specific mappings
    if (apiType === 'google') {
      switch (stopReason) {
        case 'STOP':
        case 'tool_use':
          return 'end_turn';
        case 'MAX_TOKENS':
          return 'max_tokens';
        default:
          return stopReason;
      }
    }

    if (apiType === 'anthropic') {
      // Anthropic uses: end_turn, max_tokens, stop_sequence, tool_use
      switch (stopReason) {
        case 'end_turn':
        case 'max_tokens':
        case 'stop_sequence':
          return stopReason;
        case 'tool_use':
          return 'end_turn';
        default:
          return stopReason;
      }
    }

    // OpenAI/Responses API uses: stop, length, content_filter, tool_calls
    switch (stopReason) {
      case 'stop':
        return 'end_turn';
      case 'length':
        return 'max_tokens';
      case 'content_filter':
        return stopReason;
      case 'tool_calls':
        return 'end_turn';
      default:
        return stopReason;
    }
  }

  /**
   * Extract tool_use blocks from provider-specific fullContent.
   * Routes to the appropriate client based on API type.
   */
  extractToolUseBlocks(apiType: APIType, fullContent: unknown): ToolUseBlock[] {
    const client = this.getClient(apiType);
    if (!client) {
      return [];
    }
    return client.extractToolUseBlocks(fullContent);
  }
}

export const apiService = new APIService();
