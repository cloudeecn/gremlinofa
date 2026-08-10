/**
 * Chat Completions API FullContent Accumulator
 *
 * Accumulates streaming chunks to build the fullContent message object.
 * The fullContent is what gets stored and sent back to the API in future turns.
 *
 * Reasoning is kept under the key the provider used (`reasoning_content`,
 * `reasoning`, or OpenRouter's structured `reasoning_details`). DeepSeek-lineage
 * models want their own `reasoning_content` fed back inside an agentic run for
 * accurate follow-up tool calls, and an Anthropic upstream behind OpenRouter
 * needs its signed `reasoning_details` back or it rejects the turn; the request
 * builder decides what actually goes on the wire.
 */

import type { CompletionChunk, CompletionMessage, ReasoningDetail } from './completionStreamMapper';
import { reasoningTextFromDetails } from './completionStreamMapper';

/** Fields that arrive in fragments and are concatenated; everything else is last-write-wins. */
const CONCATENATED_DETAIL_FIELDS = ['text', 'summary', 'data'] as const;

/**
 * Accumulator for building fullContent from streaming chunks.
 *
 * Chat Completions fullContent format:
 * ```typescript
 * {
 *   role: 'assistant',
 *   content: string | null,
 *   reasoning_content?: string,
 *   reasoning?: string,
 *   tool_calls?: Array<{ id, type: 'function', function: { name, arguments } }>,
 *   refusal: string | null
 * }
 * ```
 */
export class CompletionFullContentAccumulator {
  private content: string = '';
  private reasoningContent: string = '';
  private reasoning: string = '';
  private reasoningDetails: Map<string, ReasoningDetail> = new Map();
  private reasoningDetailOrder: string[] = [];
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

    // Accumulate reasoning under the key the provider streams it on
    if (delta?.reasoning_content) {
      this.reasoningContent += delta.reasoning_content;
    }
    if (delta?.reasoning) {
      this.reasoning += delta.reasoning;
    }

    if (delta?.reasoning_details) {
      delta.reasoning_details.forEach((detail, position) =>
        this.mergeReasoningDetail(detail, position)
      );
    }

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
   * Fold one streamed `reasoning_details` entry into the accumulated set.
   *
   * Keyed on `index` when present, on the entry's position within the delta array
   * otherwise (a provider that streams a single block tends to omit `index`, and
   * position still merges its fragments correctly). The key carries `type` too, so
   * an index reused across types opens a second block rather than fusing a text
   * block into an encrypted one — which would produce a structurally invalid entry
   * and break the signature the whole round-trip depends on.
   */
  private mergeReasoningDetail(detail: ReasoningDetail, position: number): void {
    const slot = detail.index !== undefined ? `i:${detail.index}` : `p:${position}`;
    const key = `${slot}:${detail.type ?? ''}`;

    const existing = this.reasoningDetails.get(key);
    if (!existing) {
      this.reasoningDetails.set(key, { ...detail });
      this.reasoningDetailOrder.push(key);
      return;
    }

    for (const [field, value] of Object.entries(detail)) {
      if (value === undefined || value === null) {
        // Continuation fragments carry `id: null`; that must not erase the id the
        // opening fragment established.
        continue;
      }
      if (
        typeof value === 'string' &&
        (CONCATENATED_DETAIL_FIELDS as readonly string[]).includes(field)
      ) {
        existing[field] = `${(existing[field] as string | null | undefined) ?? ''}${value}`;
      } else {
        existing[field] = value;
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

    // Omit reasoning keys entirely for non-thinking models
    if (this.reasoningContent) {
      message.reasoning_content = this.reasoningContent;
    }
    if (this.reasoning) {
      message.reasoning = this.reasoning;
    }
    // First-seen order, never re-sorted by `index`: SSE arrival order is generation
    // order, and reordering is the one thing OpenRouter's round-trip forbids.
    if (this.reasoningDetailOrder.length > 0) {
      message.reasoning_details = this.reasoningDetailOrder.map(
        key => this.reasoningDetails.get(key) as ReasoningDetail
      );
    }

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

/** Reasoning text a non-streaming response carried, under any of the provider keys. */
export function reasoningTextOf(message: {
  reasoning_content?: string | null;
  reasoning?: string | null;
  reasoning_details?: ReasoningDetail[];
}): string {
  return (
    message.reasoning_content ||
    message.reasoning ||
    reasoningTextFromDetails(message.reasoning_details)
  );
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
  reasoning_content?: string | null;
  reasoning?: string | null;
  reasoning_details?: ReasoningDetail[];
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
    ...(message.reasoning_content && { reasoning_content: message.reasoning_content }),
    ...(message.reasoning && { reasoning: message.reasoning }),
    // By reference, unmerged and unnormalized — the echo has to be verbatim.
    ...(message.reasoning_details?.length && { reasoning_details: message.reasoning_details }),
    tool_calls: message.tool_calls,
    refusal: message.refusal ?? null,
  };
}
