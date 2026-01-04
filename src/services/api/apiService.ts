import type {
  APIDefinition,
  Message,
  MessageStopReason,
  Model,
  RenderingBlockGroup,
  ToolResultBlock,
  ToolUseBlock,
} from '../../types';
import { APIType, groupAndConsolidateBlocks } from '../../types';
import { AnthropicClient } from './anthropicClient';
import type { APIClient, StreamChunk, StreamResult } from './baseClient';
import { OpenAIClient } from './openaiClient';
import { ResponsesClient } from './responsesClient';
import { WebLLMClient } from './webllmClient';

// Re-export ModelInfo for external use
export type { ModelInfo } from './modelInfo';

// Main API service that routes to the correct client
class APIService {
  private clients: Map<APIType, APIClient> = new Map();

  constructor() {
    // Initialize clients
    this.clients.set(APIType.RESPONSES_API, new ResponsesClient());
    this.clients.set(APIType.ANTHROPIC, new AnthropicClient());
    this.clients.set(APIType.CHATGPT, new OpenAIClient());
    this.clients.set(APIType.WEBLLM, new WebLLMClient());
  }

  // Get the appropriate client for an API type
  private getClient(apiType: APIType): APIClient | null {
    return this.clients.get(apiType) || null;
  }

  // Discover models for a given API definition
  async discoverModels(apiDefinition: APIDefinition): Promise<Model[]> {
    const client = this.getClient(apiDefinition.apiType);

    if (!client) {
      throw new Error(`Cannot get client for ${apiDefinition.apiType}`);
    }

    return client.discoverModels(apiDefinition);
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
      enableReasoning: boolean;
      reasoningBudgetTokens: number;
      systemPrompt?: string;
      preFillResponse?: string;
      webSearchEnabled?: boolean;
      enabledTools?: string[];
    }
  ): AsyncGenerator<StreamChunk, StreamResult<unknown>, unknown> {
    const client = this.getClient(apiDefinition.apiType);

    if (!client) {
      throw new Error(`Cannot get client for ${apiDefinition.apiType}`);
    }

    // Use the real client
    return yield* client.sendMessageStream(messages, modelId, apiDefinition, options);
  }

  // Calculate cost for a message
  calculateCost(
    apiType: APIType,
    modelId: string,
    inputTokens: number,
    outputTokens: number,
    reasoningTokens?: number,
    cacheCreationTokens?: number,
    cacheReadTokens?: number
  ): number {
    const client = this.getClient(apiType);

    if (!client) {
      throw new Error(`Cannot get client for ${apiType}`);
    }

    return client.calculateCost(
      modelId,
      inputTokens,
      outputTokens,
      reasoningTokens,
      cacheCreationTokens,
      cacheReadTokens
    );
  }

  // Get model information (pricing + capabilities)
  getModelInfo(apiType: APIType, modelId: string) {
    const client = this.getClient(apiType);

    if (!client) {
      throw new Error(`Cannot get client for ${apiType}`);
    }

    return client.getModelInfo(modelId);
  }

  // Format model info for UI display
  formatModelInfoForDisplay(apiType: APIType, modelId: string): string {
    const client = this.getClient(apiType);

    if (!client) {
      throw new Error(`Cannot get client for ${apiType}`);
    }

    const info = client.getModelInfo(modelId);
    return client.formatModelInfoForDisplay(info);
  }

  // Check if model supports reasoning
  isReasoningModel(apiType: APIType, modelId: string): boolean {
    const client = this.getClient(apiType);

    if (!client) {
      return false;
    }

    return client.isReasoningModel(modelId);
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
    if (apiType === APIType.ANTHROPIC) {
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
   * Migrate old messages without renderingContent to the new format.
   * Converts provider-specific fullContent to generic RenderingBlockGroup[].
   * ONLY used during message migration - streaming uses StreamingContentAssembler.
   *
   * @param apiType - The API type (modelFamily) that created the content
   * @param fullContent - Provider-specific content blocks
   * @param stopReason - Why the message ended (from API)
   * @returns Grouped rendering blocks and normalized stop reason
   */
  migrateMessageRendering(
    apiType: APIType | undefined,
    fullContent: unknown,
    stopReason: string | null
  ): {
    renderingContent: RenderingBlockGroup[];
    stopReason: MessageStopReason;
  } {
    // If no apiType, fall back to simple text-only rendering
    if (!apiType) {
      const textContent =
        typeof fullContent === 'string'
          ? fullContent.trim()
          : Array.isArray(fullContent)
            ? fullContent
                .filter(
                  (b: unknown): b is { type: string; text: string } =>
                    typeof b === 'object' && b !== null && 'text' in b && typeof b.text === 'string'
                )
                .map(b => b.text)
                .join('')
            : '';

      return {
        renderingContent: textContent
          ? groupAndConsolidateBlocks([{ type: 'text', text: textContent }])
          : [],
        stopReason: stopReason || 'end_turn',
      };
    }

    const client = this.getClient(apiType);

    if (!client) {
      // Fallback for unknown API types
      return {
        renderingContent: [],
        stopReason: stopReason || 'end_turn',
      };
    }

    return client.migrateMessageRendering(fullContent, stopReason);
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

  /**
   * Build tool result messages in provider's expected format.
   * Routes to the appropriate client based on API type.
   */
  buildToolResultMessages(
    apiType: APIType,
    assistantContent: unknown,
    toolResults: ToolResultBlock[],
    textContent: string
  ): Message<unknown>[] {
    const client = this.getClient(apiType);
    if (!client) {
      return [];
    }
    return client.buildToolResultMessages(assistantContent, toolResults, textContent);
  }
}

export const apiService = new APIService();
