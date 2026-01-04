/**
 * Responses API Stream Mapper
 *
 * Extracts SSE → StreamChunk mapping logic from ResponsesClient.
 * Handles both streaming events and non-streaming output conversion.
 */

import type OpenAI from 'openai';
import type { StreamChunk } from './baseClient';

/**
 * Raw SSE event parsed from Responses API stream
 */
export interface ResponsesSSEEvent {
  type: string;
  data: Record<string, unknown>;
}

/**
 * State tracker for mapping Responses API events to StreamChunks
 */
export interface ResponsesMapperState {
  inReasoningBlock: boolean;
  inContentBlock: boolean;
  currentReasoningItemId: string | null;
  pendingWebSearches: Map<string, { query: string }>;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
}

/**
 * Create initial mapper state
 */
export function createMapperState(): ResponsesMapperState {
  return {
    inReasoningBlock: false,
    inContentBlock: false,
    currentReasoningItemId: null,
    pendingWebSearches: new Map(),
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
  };
}

/**
 * Parse Responses API SSE text block into event objects
 * Format: "event: X\ndata: {json}\n\n"
 */
export function parseResponsesSSEText(text: string): ResponsesSSEEvent[] {
  const events: ResponsesSSEEvent[] = [];
  const lines = text.split('\n');

  let currentEvent: string | null = null;
  let currentData: string | null = null;

  for (const line of lines) {
    if (line.startsWith('event: ')) {
      currentEvent = line.slice(7).trim();
    } else if (line.startsWith('data: ')) {
      currentData = line.slice(6).trim();
    } else if (line === '' && currentEvent && currentData) {
      try {
        const data = JSON.parse(currentData) as Record<string, unknown>;
        events.push({ type: currentEvent, data });
      } catch {
        console.warn('Failed to parse SSE data:', currentData);
      }
      currentEvent = null;
      currentData = null;
    }
  }

  return events;
}

/**
 * Parse a single SSE event from stream data.
 * Used when processing raw stream chunks that contain type embedded in data.
 */
export function parseResponsesStreamEvent(
  chunk: OpenAI.Responses.ResponseStreamEvent
): ResponsesSSEEvent {
  return {
    type: chunk.type as string,
    data: chunk as unknown as Record<string, unknown>,
  };
}

/**
 * Map a single Responses API event to StreamChunk(s)
 * Returns chunks and updated state
 */
