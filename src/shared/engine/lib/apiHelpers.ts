/**
 * Pure helpers extracted from `APIService` and the per-provider client
 * classes. Phase 4 of the singleton-encapsulation refactor moves the
 * stateless dispatch surface (`extractToolUseBlocks`, `mapStopReason`,
 * `shouldPrependPrefill`) here so callers don't need an `APIService`
 * instance for what is essentially a switch on `apiType`.
 *
 * Two reasons this matters:
 *
 * 1. The frontend `src/utils/toolUseExtractor.ts` re-export needs to call
 *    `extractToolUseBlocks` synchronously on every render. Going through a
 *    full `APIService` instance pulls the storage / toolRegistry / encryption
 *    bundle along — none of which the extractor actually uses.
 *
 * 2. `agenticLoopGenerator` calls these helpers from helper functions that
 *    don't always have an `options.deps.apiService` in scope. Routing them
 *    through a stateless module function lets us drop the
 *    `import { apiService }` line at the top of that file.
 *
 * The bodies are duck-typed against the provider response shapes so this
 * file does not pull in the OpenAI / Anthropic / Bedrock / Google SDK type
 * declarations. The typed class methods on the per-provider clients delegate
 * to these functions so the two views stay in sync.
 */

import type { APIDefinition, APIType, MessageStopReason, ToolUseBlock } from '../../protocol/types';

/**
 * Extract tool_use blocks from provider-specific `fullContent`.
 * Pure dispatch on `apiType`. Each branch implements the same parsing the
 * matching `APIClient.extractToolUseBlocks` instance method does, but
 * without any `this` access so the function works without an instance.
 */
export function extractToolUseBlocks(apiType: APIType, fullContent: unknown): ToolUseBlock[] {
  switch (apiType) {
    case 'chatgpt':
      return extractOpenAIChatCompletionToolBlocks(fullContent);
    case 'anthropic':
      return extractAnthropicToolBlocks(fullContent);
    case 'responses_api':
      return extractOpenAIResponsesToolBlocks(fullContent);
    case 'google':
      return extractGoogleToolBlocks(fullContent);
    case 'bedrock':
      return extractBedrockToolBlocks(fullContent);
    case 'ds01-dummy-system':
      // DUMMY system messages reconstruct from `toolCalls` directly so the
      // raw fullContent never carries provider-shaped tool blocks. Returning
      // empty here mirrors what the singleton `apiService.extractToolUseBlocks`
      // did via the missing-client fallthrough.
      return [];
  }
}

/**
 * Map provider-specific stop reasons to the project's `MessageStopReason`
 * union. The previous home was `APIService.mapStopReason`, but the body is
 * a pure switch on `apiType` and never used `this`.
 */
export function mapStopReason(
  apiType: APIType | undefined,
  stopReason: string | null
): MessageStopReason {
  if (!stopReason) return 'end_turn';

  if (apiType === 'google') {
    switch (stopReason) {
      case 'STOP':
      case 'tool_use':
        return 'end_turn';
      case 'MAX_TOKENS':
        return 'max_tokens';
      default:
        return stopReason as MessageStopReason;
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
        return stopReason as MessageStopReason;
    }
  }

  // OpenAI / Responses API uses: stop, length, content_filter, tool_calls
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
      return stopReason as MessageStopReason;
  }
}

/**
 * Whether the provider needs a synthetic prefill turn injected when the
 * caller supplies a `preFillResponse`. Today only Anthropic returns true;
 * the other clients all return `false` and ignore the `apiDefinition`
 * argument. Kept stable so the agentic loop can stay provider-agnostic.
 */
export function shouldPrependPrefill(apiDefinition: APIDefinition): boolean {
  return apiDefinition.apiType === 'anthropic';
}

// ----------------------------------------------------------------------------
// Per-provider extractor implementations
//
// Each branch mirrors the `extractToolUseBlocks` instance method on the
// matching client. Whenever you touch one of these, also update the class
// method on the relevant client (or, better, have the class method delegate
// to the function below — Phase 4 follow-up).
// ----------------------------------------------------------------------------

