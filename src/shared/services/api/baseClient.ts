import type {
  APIDefinition,
  Message,
  Model,
  RenderingBlockGroup,
  TokenTotals,
  ToolUseBlock,
} from '../../protocol/types';

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
      // Client-side thinking-block pruning. When defined and >= 0, the client
      // strips thinking blocks older than the N-th-from-last user text msg
      // before sending. Distinct from `thinkingKeepTurns` (server-side context
      // edit). Driven by the project's "Prune thinking blocks before API call"
      // checkbox and overridable per minion call.
      pruneThinkingKeepTurns?: number;
      // OpenAI/Responses-specific reasoning
      reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
      reasoningSummary?: 'auto' | 'concise' | 'detailed';
      // OpenAI response-length control (Responses + Chat Completions only)
      verbosity?: 'low' | 'medium' | 'high';
      // Common options
      systemPrompt?: string;
      preFillResponse?: string;
      webSearchEnabled?: boolean;
      // Hard-abort signal (frontend/backend split — see plan)
      signal: AbortSignal;
      // Context tidy (checkpoint tool)
      checkpointMessageId?: string;
      tidyToolNames?: Set<string>;
      // Claude Agent SDK — chat-level session state (server-mode only)
      claudeAgentSessionId?: string;
      claudeAgentResumeAt?: string;
    }
  ): AsyncGenerator<StreamChunk, StreamResult<unknown>, unknown>;

  /**
   * Extract tool_use blocks from provider-specific fullContent.
   * Returns array of ToolUseBlock for client-side tool execution.
   */
  extractToolUseBlocks(fullContent: unknown): ToolUseBlock[];

  /**
   * GC provider-side per-chat session state (claude-agent: the on-disk SDK
   * session JSONL) once a session id has been superseded on the chat row —
   * a forked rewind replaced it, so nothing can resume it again. Best-effort:
   * implementations swallow failures. Omitted by providers whose full history
   * lives in the app's own message store.
   */
  deleteProviderSession?(sessionId: string): Promise<void>;
}

// Stream chunk types
export type StreamChunk =
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
  | { type: 'fallback'; fromModel?: string; toModel?: string } // claude-agent: request handed to a different model
  | {
      // claude-agent block we have no dedicated renderer for (unrecognized
      // server_tool_use name, non-bridged tool_use, or a brand-new block type).
      // `json` is the trimmed pretty-printed raw block.
      type: 'unknown_block';
      blockType: string;
      name?: string;
      id?: string;
      json: string;
    }
  | { type: 'citation'; url: string; title?: string; citedText?: string } // Citation for current text block
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> } // Client-side tool invocation
  | {
      // Result of a client-side tool the provider ran inside its own turn.
      // Only the claude-agent MCP bridge emits these (other providers route
      // tool results through the agentic loop's tool_block_update events).
      type: 'tool_result';
      tool_use_id: string;
      name: string;
      content: string;
      isError?: boolean;
      renderingGroups?: RenderingBlockGroup[]; // nested (minion) rendering
      tokenTotals?: TokenTotals; // sub-agent costs incurred by this tool call
    }
  | {
      // Follow-up patch for an already-emitted `tool_result` (claude-agent only):
      // the SDK delivered a different payload to the model than our bridge sent —
      // truncated for size, or replaced with an error. We still render the full
      // result; this just flags the divergence on that block. `tool_use_id` is
      // the bridge's synthetic id, matching the original `tool_result` chunk.
      type: 'tool_result_annotation';
      tool_use_id: string;
      modelDelivery: { status: 'truncated' | 'error'; detail?: string };
    }
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
  hasCoT?: boolean; // True if response included any chain-of-thought reasoning (including encrypted)
  fullContent: T; // Provider-specific blocks (Anthropic: ContentBlock[], ChatCompletions: {role,content,tool_calls?,refusal})
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
  webSearchCount?: number;
  /**
   * Provider-specific payload surfaced to ChatRunner for persistence on
   * the chat/message row. claude-agent populates this with
   * `{ claudeAgentSessionId, claudeAgentMessageUuid }`.
   */
  providerExtra?: Record<string, unknown>;
  /**
   * Token/cost totals incurred by client-side tools the provider executed
   * inside its own turn (claude-agent MCP bridge: minion sub-agent costs).
   * The agentic loop folds this into chat totals after the per-iteration
   * usage so subscription cost-zeroing doesn't wipe non-subscription tool costs.
   */
  toolTokenTotals?: TokenTotals;
  /**
   * Chat title/summary changes produced by bridged tools (the `metadata` tool)
   * during the provider's own turn. The SDK owns the whole turn so these can't
   * apply mid-turn; the agentic loop folds them in afterward via the
   * `chat_metadata_updated` loop event. claude-agent only.
   */
  chatMetadata?: { name?: string; summary?: string };
}
