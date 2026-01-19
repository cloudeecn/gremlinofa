/**
 * Chat Completions API FullContent Accumulator
 *
 * Accumulates streaming chunks to build the fullContent message object.
 * The fullContent is what gets stored and sent back to the API in future turns.
 *
 * IMPORTANT: Reasoning is NOT included in fullContent - it cannot be sent back
 * to the API. Reasoning is only used for renderingContent (display).
 */

import type { CompletionChunk, CompletionMessage } from './completionStreamMapper';

/**
 * Accumulator for building fullContent from streaming chunks.
 *
 * Chat Completions fullContent format:
 * ```typescript
 * {
 *   role: 'assistant',
 *   content: string | null,
 *   tool_calls?: Array<{ id, type: 'function', function: { name, arguments } }>,
 *   refusal: string | null
 * }
 * ```
 */
export class CompletionFullContentAccumulator {
  private content: string = '';
  private toolCalls: Map<number, { id: string; name: string; arguments: string }> = new Map();
  private refusal: string | null = null;

  /**
   * Push a streaming chunk to accumulate content and tool calls.
   */
  pushChunk(chunk: CompletionChunk): void {
    const choice = chunk.choices?.[0];
    if (!choice) return;

    const delta = choice.delta;

    // Accumulate text content
    if (delta?.content) {
      this.content += delta.content;
    }

    // NOTE: We intentionally ignore delta.reasoning here.
    // Reasoning cannot be sent back to the API, so it's not part of fullContent.

    // Accumulate tool calls by index
    if (delta?.tool_calls) {
      for (const toolCall of delta.tool_calls) {
        const index = toolCall.index;
        const existing = this.toolCalls.get(index);

        if (existing) {
          // Append arguments to existing tool call
          if (toolCall.function?.arguments) {
            existing.arguments += toolCall.function.arguments;
          }
        } else {
          // New tool call
          this.toolCalls.set(index, {
            id: toolCall.id || `tc_${Date.now()}_${index}`,
            name: toolCall.function?.name || '',
            arguments: toolCall.function?.arguments || '',
          });
        }
      }
    }
  }

  /**
   * Finalize and return the fullContent message object.
   * Call this after all chunks have been processed.
   */
  finalize(): CompletionMessage {
    const message: CompletionMessage = {
      role: 'assistant',
      content: this.content || null,
      refusal: this.refusal,
    };

    // Add tool_calls if any were accumulated
    if (this.toolCalls.size > 0) {
      message.tool_calls = Array.from(this.toolCalls.values()).map(tc => ({
        id: tc.id,
        type: 'function' as const,
        function: {
          name: tc.name,
          arguments: tc.arguments,
        },
      }));
    }

    return message;
  }

  /**
   * Get accumulated content (for textContent in StreamResult).
   */
  getContent(): string {
    return this.content;
  }
}

/**
 * Create fullContent from a non-streaming message response.
 * Used when disableStream is true.
 *
 * @param message - The message object from response.choices[0].message
 */
export function createFullContentFromMessage(message: {
  role?: string;
  content?: string | null;
  tool_calls?: Array<{
    id: string;
    type: string;
    function: { name: string; arguments: string };
  }>;
  refusal?: string | null;
}): CompletionMessage {
  return {
    role: message.role || 'assistant',
    content: message.content ?? null,
    tool_calls: message.tool_calls,
    refusal: message.refusal ?? null,
  };
}