/** OpenAI Chat Completions: tool_calls live on `message.tool_calls[]`. */
function extractOpenAIChatCompletionToolBlocks(fullContent: unknown): ToolUseBlock[] {
  if (fullContent && typeof fullContent === 'object' && !Array.isArray(fullContent)) {
    const msg = fullContent as {
      tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
    };
    if (msg.tool_calls && msg.tool_calls.length > 0) {
      return msg.tool_calls.map(tc => ({
        type: 'tool_use' as const,
        id: tc.id,
        name: tc.function.name,
        input: JSON.parse(tc.function.arguments || '{}'),
      }));
    }
    return [];
  }

  // Legacy array format for backward compatibility with persisted records.
  if (!Array.isArray(fullContent)) return [];

  for (const block of fullContent as Array<Record<string, unknown>>) {
    if (block.type === 'tool_calls' && Array.isArray(block.tool_calls)) {
      return (block.tool_calls as Array<Record<string, unknown>>).map(tc => ({
        type: 'tool_use' as const,
        id: tc.id as string,
        name: (tc.function as Record<string, unknown>)?.name as string,
        input: JSON.parse(((tc.function as Record<string, unknown>)?.arguments as string) || '{}'),
      }));
    }
  }
  return [];
}

/** Anthropic Messages API: tool_use blocks are inline content blocks. */
function extractAnthropicToolBlocks(fullContent: unknown): ToolUseBlock[] {
  if (!Array.isArray(fullContent)) return [];
  return fullContent
    .filter((block: Record<string, unknown>) => block.type === 'tool_use')
    .map((block: Record<string, unknown>) => ({
      type: 'tool_use' as const,
      id: block.id as string,
      name: block.name as string,
      input: (block.input as Record<string, unknown>) || {},
    }));
}

/**
 * OpenAI Responses API: function calls are top-level items with
 * `type: 'function_call'`. The `call_id` field is what tools match against,
 * not `id`.
 */
function extractOpenAIResponsesToolBlocks(fullContent: unknown): ToolUseBlock[] {
  if (!Array.isArray(fullContent)) return [];
  const toolUseBlocks: ToolUseBlock[] = [];
  for (const item of fullContent as Array<Record<string, unknown>>) {
    if (item.type === 'function_call') {
      toolUseBlocks.push({
        type: 'tool_use' as const,
        id: item.call_id as string,
        name: item.name as string,
        input: JSON.parse((item.arguments as string) || '{}'),
      });
    }
  }
  return toolUseBlocks;
}

/** Google Gemini: function calls live on `Part.functionCall`. */
function extractGoogleToolBlocks(fullContent: unknown): ToolUseBlock[] {
  if (!Array.isArray(fullContent)) return [];
  const blocks: ToolUseBlock[] = [];
  for (const part of fullContent as Array<{
    functionCall?: { id?: string; name?: string; args?: unknown };
  }>) {
    if (part.functionCall?.name) {
      blocks.push({
        type: 'tool_use',
        id: part.functionCall.id!,
        name: part.functionCall.name,
        input: (part.functionCall.args as Record<string, unknown>) ?? {},
      });
    }
  }
  return blocks;
}

/** Bedrock Converse API: tool uses live inside `block.toolUse`. */
function extractBedrockToolBlocks(fullContent: unknown): ToolUseBlock[] {
  if (!Array.isArray(fullContent)) return [];
  const blocks: ToolUseBlock[] = [];
  for (const block of fullContent as Array<{
    toolUse?: { toolUseId?: string; name?: string; input?: unknown };
  }>) {
    if (block.toolUse) {
      blocks.push({
        type: 'tool_use',
        id: block.toolUse.toolUseId!,
        name: block.toolUse.name!,
        input: (block.toolUse.input as Record<string, unknown>) || {},
      });
    }
  }
  return blocks;
}
