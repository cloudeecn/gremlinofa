import type {
  APIDefinition,
  APIType,
  Message,
  MessageStopReason,
  Model,
  ToolUseBlock,
  ToolOptions,
} from '../../protocol/types';
import type { EncryptionCore } from '../encryption/encryptionCore';
import type { UnifiedStorage } from '../storage/unifiedStorage';
import type { ClientSideToolRegistry } from '../tools/clientSideTools';
import { AnthropicClient } from './anthropicClient';
import type { APIClient, StreamChunk, StreamResult } from './baseClient';
import { BedrockClient } from './bedrockClient';
import { getModelMetadataFor } from '../../engine/lib/api/modelMetadata';
import {
  populateFromOpenRouterModel,
  type OpenRouterModel,
} from '../../engine/lib/api/model_metadatas/openRouterModelMapper';
import { mergeExtraModels } from '../../engine/lib/api/mergeExtraModels';
import { OpenAIClient } from './openaiClient';
import { ResponsesClient } from './responsesClient';
import { GoogleClient } from './googleClient';

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
 * Shallow-clone the last user message and append the thinking nudge
 * to its text content. Returns a new array; original messages are untouched.
 */
export function applyNudgeThinking(messages: Message<unknown>[]): Message<unknown>[] {
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      lastUserIdx = i;
      break;
    }
  }
  if (lastUserIdx === -1) return messages;

  const original = messages[lastUserIdx];
  const result = messages.slice();
  result[lastUserIdx] = {
    ...original,
    content: {
      ...original.content,
      content: original.content.content + '\n\n<<WITH THINKING STEPS>>',
    },
  };
  return result;
}

/**
 * Dependency bundle for the API service and the clients it constructs.
 * `GremlinServer.init()` builds one of these from its `InitParams` and
 * passes it in so the clients receive their `storage` / `toolRegistry`
 * collaborators via constructor injection rather than module-level
 * singletons. The `encryption` field is currently unused by clients but
 * kept here so the bundle matches `BackendDeps` exactly — Phase 4 will
 * either drop it or wire it through if a client grows an encryption
 * dependency.
 */
export interface APIServiceDeps {
  storage: UnifiedStorage;
  toolRegistry: ClientSideToolRegistry;
  encryption: EncryptionCore;
}

// Main API service that routes to the correct client
export class APIService {
  private clients: Map<APIType, APIClient> = new Map();

  constructor(deps: APIServiceDeps) {
    // Phase 3: clients receive their deps via constructor injection. The
    // module-level `apiService` singleton (still exported below for the
    // frontend `extractToolUseBlocks` re-export and other Phase 4 hold-outs)
    // builds itself from the still-alive module-level singletons. Worker
    // mode goes through `GremlinServer.init()` which constructs a fresh
    // bundle from `InitParams` instead.
    this.clients.set('responses_api', new ResponsesClient(deps));
    this.clients.set('anthropic', new AnthropicClient(deps));
    this.clients.set('chatgpt', new OpenAIClient(deps));
    this.clients.set('bedrock', new BedrockClient(deps));
    this.clients.set('google', new GoogleClient(deps));
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
      // Hard-abort signal (frontend/backend split — see plan)
      signal: AbortSignal;
      // Context tidy (checkpoint tool)
      checkpointMessageId?: string;
      tidyToolNames?: Set<string>;
    }
  ): AsyncGenerator<StreamChunk, StreamResult<unknown>, unknown> {
    const client = this.getClient(apiDefinition.apiType);

    if (!client) {
      throw new Error(`Cannot get client for ${apiDefinition.apiType}`);
    }

    // Nudge thinking: append prompt to last user message (send-time only)
    if (apiDefinition.advancedSettings?.nudgeThinking) {
      messages = applyNudgeThinking(messages);
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