export function mapResponsesEventToStreamChunks(
  event: ResponsesSSEEvent,
  state: ResponsesMapperState
): { chunks: StreamChunk[]; state: ResponsesMapperState } {
  const chunks: StreamChunk[] = [];
  const newState: ResponsesMapperState = {
    ...state,
    pendingWebSearches: new Map(state.pendingWebSearches),
  };

  // Always yield event type for tracking
  chunks.push({ type: 'event', content: event.type });

  const data = event.data;

  switch (event.type) {
    case 'response.output_item.added': {
      const item = data.item as Record<string, unknown> | undefined;
      if (!item) break;

      const itemType = item.type as string;
      const itemId = item.id as string;

      if (itemType === 'reasoning') {
        // Start thinking block
        chunks.push({ type: 'thinking.start' });
        newState.inReasoningBlock = true;
        newState.currentReasoningItemId = itemId;
      } else if (itemType === 'web_search_call') {
        // Track pending web search
        newState.pendingWebSearches.set(itemId, { query: '' });
        chunks.push({ type: 'web_search.start', id: itemId });
      } else if (itemType === 'function_call') {
        // Function call will be emitted on output_item.done when complete
      } else if (itemType === 'message') {
        // Message content start - actual text comes via output_text.delta
      }
      break;
    }

    case 'response.reasoning_summary_text.delta': {
      const delta = data.delta as string | undefined;
      if (delta) {
        // Emit thinking.start if not already in block
        if (!state.inReasoningBlock) {
          chunks.push({ type: 'thinking.start' });
          newState.inReasoningBlock = true;
        }
        chunks.push({ type: 'thinking', content: delta });
      }
      break;
    }

    case 'response.reasoning_summary_part.done':
    case 'response.output_item.done': {
      const item = data.item as Record<string, unknown> | undefined;
      if (!item) break;

      const itemType = item.type as string;
      const itemId = item.id as string;

      if (itemType === 'reasoning') {
        // End thinking block
        if (state.inReasoningBlock) {
          chunks.push({ type: 'thinking.end' });
          newState.inReasoningBlock = false;
          newState.currentReasoningItemId = null;
        }
      } else if (itemType === 'web_search_call') {
        // Web search completed - extract query from action
        const action = item.action as Record<string, unknown> | undefined;
        if (action) {
          const actionType = action.type as string;
          if (actionType === 'search') {
            const query = action.query as string;
            if (query) {
              chunks.push({ type: 'web_search', id: itemId, query });
            }
          } else if (actionType === 'open_page') {
            // open_page events have a URL, emit as web_search with URL as query for now
            const url = action.url as string;
            if (url) {
              chunks.push({ type: 'web_search', id: itemId, query: `Opening: ${url}` });
            }
          }
        }
        newState.pendingWebSearches.delete(itemId);
      } else if (itemType === 'function_call') {
        // Emit tool_use chunk for function call
        const callId = item.call_id as string;
        const name = item.name as string;
        const argumentsStr = item.arguments as string;

        let input: Record<string, unknown> = {};
        try {
          input = argumentsStr ? (JSON.parse(argumentsStr) as Record<string, unknown>) : {};
        } catch {
          // Keep empty input on parse failure
        }

        chunks.push({
          type: 'tool_use',
          id: callId,
          name,
          input,
        });
      }
      break;
    }

    case 'response.content_part.added': {
      const part = data.part as Record<string, unknown> | undefined;
      if (part?.type === 'output_text') {
        chunks.push({ type: 'content.start' });
        newState.inContentBlock = true;
      }
      break;
    }

    case 'response.content_part.done': {
      const part = data.part as Record<string, unknown> | undefined;
      if (part?.type === 'output_text' && state.inContentBlock) {
        chunks.push({ type: 'content.end' });
        newState.inContentBlock = false;
      }
      break;
    }

    case 'response.output_text.delta': {
      const delta = data.delta as string | undefined;
      if (delta) {
        // Emit content.start if not already in block
        if (!state.inContentBlock) {
          chunks.push({ type: 'content.start' });
          newState.inContentBlock = true;
        }
        chunks.push({ type: 'content', content: delta });
      }
      break;
    }

    case 'response.web_search_call.searching': {
      const itemId = data.item_id as string | undefined;
      // Searching event indicates search is in progress
      // Query may not be available here; it comes with output_item.done
      if (itemId && !newState.pendingWebSearches.has(itemId)) {
        newState.pendingWebSearches.set(itemId, { query: '' });
      }
      break;
    }

    case 'response.web_search_call.completed': {
      // Completed event - actual query/URL is in output_item.done
      break;
    }

    case 'response.completed': {
      // Close any open blocks
      if (state.inContentBlock) {
        chunks.push({ type: 'content.end' });
        newState.inContentBlock = false;
      }
      if (state.inReasoningBlock) {
        chunks.push({ type: 'thinking.end' });
        newState.inReasoningBlock = false;
      }

      // Extract token usage from response
      const response = data.response as Record<string, unknown> | undefined;
      const usage = response?.usage as Record<string, unknown> | undefined;

      if (usage) {
        const inputTokens = (usage.input_tokens as number) || 0;
        const outputTokens = (usage.output_tokens as number) || 0;
        const inputDetails = usage.input_tokens_details as Record<string, unknown> | undefined;
        const outputDetails = usage.output_tokens_details as Record<string, unknown> | undefined;
        const cachedTokens = (inputDetails?.cached_tokens as number) || 0;
        const reasoningTokens = (outputDetails?.reasoning_tokens as number) || 0;

        newState.inputTokens = inputTokens - cachedTokens;
        newState.outputTokens = outputTokens;
        newState.cacheReadTokens = cachedTokens;
        newState.reasoningTokens = reasoningTokens;

        chunks.push({
          type: 'token_usage',
          inputTokens: inputTokens - cachedTokens,
          outputTokens,
          cacheReadTokens: cachedTokens,
          reasoningTokens: reasoningTokens > 0 ? reasoningTokens : undefined,
        });
      }
      break;
    }

    case 'response.created':
    case 'response.in_progress':
    case 'response.reasoning_summary_part.added':
    case 'response.reasoning_summary_text.done':
    case 'response.web_search_call.in_progress':
      // No chunks needed for these events
      break;

    default:
      // Unknown events - just the event chunk (already added above)
      break;
  }

  return { chunks, state: newState };
}

// ============================================================================
// Phase 2: Non-streaming output conversion
// ============================================================================

/**
 * Convert non-streaming response output to StreamChunks.
 * This allows the same StreamingContentAssembler to handle both paths.
 *
 * Uses SDK's ResponseOutputItem[] type directly.
 */
