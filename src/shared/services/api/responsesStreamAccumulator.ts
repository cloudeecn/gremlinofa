/**
 * Responses API Stream Accumulator
 *
 * Builds the final StreamResult directly from streaming events. This is the
 * opt-in alternative to `stream.finalResponse()` for third-party providers
 * whose Responses API returns an empty `Response.output` after streaming —
 * the user sees rendered text and tool calls during the stream, but the SDK's
 * final response object is missing the items, leaving `result.textContent`
 * empty and `extractToolUseBlocks` blind.
 *
 * Mirrors `CompletionFullContentAccumulator` for the Chat Completions client.
 *
 * Tolerance: deltas that reference an `output_index` we haven't seen yet are
 * silently dropped instead of throwing. The accumulator stores items by
 * index, so unknown item types pass through untouched and any future
 * `ResponseOutputItem` variant will end up in `fullContent` automatically.
 */

import type OpenAI from 'openai';
import type { StreamResult } from './baseClient';
import type { ResponsesSSEEvent } from './responsesStreamMapper';

type OutputItem = OpenAI.Responses.ResponseInputItem;

interface AccumulatorTokens {
  input: number;
  output: number;
  cachedInput: number;
  reasoning: number;
}

export interface AccumulatorFinalState {
  textContent: string;
  thinkingContent: string;
  hasCoT: boolean;
  fullContent: OutputItem[];
  hasFunctionCall: boolean;
  webSearchCount: number;
  tokens: AccumulatorTokens;
}

/**
 * Mutable item shape used internally — we cast to/from `OutputItem` at the
 * boundaries. The SDK union types make in-place mutation awkward, so we
 * treat items as loosely-typed records during accumulation.
 */
type MutableItem = Record<string, unknown> & { type?: string };

export class ResponsesStreamAccumulator {
  private items: Map<number, MutableItem> = new Map();
  private textContent: string = '';
  private thinkingContent: string = '';
  private tokens: AccumulatorTokens = {
    input: 0,
    output: 0,
    cachedInput: 0,
    reasoning: 0,
  };

  /**
   * Push a single Responses API SSE event into the accumulator.
   */
  pushEvent(event: ResponsesSSEEvent): void {
    const data = event.data;

    switch (event.type) {
      case 'response.created': {
        // Some providers pre-populate the output array on the response object.
        const response = data.response as Record<string, unknown> | undefined;
        const output = response?.output as MutableItem[] | undefined;
        if (Array.isArray(output)) {
          for (let i = 0; i < output.length; i++) {
            const item = output[i];
            if (item && typeof item === 'object') {
              this.items.set(i, { ...item });
            }
          }
        }
        break;
      }

      case 'response.output_item.added': {
        const index = data.output_index as number | undefined;
        const item = data.item as MutableItem | undefined;
        if (index === undefined || !item) break;
        // Clone so the SDK's internal references aren't mutated.
        this.items.set(index, this.cloneItem(item));
        break;
      }

      case 'response.output_item.done': {
        const index = data.output_index as number | undefined;
        const item = data.item as MutableItem | undefined;
        if (index === undefined || !item) break;
        // Source of truth — replace the partial item with the complete one.
        this.items.set(index, this.cloneItem(item));
        break;
      }

      case 'response.content_part.added': {
        const index = data.output_index as number | undefined;
        const part = data.part as MutableItem | undefined;
        if (index === undefined || !part) break;
        const item = this.items.get(index);
        if (!item || item.type !== 'message') break;
        const content = (item.content as MutableItem[] | undefined) ?? [];
        content.push(this.cloneItem(part));
        item.content = content;
        break;
      }

      case 'response.output_text.delta': {
        const delta = data.delta as string | undefined;
        if (!delta) break;
        this.textContent += delta;
        const index = data.output_index as number | undefined;
        const contentIndex = data.content_index as number | undefined;
        if (index !== undefined) {
          this.appendToMessagePart(index, contentIndex, 'output_text', 'text', delta);
        }
        break;
      }

      case 'response.refusal.delta': {
        const delta = data.delta as string | undefined;
        if (!delta) break;
        const index = data.output_index as number | undefined;
        const contentIndex = data.content_index as number | undefined;
        if (index !== undefined) {
          this.appendToMessagePart(index, contentIndex, 'refusal', 'refusal', delta);
        }
        break;
      }

      case 'response.function_call_arguments.delta': {
        const delta = data.delta as string | undefined;
        if (!delta) break;
        const index = data.output_index as number | undefined;
        if (index === undefined) break;
        const item = this.items.get(index);
        if (!item || item.type !== 'function_call') break;
        item.arguments = ((item.arguments as string | undefined) ?? '') + delta;
        break;
      }

      case 'response.reasoning_text.delta': {
        const delta = data.delta as string | undefined;
        if (!delta) break;
        this.thinkingContent += delta;
        const index = data.output_index as number | undefined;
        const contentIndex = data.content_index as number | undefined;
        if (index !== undefined) {
          this.appendToReasoningContent(index, contentIndex, delta);
        }
        break;
      }

      case 'response.reasoning_summary_text.delta': {
        const delta = data.delta as string | undefined;
        if (!delta) break;
        this.thinkingContent += delta;
        const index = data.output_index as number | undefined;
        const summaryIndex = data.summary_index as number | undefined;
        if (index !== undefined) {
          this.appendToReasoningSummary(index, summaryIndex, delta);
        }
        break;
      }

      case 'response.completed': {
        const response = data.response as Record<string, unknown> | undefined;
        const usage = response?.usage as Record<string, unknown> | undefined;
        if (usage) {
          const inputTokens = (usage.input_tokens as number) || 0;
          const outputTokens = (usage.output_tokens as number) || 0;
          const inputDetails = usage.input_tokens_details as Record<string, unknown> | undefined;
          const outputDetails = usage.output_tokens_details as Record<string, unknown> | undefined;
          this.tokens = {
            input: inputTokens,
            output: outputTokens,
            cachedInput: (inputDetails?.cached_tokens as number) || 0,
            reasoning: (outputDetails?.reasoning_tokens as number) || 0,
          };
        }
        break;
      }

      default:
        // Other events (output_text.done, content_part.done, in_progress, etc.)
        // are no-ops here — output_item.done carries the final values.
        break;
    }
  }

