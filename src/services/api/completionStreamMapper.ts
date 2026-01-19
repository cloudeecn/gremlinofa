/**
 * Chat Completions API Stream Mapper
 *
 * Maps SDK stream chunks to StreamChunks for rendering.
 * Handles text content, reasoning, and tool calls.
 *
 * IMPORTANT: This mapper only produces StreamChunks for renderingContent.
 * It does NOT produce fullContent - use CompletionFullContentAccumulator for that.
 */

import type { StreamChunk } from './baseClient';

/**
 * State tracker for mapping Chat Completions chunks to StreamChunks
 */
export interface CompletionMapperState {
  inReasoningBlock: boolean;
  inContentBlock: boolean;
  /** Accumulated tool calls by index for emitting on finish */
  toolCalls: Map<number, { id: string; name: string; arguments: string }>;
}

/**
 * Create initial mapper state
 */
export function createMapperState(): CompletionMapperState {
  return {
    inReasoningBlock: false,
    inContentBlock: false,
    toolCalls: new Map(),
  };
}

/**
 * Map a single Chat Completions SDK chunk to StreamChunk(s).
 * Returns chunks and updated state.
 *
 * @param chunk - Raw SDK chunk (ChatCompletionChunk shape)
 * @param state - Current mapper state
 */
export function mapCompletionChunkToStreamChunks(
  chunk: CompletionChunk,
  state: CompletionMapperState
): { chunks: StreamChunk[]; state: CompletionMapperState } {
  const chunks: StreamChunk[] = [];
  const newState: CompletionMapperState = {
    ...state,
    toolCalls: new Map(state.toolCalls),
  };

  const choice = chunk.choices?.[0];
  if (!choice) {
    // Usage-only chunk at end of stream
    if (chunk.usage) {
      chunks.push(createTokenUsageChunk(chunk.usage));
    }
    return { chunks, state: newState };
  }

  const delta = choice.delta;
  const finishReason = choice.finish_reason;

  // Handle reasoning content (delta.reasoning)
  if (delta?.reasoning) {
    if (!state.inReasoningBlock) {
      chunks.push({ type: 'thinking.start' });
      newState.inReasoningBlock = true;
    }
    chunks.push({ type: 'thinking', content: delta.reasoning });
  }

  // Handle text content (delta.content)
  if (delta?.content) {
    // Close reasoning block if transitioning to content
    if (state.inReasoningBlock) {
      chunks.push({ type: 'thinking.end' });
      newState.inReasoningBlock = false;
    }
    if (!state.inContentBlock) {
      chunks.push({ type: 'content.start' });
      newState.inContentBlock = true;
    }
    chunks.push({ type: 'content', content: delta.content });
  }

  // Handle tool calls (delta.tool_calls)
  if (delta?.tool_calls) {
    // Close reasoning block if present
    if (state.inReasoningBlock) {
      chunks.push({ type: 'thinking.end' });
      newState.inReasoningBlock = false;
    }
    // Close content block if present
    if (state.inContentBlock) {
      chunks.push({ type: 'content.end' });
      newState.inContentBlock = false;
    }

    for (const toolCall of delta.tool_calls) {
      const index = toolCall.index;
      const existing = newState.toolCalls.get(index);

      if (existing) {
        // Append arguments to existing tool call
        if (toolCall.function?.arguments) {
          existing.arguments += toolCall.function.arguments;
        }
      } else {
        // New tool call
        newState.toolCalls.set(index, {
          id: toolCall.id || `tc_${Date.now()}_${index}`,
          name: toolCall.function?.name || '',
          arguments: toolCall.function?.arguments || '',
        });
      }
    }
  }

  // Handle finish reason
  if (finishReason === 'tool_calls') {
    // Emit tool_use chunks for all accumulated tool calls
    for (const tc of newState.toolCalls.values()) {
      let input: Record<string, unknown> = {};
      try {
        input = tc.arguments ? (JSON.parse(tc.arguments) as Record<string, unknown>) : {};
      } catch {
        // Keep empty input on parse failure
      }
      chunks.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.name,
        input,
      });
    }
    newState.toolCalls.clear();
  } else if (finishReason === 'stop' || finishReason === 'length') {
    // Close any open blocks
    if (state.inReasoningBlock) {
      chunks.push({ type: 'thinking.end' });
      newState.inReasoningBlock = false;
    }
    if (state.inContentBlock) {
      chunks.push({ type: 'content.end' });
      newState.inContentBlock = false;
    }
  }

  // Handle token usage (comes in final chunks)
  if (chunk.usage) {
    chunks.push(createTokenUsageChunk(chunk.usage));
  }

  return { chunks, state: newState };
}