export function convertOutputToStreamChunks(
  output: OpenAI.Responses.ResponseOutputItem[]
): StreamChunk[] {
  const chunks: StreamChunk[] = [];

  for (const item of output) {
    switch (item.type) {
      case 'reasoning': {
        chunks.push({ type: 'thinking.start' });

        // Extract text from summary array
        for (const summaryPart of item.summary) {
          if (summaryPart.type === 'summary_text' && summaryPart.text) {
            chunks.push({ type: 'thinking', content: summaryPart.text });
          }
        }

        chunks.push({ type: 'thinking.end' });
        break;
      }

      case 'web_search_call': {
        // SDK's ResponseFunctionWebSearch type doesn't expose 'action' property,
        // but the runtime response includes it. Cast to access the actual structure.
        const webSearchItem = item as unknown as {
          id: string;
          action?: {
            type: string;
            query?: string;
            url?: string;
            sources?: Array<{ url: string; title?: string }>;
          };
        };
        const action = webSearchItem.action;

        // Emit web_search.start first
        chunks.push({ type: 'web_search.start', id: webSearchItem.id });

        if (action) {
          if (action.type === 'search' && action.query) {
            chunks.push({
              type: 'web_search',
              id: webSearchItem.id,
              query: action.query,
            });
          } else if (action.type === 'open_page' && action.url) {
            // Emit as web_search with URL info
            chunks.push({
              type: 'web_search',
              id: webSearchItem.id,
              query: `Opening: ${action.url}`,
            });
          }

          // Emit sources as results if available
          if (action.type === 'search' && action.sources && action.sources.length > 0) {
            for (const source of action.sources) {
              chunks.push({
                type: 'web_search.result',
                tool_use_id: webSearchItem.id,
                url: source.url,
                title: source.title,
              });
            }
          }
        }
        break;
      }

      case 'function_call': {
        let input: Record<string, unknown> = {};
        try {
          input = item.arguments ? (JSON.parse(item.arguments) as Record<string, unknown>) : {};
        } catch {
          // Keep empty input on parse failure
        }

        chunks.push({
          type: 'tool_use',
          id: item.call_id,
          name: item.name,
          input,
        });
        break;
      }

      case 'message': {
        if (item.role !== 'assistant') continue;

        // Extract text content
        let hasContent = false;
        for (const part of item.content) {
          if (part.type === 'output_text' && part.text) {
            if (!hasContent) {
              chunks.push({ type: 'content.start' });
              hasContent = true;
            }
            chunks.push({ type: 'content', content: part.text });
          } else if (part.type === 'refusal' && part.refusal) {
            if (!hasContent) {
              chunks.push({ type: 'content.start' });
              hasContent = true;
            }
            chunks.push({ type: 'content', content: part.refusal });
          }
        }

        if (hasContent) {
          chunks.push({ type: 'content.end' });
        }
        break;
      }

      // Explicitly skip unhandled SDK types
      case 'file_search_call':
      case 'computer_call':
      case 'compaction':
      case 'image_generation_call':
      case 'code_interpreter_call':
      case 'local_shell_call':
      case 'shell_call':
      case 'shell_call_output':
      case 'apply_patch_call':
      case 'apply_patch_call_output':
      case 'mcp_call':
      case 'mcp_list_tools':
      case 'mcp_approval_request':
      case 'custom_tool_call':
        // Not implemented - skip these tool types
        break;
    }
  }

  return chunks;
}

/**
 * Add token usage chunk from non-streaming response.
 */
export function createTokenUsageChunk(usage: {
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
  output_tokens_details?: { reasoning_tokens?: number };
}): StreamChunk {
  const inputTokens = usage.input_tokens || 0;
  const outputTokens = usage.output_tokens || 0;
  const cachedTokens = usage.input_tokens_details?.cached_tokens || 0;
  const reasoningTokens = usage.output_tokens_details?.reasoning_tokens || 0;

  return {
    type: 'token_usage',
    inputTokens: inputTokens - cachedTokens,
    outputTokens,
    cacheReadTokens: cachedTokens,
    reasoningTokens: reasoningTokens > 0 ? reasoningTokens : undefined,
  };
}

/**
 * Convert full SSE text to StreamChunk array.
 * Convenience function for testing.
 */
export function parseSSEToStreamChunks(sseText: string): StreamChunk[] {
  const sseEvents = parseResponsesSSEText(sseText);
  const allChunks: StreamChunk[] = [];
  let state = createMapperState();

  for (const sseEvent of sseEvents) {
    const result = mapResponsesEventToStreamChunks(sseEvent, state);
    allChunks.push(...result.chunks);
    state = result.state;
  }

  return allChunks;
}
