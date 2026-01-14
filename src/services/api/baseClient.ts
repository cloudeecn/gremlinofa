import type {
  APIDefinition,
  Message,
  MessageStopReason,
  Model,
  RenderingBlockGroup,
  ToolResultBlock,
  ToolUseBlock,
} from '../../types';
import type { ModelInfo } from './modelInfo';

// Common interface for all API clients
export interface APIClient {
  // Discover available models from the provider
  discoverModels(apiDefinition: APIDefinition): Promise<Model[]>;

  shouldPrependPrefill(apiDefinition: APIDefinition): boolean;

  // Send a message and get a streaming response
  sendMessageStream(
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
    }
  ): AsyncGenerator<StreamChunk, StreamResult<unknown>, unknown>;

  // Calculate cost for a given model and token usage
  calculateCost(
    modelId: string,
    inputTokens: number,
    outputTokens: number,
    reasoningTokens?: number,
    cacheCreationTokens?: number,
    cacheReadTokens?: number
  ): number;

  // Get model information (pricing + capabilities)
  getModelInfo(modelId: string): ModelInfo;

  // Format model info for UI display
  formatModelInfoForDisplay(info: ModelInfo): string;

  // Check if model supports reasoning
  isReasoningModel(modelId: string): boolean;

  /**
   * Migrate old messages without renderingContent to the new format.
   * Converts provider-specific fullContent to generic RenderingBlockGroup[].
   * ONLY used during message migration - streaming uses StreamingContentAssembler.
   */
  migrateMessageRendering(
    fullContent: unknown,
    stopReason: string | null
  ): {
    renderingContent: RenderingBlockGroup[];
    stopReason: MessageStopReason;
  };

  /**
   * Extract tool_use blocks from provider-specific fullContent.
   * Returns array of ToolUseBlock for client-side tool execution.
   */
  extractToolUseBlocks(fullContent: unknown): ToolUseBlock[];

  /**
   * Build tool result message in provider's expected format.
   *
   * @param toolResults - Results from executing client-side tools
   * @returns Message containing tool results for continuation
   */
  buildToolResultMessage(toolResults: ToolResultBlock[]): Message<unknown>;
}

// Stream chunk types
export type StreamChunk =
  | { type: 'event'; content: string }
  | { type: 'content'; content: string }
  | { type: 'content.start' }
  | { type: 'content.end' }
  | { type: 'thinking'; content: string }
  | { type: 'thinking.start' }
  | { type: 'thinking.end' }
  | { type: 'web_search.start'; id: string } // Emitted immediately when tool use starts
  | { type: 'web_search'; id: string; query: string } // Emitted when query is known
  | { type: 'web_search.result'; tool_use_id: string; title?: string; url?: string }
  | { type: 'web_fetch.start'; id: string } // Emitted immediately when tool use starts
  | { type: 'web_fetch'; id: string; url: string } // Emitted when URL is known
  | { type: 'web_fetch.result'; tool_use_id: string; url: string; title?: string }
  | { type: 'citation'; url: string; title?: string; citedText?: string } // Citation for current text block
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> } // Client-side tool invocation
  | {
      type: 'token_usage';
      inputTokens?: number;
      outputTokens?: number;
      reasoningTokens?: number;
      cacheCreationTokens?: number;
      cacheReadTokens?: number;
    };

// Final result after streaming completes
export interface StreamResult<T> {
  textContent: string; // Pure text for display & cross-model compatibility
  thinkingContent?: string; // Pure text for display (used during streaming only)
  fullContent: T; // Provider-specific blocks (Anthropic: ContentBlock[], OpenAI: [{type:'text',text:string}])
  stopReason?: string; // Why the response ended (end_turn, max_tokens, etc.)
  error?: {
    message: string;
    status?: number;
    stack?: string;
  };
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
}