/**
 * Convert non-streaming message to StreamChunks.
 * Used for the non-streaming API path.
 */
export function convertMessageToStreamChunks(message: CompletionMessage): StreamChunk[] {
  const chunks: StreamChunk[] = [];

  // Handle text content
  if (message.content) {
    chunks.push({ type: 'content.start' });
    chunks.push({ type: 'content', content: message.content });
    chunks.push({ type: 'content.end' });
  }

  // Handle tool calls
  if (message.tool_calls) {
    for (const tc of message.tool_calls) {
      let input: Record<string, unknown> = {};
      try {
        input = tc.function.arguments
          ? (JSON.parse(tc.function.arguments) as Record<string, unknown>)
          : {};
      } catch {
        // Keep empty input on parse failure
      }
      chunks.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.function.name,
        input,
      });
    }
  }

  return chunks;
}

/**
 * Create token usage chunk from usage object.
 */
function createTokenUsageChunk(usage: CompletionUsage): StreamChunk {
  const inputTokens = usage.prompt_tokens || 0;
  const outputTokens = usage.completion_tokens || 0;
  const cachedTokens = usage.prompt_tokens_details?.cached_tokens || 0;
  const reasoningTokens = usage.completion_tokens_details?.reasoning_tokens || 0;

  return {
    type: 'token_usage',
    inputTokens: inputTokens - cachedTokens,
    outputTokens,
    cacheReadTokens: cachedTokens,
    reasoningTokens: reasoningTokens > 0 ? reasoningTokens : undefined,
  };
}

// ============================================================================
// Type definitions for Chat Completions API structures
// ============================================================================

/** Minimal interface for SDK stream chunk */
export interface CompletionChunk {
  choices?: Array<{
    index: number;
    delta?: {
      role?: string;
      content?: string | null;
      reasoning?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: string;
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: CompletionUsage;
}

/** Minimal interface for non-streaming message */
export interface CompletionMessage {
  role: string;
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: string;
    function: {
      name: string;
      arguments: string;
    };
  }>;
  refusal?: string | null;
}

/** Usage tracking from API response */
interface CompletionUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
  };
  completion_tokens_details?: {
    reasoning_tokens?: number;
  };
}

// ============================================================================
// Test helpers - for unit testing only
// ============================================================================

/**
 * Parse raw SSE text to StreamChunks.
 * For unit testing only - not used in production.
 */
export function parseSSEToStreamChunks(sseText: string): StreamChunk[] {
  const chunks: CompletionChunk[] = [];

  for (const line of sseText.split('\n')) {
    if (line.startsWith('data: ') && !line.includes('[DONE]')) {
      try {
        const data = JSON.parse(line.slice(6)) as CompletionChunk;
        chunks.push(data);
      } catch {
        // Skip malformed lines
      }
    }
  }

  const allChunks: StreamChunk[] = [];
  let state = createMapperState();

  for (const chunk of chunks) {
    const result = mapCompletionChunkToStreamChunks(chunk, state);
    allChunks.push(...result.chunks);
    state = result.state;
  }

  return allChunks;
}
