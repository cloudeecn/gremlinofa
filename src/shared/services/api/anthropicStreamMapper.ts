/**
 * Anthropic Stream Mapper
 *
 * Extracts SSE → StreamChunk mapping logic from AnthropicClient
 * for easier testing and reuse.
 */

import type { StreamChunk } from './baseClient';

/**
 * Raw SSE event parsed from text stream
 */
export interface SSEEvent {
  event: string;
  data: unknown;
}

/**
 * State tracker for mapping Anthropic events to StreamChunks
 */
export interface MapperState {
  currentBlockType: string | null;
  // Track pending server_tool_use for JSON accumulation
  pendingToolUse: {
    id: string;
    name: string;
    inputJson: string;
  } | null;
  // Track pending client-side tool_use for JSON accumulation
  pendingClientToolUse: {
    id: string;
    name: string;
    inputJson: string;
  } | null;
  // Track current tool_use_id for web_search_tool_result
  currentToolUseId: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

/**
 * Create initial mapper state
 */
export function createMapperState(): MapperState {
  return {
    currentBlockType: null,
    pendingToolUse: null,
    pendingClientToolUse: null,
    currentToolUseId: null,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
  };
}

/**
 * Parse an SSE text block into event/data pairs
 * Format: "event: X\ndata: {json}\n\n"
 */
export function parseSSEText(text: string): SSEEvent[] {
  const events: SSEEvent[] = [];
  const lines = text.split('\n');

  let currentEvent: string | null = null;
  let currentData: string | null = null;

  for (const line of lines) {
    if (line.startsWith('event: ')) {
      currentEvent = line.slice(7).trim();
    } else if (line.startsWith('data: ')) {
      currentData = line.slice(6).trim();
    } else if (line === '' && currentEvent && currentData) {
      // Empty line marks end of event
      try {
        const data = JSON.parse(currentData);
        events.push({ event: currentEvent, data });
      } catch {
        // Skip malformed JSON
        console.warn('Failed to parse SSE data:', currentData);
      }
      currentEvent = null;
      currentData = null;
    }
  }

  return events;
}

/**
 * Map a single Anthropic SSE event to StreamChunk(s)
 * Returns chunks and updated state
 */
export function mapAnthropicEventToStreamChunks(
  sseEvent: SSEEvent,
  state: MapperState
): { chunks: StreamChunk[]; state: MapperState } {
  const chunks: StreamChunk[] = [];
  const newState = { ...state };

  const data = sseEvent.data as Record<string, unknown>;

  switch (sseEvent.event) {
    case 'content_block_start': {
      const contentBlock = data.content_block as Record<string, unknown>;
      const blockType = contentBlock?.type as string;
      newState.currentBlockType = blockType;

      if (blockType === 'text') {
        chunks.push({ type: 'content.start' });
      } else if (blockType === 'thinking') {
        chunks.push({ type: 'thinking.start' });
      } else if (blockType === 'server_tool_use') {
        const toolId = contentBlock.id as string | undefined;
        const toolName = contentBlock.name as string | undefined;
        const input = contentBlock.input as Record<string, unknown> | undefined;

        // Check if input already has the query/url (some providers may include it immediately)
        if (toolName === 'web_search' && input?.query && toolId) {
          chunks.push({ type: 'web_search', id: toolId, query: input.query as string });
        } else if (toolName === 'web_fetch' && input?.url && toolId) {
          chunks.push({ type: 'web_fetch', id: toolId, url: input.url as string });
        } else if (toolName === 'web_search' && toolId) {
          // Emit start immediately so UI shows "Searching..."
          chunks.push({ type: 'web_search.start', id: toolId });
          // Input will come via input_json_delta, track it with id
          newState.pendingToolUse = { id: toolId, name: toolName, inputJson: '' };
        } else if (toolName === 'web_fetch' && toolId) {
          // Emit start immediately so UI shows "Fetching..."
          chunks.push({ type: 'web_fetch.start', id: toolId });
          // Input will come via input_json_delta, track it with id
          newState.pendingToolUse = { id: toolId, name: toolName, inputJson: '' };
        }
      } else if (blockType === 'web_search_tool_result') {
        // Extract tool_use_id and search results from the content block
        const toolUseId = contentBlock.tool_use_id as string | undefined;
        newState.currentToolUseId = toolUseId || null;
        const content = contentBlock.content;
        if (Array.isArray(content) && toolUseId) {
          for (const result of content) {
            if (result.type === 'web_search_result') {
              const title = result.title as string | undefined;
              const url = result.url as string | undefined;
              if (title || url) {
                chunks.push({ type: 'web_search.result', tool_use_id: toolUseId, title, url });
              }
            }
          }
        }
      } else if (blockType === 'web_fetch_tool_result') {
        // Extract tool_use_id and fetch result from the content block
        const toolUseId = contentBlock.tool_use_id as string | undefined;
        const content = contentBlock.content as Record<string, unknown> | undefined;
        if (content && toolUseId && content.type === 'web_fetch_result') {
          const url = content.url as string | undefined;
          const title = content.title as string | undefined;
          if (url) {
            chunks.push({ type: 'web_fetch.result', tool_use_id: toolUseId, url, title });
          }
        }
      } else if (blockType === 'tool_use') {
        // Client-side tool use (e.g., ping, memory)
        const toolId = contentBlock.id as string | undefined;
        const toolName = contentBlock.name as string | undefined;
        const input = contentBlock.input as Record<string, unknown> | undefined;

        if (toolId && toolName) {
          // If input is already complete (non-empty object), emit immediately
          if (input && Object.keys(input).length > 0) {
            chunks.push({ type: 'tool_use', id: toolId, name: toolName, input });
          } else {
            // Input will come via input_json_delta
            newState.pendingClientToolUse = { id: toolId, name: toolName, inputJson: '' };
          }
        }
      }
      break;
    }

    case 'content_block_delta': {
      const delta = data.delta as Record<string, unknown>;
      if (delta?.type === 'text_delta') {
        chunks.push({ type: 'content', content: delta.text as string });
      } else if (delta?.type === 'thinking_delta') {
        chunks.push({ type: 'thinking', content: delta.thinking as string });
      } else if (delta?.type === 'input_json_delta' && state.pendingToolUse) {
        // Accumulate JSON for pending server tool use
        newState.pendingToolUse = {
          ...state.pendingToolUse,
          inputJson: state.pendingToolUse.inputJson + ((delta.partial_json as string) || ''),
        };
      } else if (delta?.type === 'input_json_delta' && state.pendingClientToolUse) {
        // Accumulate JSON for pending client-side tool use
        newState.pendingClientToolUse = {
          ...state.pendingClientToolUse,
          inputJson: state.pendingClientToolUse.inputJson + ((delta.partial_json as string) || ''),
        };
      } else if (delta?.type === 'citations_delta') {
        // Handle citation - emit citation chunk for current text block
        const citation = delta.citation as {
          type?: string;
          url?: string;
          title?: string;
          cited_text?: string;
        };
        if (citation?.url) {
          chunks.push({
            type: 'citation',
            url: citation.url,
            title: citation.title,
            citedText: citation.cited_text,
          });
        }
      }
      // Skip signature_delta - not needed for rendering
      break;
    }

    case 'content_block_stop': {
      if (state.currentBlockType === 'text') {
        chunks.push({ type: 'content.end' });
      } else if (state.currentBlockType === 'thinking') {
        chunks.push({ type: 'thinking.end' });
      } else if (state.currentBlockType === 'server_tool_use' && state.pendingToolUse) {
        // Parse accumulated JSON and emit tool use chunk
        try {
          const input = JSON.parse(state.pendingToolUse.inputJson) as Record<string, unknown>;
          if (state.pendingToolUse.name === 'web_search' && input.query) {
            chunks.push({
              type: 'web_search',
              id: state.pendingToolUse.id,
              query: input.query as string,
            });
          } else if (state.pendingToolUse.name === 'web_fetch' && input.url) {
            chunks.push({
              type: 'web_fetch',
              id: state.pendingToolUse.id,
              url: input.url as string,
            });
          }
        } catch {
          // Failed to parse JSON, skip
        }
        newState.pendingToolUse = null;
      } else if (state.currentBlockType === 'tool_use' && state.pendingClientToolUse) {
        // Parse accumulated JSON and emit client-side tool use chunk
        try {
          const inputJson = state.pendingClientToolUse.inputJson;
          // Handle empty input (ping tool has no parameters)
          const input = inputJson ? (JSON.parse(inputJson) as Record<string, unknown>) : {};
          chunks.push({
            type: 'tool_use',
            id: state.pendingClientToolUse.id,
            name: state.pendingClientToolUse.name,
            input,
          });
        } catch {
          // Failed to parse JSON, emit with empty input
          chunks.push({
            type: 'tool_use',
            id: state.pendingClientToolUse.id,
            name: state.pendingClientToolUse.name,
            input: {},
          });
        }
        newState.pendingClientToolUse = null;
      }
      // web_search_tool_result blocks don't need end events
      newState.currentBlockType = null;
      break;
    }

    case 'message_delta': {
      // Accumulate token usage from message delta
      const usage = data.usage as Record<string, number> | undefined;
      if (usage) {
        newState.inputTokens += usage.input_tokens ?? 0;
        newState.outputTokens += usage.output_tokens ?? 0;
        newState.cacheCreationTokens += usage.cache_creation_input_tokens ?? 0;
        newState.cacheReadTokens += usage.cache_read_input_tokens ?? 0;
      }
      break;
    }

    case 'message_stop': {
      // Yield complete token usage at end
      chunks.push({
        type: 'token_usage',
        inputTokens: newState.inputTokens,
        outputTokens: newState.outputTokens,
        cacheCreationTokens: newState.cacheCreationTokens,
        cacheReadTokens: newState.cacheReadTokens,
      });
      break;
    }

    case 'ping':
    case 'message_start':
      // No StreamChunks for these events (just the event itself)
      break;

    default:
      // Unknown events - just emit event chunk (already done above)
      break;
  }

  return { chunks, state: newState };
}

/**
 * Convert full SSE text to StreamChunk array
 * Convenience function for testing
 */
export function parseSSEToStreamChunks(sseText: string): StreamChunk[] {
  const sseEvents = parseSSEText(sseText);
  const allChunks: StreamChunk[] = [];
  let state = createMapperState();

  for (const sseEvent of sseEvents) {
    const result = mapAnthropicEventToStreamChunks(sseEvent, state);
    allChunks.push(...result.chunks);
    state = result.state;
  }

  return allChunks;
}