  /**
   * Finalize and return the accumulated state.
   */
  finalize(): AccumulatorFinalState {
    const sortedIndices = Array.from(this.items.keys()).sort((a, b) => a - b);
    const fullContent: OutputItem[] = sortedIndices.map(
      idx => this.items.get(idx) as unknown as OutputItem
    );

    let hasCoT = false;
    let hasFunctionCall = false;
    let webSearchCount = 0;
    for (const item of fullContent) {
      const t = (item as { type?: string }).type;
      if (t === 'reasoning') hasCoT = true;
      if (t === 'function_call') hasFunctionCall = true;
      if (t === 'web_search_call') webSearchCount++;
    }

    return {
      textContent: this.textContent,
      thinkingContent: this.thinkingContent,
      hasCoT,
      fullContent,
      hasFunctionCall,
      webSearchCount,
      tokens: this.tokens,
    };
  }

  private cloneItem(item: MutableItem): MutableItem {
    // Shallow clone is enough — we only mutate top-level fields like
    // `arguments`, `content`, `summary` and create fresh nested arrays
    // before mutating them.
    return { ...item };
  }

  private appendToMessagePart(
    index: number,
    contentIndex: number | undefined,
    partType: 'output_text' | 'refusal',
    field: 'text' | 'refusal',
    delta: string
  ): void {
    const item = this.items.get(index);
    if (!item || item.type !== 'message') return;
    const content = ((item.content as MutableItem[] | undefined) ?? []).slice();
    item.content = content;

    const target = contentIndex ?? content.length - 1;
    let part = target >= 0 ? content[target] : undefined;
    if (!part || part.type !== partType) {
      part = { type: partType, [field]: '' };
      if (contentIndex !== undefined) {
        content[contentIndex] = part;
      } else {
        content.push(part);
      }
    } else {
      // Make a fresh copy so we don't mutate a part referenced elsewhere.
      part = { ...part };
      content[target] = part;
    }
    part[field] = ((part[field] as string | undefined) ?? '') + delta;
  }

  private appendToReasoningContent(
    index: number,
    contentIndex: number | undefined,
    delta: string
  ): void {
    const item = this.items.get(index);
    if (!item || item.type !== 'reasoning') return;
    const content = ((item.content as MutableItem[] | undefined) ?? []).slice();
    item.content = content;

    const target = contentIndex ?? content.length - 1;
    let part = target >= 0 ? content[target] : undefined;
    if (!part || part.type !== 'reasoning_text') {
      part = { type: 'reasoning_text', text: '' };
      if (contentIndex !== undefined) {
        content[contentIndex] = part;
      } else {
        content.push(part);
      }
    } else {
      part = { ...part };
      content[target] = part;
    }
    part.text = ((part.text as string | undefined) ?? '') + delta;
  }

  private appendToReasoningSummary(
    index: number,
    summaryIndex: number | undefined,
    delta: string
  ): void {
    const item = this.items.get(index);
    if (!item || item.type !== 'reasoning') return;
    const summary = ((item.summary as MutableItem[] | undefined) ?? []).slice();
    item.summary = summary;

    const target = summaryIndex ?? summary.length - 1;
    let part = target >= 0 ? summary[target] : undefined;
    if (!part || part.type !== 'summary_text') {
      part = { type: 'summary_text', text: '' };
      if (summaryIndex !== undefined) {
        summary[summaryIndex] = part;
      } else {
        summary.push(part);
      }
    } else {
      part = { ...part };
      summary[target] = part;
    }
    part.text = ((part.text as string | undefined) ?? '') + delta;
  }
}

/**
 * Build a `StreamResult` from the accumulator's finalized state. Mirrors
 * the shape produced by `ResponsesClient.processResponse`.
 */
export function buildStreamResultFromAccumulator(
  accumulator: ResponsesStreamAccumulator
): StreamResult<OutputItem[]> {
  const state = accumulator.finalize();
  const { tokens } = state;

  return {
    textContent: state.textContent,
    thinkingContent: state.thinkingContent || undefined,
    hasCoT: state.hasCoT,
    fullContent: state.fullContent,
    stopReason: state.hasFunctionCall ? 'tool_use' : undefined,
    inputTokens: tokens.input - tokens.cachedInput,
    outputTokens: tokens.output - tokens.reasoning,
    cacheReadTokens: tokens.cachedInput,
    reasoningTokens: tokens.reasoning > 0 ? tokens.reasoning : undefined,
    webSearchCount: state.webSearchCount > 0 ? state.webSearchCount : undefined,
  };
}
