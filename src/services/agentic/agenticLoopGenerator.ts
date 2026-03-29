/**
 * Generator-based Agentic Loop
 *
 * A pure async generator that yields events during execution and returns
 * a final result. The consumer handles persistence and UI updates.
 *
 * Design principles:
 * - Chat/Project agnostic: receives flat options, not entities
 * - Generator pattern: yields events instead of callbacks
 * - Single context array: no separate message buffer
 * - Supports suspension: tools can break the loop for external input
 * - Read-only storage access: reads attachments, writes nothing
 */

import { apiService } from '../api/apiService';
import { calculateCost, isCostUnreliable } from '../api/modelMetadata';
import { storage } from '../storage';
import { StreamingContentAssembler } from '../streaming/StreamingContentAssembler';
import { executeClientSideTool, toolRegistry } from '../tools/clientSideTools';
import type {
  APIDefinition,
  APIType,
  Message,
  MessageAttachment,
  Model,
  RenderingBlockGroup,
  ToolOptions,
  ToolResult,
  ToolResultBlock,
  ToolStreamEvent,
  ToolUseBlock,
  ReasoningEffort,
  ReasoningSummary,
  TokenTotals,
} from '../../types';
import { type ToolResultRenderBlock, type ToolUseRenderBlock } from '../../types/content';
import { generateUniqueId } from '../../utils/idGenerator';
import { createTokenTotals, addTokens, hasTokenUsage } from '../../utils/tokenTotals';
import { DummyHookRuntime, type HookInput, type HookInputMessage } from './dummyHookRuntime';

// ============================================================================
// Constants
// ============================================================================

const MAX_ITERATIONS = 999;

/** Rounds after deferred return capture before injecting "please stop" messages */
const DEFERRED_SOFT_STOP_ROUNDS = 5;
/** Rounds after deferred return capture before force-stopping the loop */
const DEFERRED_FORCE_STOP_ROUNDS = 10;

/** Maps checkpoint tidy option IDs to tool names */
const TIDY_OPTION_TO_TOOL: Record<string, string> = {
  tidyFilesystem: 'filesystem',
  tidyMemory: 'memory',
  tidyJavascript: 'javascript',
  tidyMinion: 'minion',
  tidySketchbook: 'sketchbook',
  tidyCheckpoint: 'checkpoint',
};

/** Legacy option IDs for backward compatibility with persisted toolOptions */
const LEGACY_SWIPE_TO_TIDY: Record<string, string> = {
  swipeFilesystem: 'tidyFilesystem',
  swipeMemory: 'tidyMemory',
  swipeJavascript: 'tidyJavascript',
  swipeMinion: 'tidyMinion',
  swipeSketchbook: 'tidySketchbook',
  swipeCheckpoint: 'tidyCheckpoint',
};

// ============================================================================
// Types
// ============================================================================

/**
 * Flat configuration for the agentic loop.
 * Consumer builds this via buildAgenticLoopOptions() from Chat/Project.
 */
export interface AgenticLoopOptions {
  // API
  apiDef: APIDefinition;
  model: Model;

  // Context IDs (for tools, chatId optional for standalone/sub-agent)
  projectId: string;
  chatId?: string;

  // Stream settings (flattened from Project)
  temperature?: number;
  maxTokens: number;
  systemPrompt?: string;
  preFillResponse?: string;
  webSearchEnabled: boolean;
  enabledTools: string[];
  toolOptions: Record<string, ToolOptions>;
  disableStream: boolean;
  extendedContext: boolean;
  noLineNumbers?: boolean;

  // VFS namespace for isolated minion personas
  namespace?: string;

  // Anthropic reasoning
  enableReasoning: boolean;
  reasoningBudgetTokens: number;
  thinkingKeepTurns?: number;

  // OpenAI/Responses reasoning
  reasoningEffort?: ReasoningEffort;
  reasoningSummary?: ReasoningSummary;

  // Pre-existing tool_use blocks to execute before the first API call
  // (used by resolvePendingToolCalls to delegate tool execution with streaming)
  pendingToolUseBlocks?: ToolUseBlock[];
  // Already-saved messages to inject into context after pending tool results
  // (e.g., a user follow-up message saved by the caller)
  pendingTrailingContext?: Message<unknown>[];

  // How the return tool interacts with the agentic loop:
  // - 'no' / undefined: return breaks the loop immediately
  // - 'auto-ack': return stores result, appends assistant ack message, then breaks the loop
  // - 'free-run': return stores result without breaking the loop (old deferred mode)
  deferReturn?: 'no' | 'auto-ack' | 'free-run';

  // When true, extract tool_use blocks from content even when stopReason !== 'tool_use'.
  // Third-party APIs may return wrong stopReason; this prevents early exit when tools are present.
  fallbackToolExtraction?: boolean;

  // Configurable deferred return wind-down thresholds (free-run only)
  deferredSoftStopRounds?: number;
  deferredForceStopRounds?: number;

  // Configurable return tool messages
  returnAckMessage?: string;
  returnDuplicateMessage?: string;

  // Assistant text appended after auto-ack return (put in model's mouth)
  autoAckMessage?: string;

  // Checkpoint message IDs from previous checkpoints — enables context tidy
  checkpointMessageIds?: string[];

  // Soft stop: checked at tool boundaries, returns soft_stopped when true
  shouldStop?: () => boolean;

  // DUMMY System: active hook file name (loaded from /hooks/<name>.js on VFS)
  activeHook?: string;
}

/**
 * Events yielded during loop execution.
 */
export type AgenticLoopEvent =
  | { type: 'streaming_start' }
  | { type: 'streaming_chunk'; groups: RenderingBlockGroup[] }
  | { type: 'streaming_end' }
  | { type: 'message_created'; message: Message<unknown> }
  | { type: 'tokens_consumed'; tokens: TokenTotals; isToolCost?: boolean }
  | { type: 'first_chunk' }
  | { type: 'pending_tool_result'; message: Message<unknown> }
  | {
      type: 'tool_block_update';
      toolUseId: string;
      block: Partial<ToolResultRenderBlock>;
    }
  | { type: 'checkpoint_set'; messageId: string }
  | { type: 'dummy_hook_start'; hookName: string }
  | { type: 'dummy_hook_end'; result: 'passthrough' | 'user_stop' | 'intercepted' }
  | { type: 'active_hook_changed'; hookName: string | null }
  | { type: 'chat_metadata_updated'; name?: string; summary?: string };

/**
 * Final result returned when loop completes.
 */
export type AgenticLoopResult =
  | {
      status: 'complete';
      messages: Message<unknown>[];
      tokens: TokenTotals;
      hasCoT?: boolean;
      returnValue?: string;
    }
  | {
      status: 'error';
      messages: Message<unknown>[];
      tokens: TokenTotals;
      hasCoT?: boolean;
      error: Error;
    }
  | {
      status: 'max_iterations';
      messages: Message<unknown>[];
      tokens: TokenTotals;
      hasCoT?: boolean;
      returnValue?: string;
    }
  | {
      status: 'soft_stopped';
      stopPoint: 'before_tools' | 'after_tools';
      messages: Message<unknown>[];
      tokens: TokenTotals;
      hasCoT?: boolean;
      returnValue?: string;
    };

// Re-export for backward compatibility
export { createTokenTotals, addTokens } from '../../utils/tokenTotals';
export type { TokenTotals } from '../../types/content';

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Derive the set of tool names to tidy from checkpoint tool options.
 * Options default to true (tidy enabled) when not explicitly set.
 * Also checks legacy swipe* keys for backward compatibility with persisted data.
 */
function deriveTidyToolNames(toolOptions: Record<string, ToolOptions>): Set<string> | undefined {
  const checkpointOpts = toolOptions.checkpoint;
  if (!checkpointOpts) return undefined;

  const names = new Set<string>();
  for (const [optId, toolName] of Object.entries(TIDY_OPTION_TO_TOOL)) {
    // Check new tidy* key first, then fall back to legacy swipe* key
    const legacyKey = Object.entries(LEGACY_SWIPE_TO_TIDY).find(([, v]) => v === optId)?.[0];
    const enabled =
      checkpointOpts[optId] !== false && (legacyKey ? checkpointOpts[legacyKey] !== false : true);
    if (enabled) names.add(toolName);
  }
  return names.size > 0 ? names : undefined;
}

/**
 * Merge tool_use input from fullContent into renderingContent.
 * Fixes streaming providers (like OpenRouter) that don't stream tool arguments.
 */
function mergeToolUseInputFromFullContent(
  groups: RenderingBlockGroup[],
  fullContent: unknown,
  apiType: APIType
): void {
  const toolUseBlocks = apiService.extractToolUseBlocks(apiType, fullContent);
  if (toolUseBlocks.length === 0) return;

  const inputMap = new Map<string, Record<string, unknown>>();
  for (const toolBlock of toolUseBlocks) {
    inputMap.set(toolBlock.id, toolBlock.input);
  }

  const existingIds = new Set<string>();
  for (const group of groups) {
    for (const block of group.blocks) {
      if (block.type === 'tool_use') {
        const toolUseBlock = block as ToolUseRenderBlock;
        existingIds.add(toolUseBlock.id);
        const correctInput = inputMap.get(toolUseBlock.id);
        if (correctInput && Object.keys(toolUseBlock.input).length === 0) {
          toolUseBlock.input = correctInput;
        }
      }
    }
  }

  // Recover tool_use blocks that the streaming assembler missed entirely
  for (const toolBlock of toolUseBlocks) {
    if (!existingIds.has(toolBlock.id)) {
      const newBlock: ToolUseRenderBlock = {
        type: 'tool_use',
        id: toolBlock.id,
        name: toolBlock.name,
        input: toolBlock.input,
      };
      const lastGroup = groups[groups.length - 1];
      if (lastGroup?.category === 'backstage') {
        lastGroup.blocks.push(newBlock);
      } else {
        groups.push({ category: 'backstage', blocks: [newBlock] });
      }
    }
  }
}

/**
 * Populate rendered fields on tool blocks for display persistence.
 */
function populateToolRenderFields(groups: RenderingBlockGroup[]): void {
  for (const group of groups) {
    for (const block of group.blocks) {
      if (block.type === 'tool_use') {
        const toolUseBlock = block as ToolUseRenderBlock;
        const tool = toolRegistry.get(toolUseBlock.name);
        if (tool) {
          const hasInput = Object.keys(toolUseBlock.input).length > 0;
          toolUseBlock.icon = tool.iconInput ?? '🔧';
          toolUseBlock.renderedInput = hasInput
            ? (tool.renderInput?.(toolUseBlock.input) ??
              JSON.stringify(toolUseBlock.input, null, 2))
            : '';
        }
      }
    }
  }
}

// ============================================================================
// DUMMY System Types & Helpers
// ============================================================================

/**
 * Return type for DUMMY System hook functions.
 * - undefined: pass through to model API
 * - 'user': stop the loop, hand control to user
 * - object: synthetic assistant response
 */
export type DummyHookResult =
  | undefined
  | 'user'
  | {
      text: string;
      toolCalls?: { id?: string; name: string; input: Record<string, unknown> }[];
      brief?: string;
    };

/**
 * Build a synthetic assistant message for DUMMY System hook interceptions.
 * Uses 'ds01-dummy-system' modelFamily so API clients reconstruct via toolCalls/toolResults.
 */
function buildDummyAssistantMessage(
  text: string,
  toolCalls?: { id?: string; name: string; input: Record<string, unknown> }[],
  brief?: string
): Message<unknown> {
  // Generate IDs for tool calls missing them
  const resolvedToolCalls: ToolUseBlock[] | undefined = toolCalls?.map(tc => ({
    type: 'tool_use' as const,
    id: tc.id || generateUniqueId('toolu'),
    name: tc.name,
    input: tc.input,
  }));

  // Build rendering content
  const renderingContent: RenderingBlockGroup[] = [];
  if (text.trim()) {
    renderingContent.push({
      category: 'text',
      blocks: [{ type: 'text', text }],
    });
  }
  if (resolvedToolCalls?.length) {
    const toolUseRenderBlocks: ToolUseRenderBlock[] = resolvedToolCalls.map(tc => ({
      type: 'tool_use' as const,
      id: tc.id,
      name: tc.name,
      input: tc.input,
    }));
    renderingContent.push({
      category: 'backstage',
      blocks: toolUseRenderBlocks,
    });
  }

  populateToolRenderFields(renderingContent);

  return {
    id: generateUniqueId('msg_assistant'),
    role: 'assistant',
    content: {
      type: 'text',
      content: text,
      modelFamily: 'ds01-dummy-system',
      fullContent: undefined,
      toolCalls: resolvedToolCalls,
      renderingContent,
      stopReason: resolvedToolCalls?.length ? 'tool_use' : 'end_turn',
    },
    timestamp: new Date(),
    metadata: {
      model: 'DUMMY',
      inputTokens: 0,
      outputTokens: 0,
      messageCost: 0,
      contextWindow: 0,
      contextWindowUsage: 0,
      dummyBrief: brief ?? 'intercepted',
    } as Record<string, unknown>,
  };
}

/**
 * Create a tool_result render block with pre-rendered display fields.
 * Optionally accepts renderingGroups from tool's internal work.
 */
function createToolResultRenderBlock(
  toolUseId: string,
  toolName: string,
  content: string,
  isError?: boolean,
  renderingGroups?: RenderingBlockGroup[],
  tokenTotals?: TokenTotals
): ToolResultRenderBlock {
  const tool = toolRegistry.get(toolName);
  return {
    type: 'tool_result',
    tool_use_id: toolUseId,
    content,
    is_error: isError,
    name: toolName,
    icon: isError ? '❌' : (tool?.iconOutput ?? '✅'),
    renderedContent: tool?.renderOutput?.(content, isError) ?? content,
    renderingGroups,
    tokenTotals,
  };
}

/**
 * Extract model-agnostic hook input from the last message in the context.
 */
function extractHookInput(msg: Message<unknown>): HookInput {
  const hookInput: HookInput = {};

  if (msg.content.content?.trim()) {
    hookInput.text = msg.content.content;
  }

  if (msg.content.toolResults?.length) {
    hookInput.toolResults = msg.content.toolResults.map(tr => {
      // Resolve tool name from renderingContent if available
      const name =
        (
          msg.content.renderingContent
            ?.flatMap(g => g.blocks)
            .find(
              b =>
                b.type === 'tool_result' &&
                (b as ToolResultRenderBlock).tool_use_id === tr.tool_use_id
            ) as ToolResultRenderBlock | undefined
        )?.name ?? 'unknown';
      return {
        tool_use_id: tr.tool_use_id,
        name,
        content: tr.content,
        is_error: tr.is_error,
      };
    });
  }

  return hookInput;
}

/**
 * Build condensed history from the last N messages (excluding the final one,
 * which is already represented in hookInput's text/toolResults fields).
 */
export function extractHookHistory(
  messages: Message<unknown>[],
  depth: number
): HookInputMessage[] {
  if (depth <= 0) return [];
  const startIdx = Math.max(0, messages.length - 1 - depth);
  const slice = messages.slice(startIdx, messages.length - 1);
  return slice.map(msg => {
    const entry: HookInputMessage = { id: msg.id, role: msg.role };
    if (msg.content.content?.trim()) entry.text = msg.content.content;
    if (msg.content.toolCalls?.length) {
      entry.toolCalls = msg.content.toolCalls.map(tc => ({
        id: tc.id,
        name: tc.name,
        input: tc.input,
      }));
    }
    if (msg.content.toolResults?.length) {
      entry.toolResults = msg.content.toolResults.map(tr => {
        const name =
          (
            msg.content.renderingContent
              ?.flatMap(g => g.blocks)
              .find(
                b =>
                  b.type === 'tool_result' &&
                  (b as ToolResultRenderBlock).tool_use_id === tr.tool_use_id
              ) as ToolResultRenderBlock | undefined
          )?.name ?? 'unknown';
        return {
          tool_use_id: tr.tool_use_id,
          name,
          content: tr.content,
          ...(tr.is_error ? { is_error: true } : {}),
        };
      });
    }
    return entry;
  });
}

/**
 * Load attachments for all user messages and handle missing attachment notes.
 */
async function loadAttachmentsForMessages(
  messages: Message<unknown>[]
): Promise<(Message<unknown> & { attachments?: MessageAttachment[] })[]> {
  return Promise.all(
    messages.map(async msg => {
      if (
        msg.role === 'user' &&
        (msg.content.attachmentIds?.length || msg.content.originalAttachmentCount)
      ) {
        const attachments = await storage.getAttachments(msg.id);
        const loadedIds = new Set(attachments.map(att => att.id));

        const originalCount =
          msg.content.originalAttachmentCount ?? msg.content.attachmentIds?.length ?? 0;
        const currentCount = attachments.length;
        const missingCount = originalCount - currentCount;

        if (missingCount > 0) {
          const systemNote = `<system-note>${missingCount} attachment(s) removed to save space.</system-note>\n\n`;
          return {
            ...msg,
            content: {
              ...msg.content,
              content: systemNote + msg.content.content,
              attachmentIds: (msg.content.attachmentIds ?? []).filter(id => loadedIds.has(id)),
            },
            attachments,
          };
        }

        return { ...msg, attachments };
      }
      return msg;
    })
  );
}

/**
 * Extract tokens from stream result and calculate cost.
 */
function extractIterationTokens(
  result: {
    inputTokens?: number;
    outputTokens?: number;
    reasoningTokens?: number;
    cacheCreationTokens?: number;
    cacheReadTokens?: number;
    webSearchCount?: number;
  },
  model: Model
): TokenTotals {
  const inputTokens = result.inputTokens ?? 0;
  const outputTokens = result.outputTokens ?? 0;
  const reasoningTokens = result.reasoningTokens ?? 0;
  const cacheCreationTokens = result.cacheCreationTokens ?? 0;
  const cacheReadTokens = result.cacheReadTokens ?? 0;
  const webSearchCount = result.webSearchCount ?? 0;

  const cost = calculateCost(
    model,
    inputTokens,
    outputTokens,
    reasoningTokens,
    cacheCreationTokens,
    cacheReadTokens,
    webSearchCount
  );

  const costUnreliable = isCostUnreliable(
    model,
    inputTokens,
    outputTokens,
    reasoningTokens,
    cacheCreationTokens,
    cacheReadTokens,
    webSearchCount
  );

  return {
    inputTokens,
    outputTokens,
    reasoningTokens,
    cacheCreationTokens,
    cacheReadTokens,
    webSearchCount,
    cost,
    costUnreliable,
  };
}

/**
 * Build assistant message from stream result.
 */
function buildAssistantMessage(
  result: {
    textContent: string;
    fullContent: unknown;
    stopReason?: string;
    error?: { message: string; status?: number; stack?: string };
  },
  assembler: StreamingContentAssembler,
  apiType: APIType,
  modelId: string,
  iterTokens: TokenTotals
): Message<unknown> {
  const { renderingContent, stopReason } = result.error
    ? {
        renderingContent: assembler.finalizeWithError(result.error),
        stopReason: 'error' as const,
      }
    : {
        renderingContent: assembler.finalize(),
        stopReason: apiService.mapStopReason(apiType, result.stopReason ?? null),
      };

  // Merge tool inputs and populate render fields
  if (!result.error) {
    mergeToolUseInputFromFullContent(renderingContent, result.fullContent, apiType);
  }
  populateToolRenderFields(renderingContent);

  const contextWindowUsage =
    iterTokens.inputTokens +
    iterTokens.outputTokens +
    iterTokens.cacheCreationTokens +
    iterTokens.cacheReadTokens;

  // Extract model-agnostic tool_use blocks for cross-model reconstruction
  const extractedToolCalls = apiService.extractToolUseBlocks(apiType, result.fullContent);

  return {
    id: generateUniqueId('msg_assistant'),
    role: 'assistant',
    content: {
      type: 'text',
      content: result.textContent,
      modelFamily: apiType,
      fullContent: result.fullContent,
      toolCalls: extractedToolCalls.length > 0 ? extractedToolCalls : undefined,
      renderingContent,
      stopReason,
    },
    timestamp: new Date(),
    metadata: {
      model: modelId,
      inputTokens: iterTokens.inputTokens,
      outputTokens: iterTokens.outputTokens,
      reasoningTokens: iterTokens.reasoningTokens > 0 ? iterTokens.reasoningTokens : undefined,
      cacheCreationTokens: iterTokens.cacheCreationTokens,
      cacheReadTokens: iterTokens.cacheReadTokens,
      webSearchCount: iterTokens.webSearchCount > 0 ? iterTokens.webSearchCount : undefined,
      messageCost: iterTokens.cost,
      contextWindow: 0, // Consumer should fill from model
      contextWindowUsage,
      costUnreliable: iterTokens.costUnreliable || undefined,
    },
  };
}

/**
 * Build tool result message from executed tools.
 */
function buildToolResultMessage(
  apiType: APIType,
  toolResults: ToolResultBlock[],
  toolResultRenderBlocks: ToolResultRenderBlock[]
): Message<unknown> {
  const toolResultMessage: Message<unknown> = {
    id: generateUniqueId('msg_user'),
    role: 'user',
    content: {
      type: 'text',
      content: '',
      modelFamily: apiType,
    },
    timestamp: new Date(),
  };

  toolResultMessage.content.toolResults = toolResults;

  toolResultMessage.content.renderingContent = [
    { category: 'backstage' as const, blocks: toolResultRenderBlocks },
  ];

  return toolResultMessage;
}

// ============================================================================
// Tool Execution Helper
// ============================================================================

interface ToolContext {
  projectId: string;
  chatId?: string;
  namespace?: string;
}

interface ActiveToolGen {
  toolUse: ToolUseBlock;
  gen: AsyncGenerator<ToolStreamEvent, ToolResult, void>;
  pendingNext: Promise<{ index: number; result: IteratorResult<ToolStreamEvent, ToolResult> }>;
  done: boolean;
  index: number;
}

/**
 * Error-safe wrapper for generator .next().
 * Converts thrown errors into a done result with isError ToolResult.
 */
function safeGenNext(
  ag: ActiveToolGen
): Promise<{ index: number; result: IteratorResult<ToolStreamEvent, ToolResult> }> {
  return ag.gen.next().then(
    result => ({ index: ag.index, result }),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[agenticLoopGen] Tool generator threw:', ag.toolUse.name, message);
      return {
        index: ag.index,
        result: {
          done: true as const,
          value: { content: `Tool execution failed: ${message}`, isError: true },
        },
      };
    }
  );
}

/** Result from executeToolsParallel for a single tool */
interface ParallelToolResult {
  toolResult: ToolResultBlock;
  renderBlock: ToolResultRenderBlock;
}

/**
 * Execute a subset of tool_use blocks in parallel with streaming support.
 * Yields running/streaming/complete block updates.
 * Returns results indexed by position in the input array, plus any breakLoop.
 */
async function* executeToolsParallel(
  blocks: ToolUseBlock[],
  enabledTools: string[],
  toolOptions: Record<string, ToolOptions>,
  toolContext: ToolContext
): AsyncGenerator<
  AgenticLoopEvent,
  {
    results: ParallelToolResult[];
    breakLoop?: { returnValue?: string };
    checkpoint?: boolean;
    activeHook?: string | null;
    chatMetadata?: { name?: string; summary?: string };
  },
  void
> {
  const activeGens: ActiveToolGen[] = blocks.map((toolUse, index) => {
    console.debug('[agenticLoopGen] Starting tool:', toolUse.name, 'id:', toolUse.id);
    const gen = executeClientSideTool(
      toolUse.name,
      toolUse.input,
      enabledTools,
      toolOptions,
      toolContext
    );
    return { toolUse, gen, pendingNext: null!, done: false, index };
  });

  // Mark all tools as running upfront
  for (const ag of activeGens) {
    yield {
      type: 'tool_block_update',
      toolUseId: ag.toolUse.id,
      block: { status: 'running' as const },
    };
  }

  // Kick off first .next() for each generator, with per-tool-name stagger
  const toolStartCount = new Map<string, number>();
  for (const ag of activeGens) {
    const throttleMs = toolRegistry.get(ag.toolUse.name)?.parallelThrottleMs;
    if (throttleMs) {
      const count = toolStartCount.get(ag.toolUse.name) ?? 0;
      if (count > 0) {
        console.debug(
          '[agenticLoopGen] Throttling',
          ag.toolUse.name,
          'launch by',
          throttleMs,
          'ms'
        );
        await new Promise(resolve => setTimeout(resolve, throttleMs));
      }
      toolStartCount.set(ag.toolUse.name, count + 1);
    }
    ag.pendingNext = safeGenNext(ag);
  }

  const results: (ParallelToolResult | null)[] = new Array(blocks.length).fill(null);
  let breakLoop: { returnValue?: string } | undefined;
  let checkpointSet = false;
  let activeHookChanged: string | null | undefined;
  let chatMetadata: { name?: string; summary?: string } | undefined;

  // Race loop: process events from whichever generator resolves first
  while (activeGens.some(ag => !ag.done)) {
    const activePending = activeGens.filter(ag => !ag.done).map(ag => ag.pendingNext);
    const resolved = await Promise.race(activePending);
    const ag = activeGens[resolved.index];

    if (resolved.result.done) {
      ag.done = true;
      const toolResult = resolved.result.value;

      if (toolResult.breakLoop && !breakLoop) {
        breakLoop = toolResult.breakLoop;
      }
      if (toolResult.checkpoint) checkpointSet = true;
      if (toolResult.activeHook !== undefined) activeHookChanged = toolResult.activeHook;
      if (toolResult.chatMetadata) {
        chatMetadata = { ...chatMetadata, ...toolResult.chatMetadata };
      }

      const renderBlock = createToolResultRenderBlock(
        ag.toolUse.id,
        ag.toolUse.name,
        toolResult.content,
        toolResult.isError,
        toolResult.renderingGroups,
        toolResult.tokenTotals
      );
      renderBlock.status = toolResult.isError ? 'error' : 'complete';

      results[ag.index] = {
        toolResult: {
          type: 'tool_result',
          tool_use_id: ag.toolUse.id,
          name: ag.toolUse.name,
          content: toolResult.content,
          is_error: toolResult.isError,
        },
        renderBlock,
      };

      yield {
        type: 'tool_block_update',
        toolUseId: ag.toolUse.id,
        block: renderBlock,
      };
    } else {
      const event = resolved.result.value as ToolStreamEvent;
      if (event.type === 'groups_update') {
        yield {
          type: 'tool_block_update',
          toolUseId: ag.toolUse.id,
          block: { renderingGroups: event.groups, status: 'running' as const },
        };
      }
      ag.pendingNext = safeGenNext(ag);
    }
  }

  return {
    results: results.filter((r): r is ParallelToolResult => r !== null),
    breakLoop,
    checkpoint: checkpointSet || undefined,
    activeHook: activeHookChanged,
    chatMetadata,
  };
}

/**
 * Execute tool_use blocks with phased execution and return-tool error handling.
 *
 * Phases:
 * 1. If `return` appears alongside other tools, produce an error result for it
 *    and execute the remaining tools normally (loop continues).
 * 2. Simple tools (no `complex` flag) run first.
 * 3. Complex tools (e.g., minion) run after simple tools complete.
 *
 * Yields pending/running/complete events and pushes the final tool result message to `messages`.
 * Returns breakLoop info if a return tool was invoked solo, undefined otherwise.
 */
async function* executeToolUseBlocks(
  toolUseBlocks: ToolUseBlock[],
  apiType: APIType,
  enabledTools: string[],
  toolOptions: Record<string, ToolOptions>,
  toolContext: ToolContext,
  messages: Message<unknown>[],
  totals: TokenTotals,
  deferReturn?: 'no' | 'auto-ack' | 'free-run',
  hasStoredReturn?: boolean,
  returnAckMessage?: string,
  returnDuplicateMessage?: string,
  autoAckMessage?: string
): AsyncGenerator<
  AgenticLoopEvent,
  | { breakLoop: { returnValue?: string } }
  | { deferredReturn: string }
  | { checkpoint: true }
  | { activeHook: string | null }
  | undefined,
  void
> {
  console.debug('[agenticLoopGen] Executing', toolUseBlocks.length, 'tool(s)');

  // --- Return tool handling ---
  // If return is the ONLY tool, execute it directly (preserves breakLoop behavior).
  const returnToolIndex = toolUseBlocks.findIndex(b => b.name === 'return');
  if (returnToolIndex !== -1 && toolUseBlocks.length === 1) {
    const returnBlock = toolUseBlocks[0];

    // Reject duplicate deferred/auto-ack return calls without executing the tool
    if ((deferReturn === 'auto-ack' || deferReturn === 'free-run') && hasStoredReturn) {
      const errorContent =
        returnDuplicateMessage ??
        'The previous return has been recorded already. Please stop and user will call back.';
      const renderBlock = createToolResultRenderBlock(
        returnBlock.id,
        returnBlock.name,
        errorContent,
        true
      );
      renderBlock.status = 'error';

      const toolResultBlocks: ToolResultBlock[] = [
        {
          type: 'tool_result',
          tool_use_id: returnBlock.id,
          name: returnBlock.name,
          content: errorContent,
          is_error: true,
        },
      ];
      const toolResultMsg = buildToolResultMessage(apiType, toolResultBlocks, [renderBlock]);
      messages.push(toolResultMsg);
      yield { type: 'message_created', message: toolResultMsg };

      return undefined;
    }

    const gen = executeClientSideTool(
      returnBlock.name,
      returnBlock.input,
      enabledTools,
      toolOptions,
      toolContext
    );
    let iterResult = await gen.next();
    while (!iterResult.done) iterResult = await gen.next();
    const toolResult = iterResult.value;

    if (deferReturn === 'auto-ack' || deferReturn === 'free-run') {
      const returnValue = toolResult.breakLoop?.returnValue ?? toolResult.content;
      const storedContent = returnAckMessage ?? 'Recorded. Stop and user will call you back.';

      const renderBlock = createToolResultRenderBlock(
        returnBlock.id,
        returnBlock.name,
        storedContent,
        false
      );
      renderBlock.status = 'complete';

      const toolResultBlocks: ToolResultBlock[] = [
        {
          type: 'tool_result',
          tool_use_id: returnBlock.id,
          name: returnBlock.name,
          content: storedContent,
        },
      ];

      const toolResultMsg = buildToolResultMessage(apiType, toolResultBlocks, [renderBlock]);
      messages.push(toolResultMsg);
      yield { type: 'message_created', message: toolResultMsg };

      if (deferReturn === 'auto-ack') {
        // Auto-ack: append synthetic assistant message, then break
        const ackText = autoAckMessage || 'Will do.';
        const assistantMsg: Message<unknown> = {
          id: generateUniqueId('msg_assistant'),
          role: 'assistant',
          content: {
            type: 'text',
            content: ackText,
            modelFamily: apiType,
            fullContent: undefined,
            renderingContent: [{ category: 'text', blocks: [{ type: 'text', text: ackText }] }],
          },
          timestamp: new Date(),
        };
        messages.push(assistantMsg);
        yield { type: 'message_created', message: assistantMsg };
        return { breakLoop: { returnValue } };
      }

      // Free-run: store value, continue loop
      return { deferredReturn: returnValue };
    }

    return { breakLoop: toolResult.breakLoop ?? { returnValue: toolResult.content } };
  }

  // Separate return tool from executable tools
  let returnPreResult: ParallelToolResult | undefined;
  let deferredReturnValue: string | undefined;
  let executableBlocks = toolUseBlocks;

  if (returnToolIndex !== -1) {
    const returnBlock = toolUseBlocks[returnToolIndex];
    executableBlocks = toolUseBlocks.filter((_, i) => i !== returnToolIndex);

    if (deferReturn === 'auto-ack' || deferReturn === 'free-run') {
      if (hasStoredReturn) {
        // Duplicate deferred/auto-ack — error (same as solo duplicate above)
        console.debug('[agenticLoopGen] Duplicate deferred return in parallel — error');
        const errorContent =
          returnDuplicateMessage ??
          'The previous return has been recorded already. Please stop and user will call back.';
        const renderBlock = createToolResultRenderBlock(
          returnBlock.id,
          returnBlock.name,
          errorContent,
          true
        );
        renderBlock.status = 'error';
        returnPreResult = {
          toolResult: {
            type: 'tool_result',
            tool_use_id: returnBlock.id,
            name: returnBlock.name,
            content: errorContent,
            is_error: true,
          },
          renderBlock,
        };
      } else {
        // Execute return tool directly, store value
        console.debug('[agenticLoopGen] Deferred return in parallel — executing and storing');
        const gen = executeClientSideTool(
          returnBlock.name,
          returnBlock.input,
          enabledTools,
          toolOptions,
          toolContext
        );
        let iterResult = await gen.next();
        while (!iterResult.done) iterResult = await gen.next();
        const toolResult = iterResult.value;
        deferredReturnValue = toolResult.breakLoop?.returnValue ?? toolResult.content;

        const storedContent = returnAckMessage ?? 'Recorded. Stop and user will call you back.';
        const renderBlock = createToolResultRenderBlock(
          returnBlock.id,
          returnBlock.name,
          storedContent,
          false
        );
        renderBlock.status = 'complete';
        returnPreResult = {
          toolResult: {
            type: 'tool_result',
            tool_use_id: returnBlock.id,
            name: returnBlock.name,
            content: storedContent,
          },
          renderBlock,
        };
      }
    } else {
      // Non-deferred parallel — ERROR
      console.debug('[agenticLoopGen] Return tool in parallel batch — sending error result');
      const errorContent =
        'ERROR: return cannot be called in parallel with other tools. Please try again with return as the only tool call.';
      const renderBlock = createToolResultRenderBlock(
        returnBlock.id,
        returnBlock.name,
        errorContent,
        true
      );
      renderBlock.status = 'error';
      returnPreResult = {
        toolResult: {
          type: 'tool_result',
          tool_use_id: returnBlock.id,
          name: returnBlock.name,
          content: errorContent,
          is_error: true,
        },
        renderBlock,
      };
    }
  }

  // --- Classify into simple vs complex ---
  const simpleBlocks: ToolUseBlock[] = [];
  const complexBlocks: ToolUseBlock[] = [];
  for (const block of executableBlocks) {
    if (toolRegistry.get(block.name)?.complex) {
      complexBlocks.push(block);
    } else {
      simpleBlocks.push(block);
    }
  }

  if (complexBlocks.length > 0 && simpleBlocks.length > 0) {
    console.debug(
      '[agenticLoopGen] Phased execution:',
      simpleBlocks.length,
      'simple,',
      complexBlocks.length,
      'complex'
    );
  }

  // --- Create pending blocks for ALL tools (in original order) ---
  const pendingRenderBlocks: ToolResultRenderBlock[] = toolUseBlocks.map(toolUse => ({
    type: 'tool_result' as const,
    tool_use_id: toolUse.id,
    name: toolUse.name,
    content: '',
    status: 'pending' as const,
    icon: toolRegistry.get(toolUse.name)?.iconOutput ?? '⏳',
  }));

  const pendingToolResults: ToolResultBlock[] = toolUseBlocks.map(toolUse => ({
    type: 'tool_result' as const,
    tool_use_id: toolUse.id,
    name: toolUse.name,
    content: '',
  }));
  const pendingMsg = buildToolResultMessage(apiType, pendingToolResults, pendingRenderBlocks);
  yield { type: 'pending_tool_result', message: pendingMsg };

  // --- Yield return pre-result block update immediately ---
  if (returnPreResult) {
    yield {
      type: 'tool_block_update',
      toolUseId: returnPreResult.renderBlock.tool_use_id,
      block: returnPreResult.renderBlock,
    };
  }

  // --- Collect results keyed by tool_use_id for final merge ---
  const resultMap = new Map<string, ParallelToolResult>();
  if (returnPreResult) {
    resultMap.set(returnPreResult.toolResult.tool_use_id, returnPreResult);
  }

  let breakLoopResult: { returnValue?: string } | undefined;
  let checkpointSet = false;
  let activeHookChanged: string | null | undefined;
  let chatMetadata: { name?: string; summary?: string } | undefined;

  // --- Phase 1: simple tools ---
  if (simpleBlocks.length > 0) {
    const phase1 = yield* executeToolsParallel(
      simpleBlocks,
      enabledTools,
      toolOptions,
      toolContext
    );
    for (const r of phase1.results) {
      resultMap.set(r.toolResult.tool_use_id, r);
    }
    if (phase1.breakLoop) {
      breakLoopResult = phase1.breakLoop;
    }
    if (phase1.checkpoint) checkpointSet = true;
    if (phase1.activeHook !== undefined) activeHookChanged = phase1.activeHook;
    if (phase1.chatMetadata) chatMetadata = { ...chatMetadata, ...phase1.chatMetadata };
  }

  // --- Phase 2: complex tools (skip if phase 1 triggered breakLoop) ---
  if (complexBlocks.length > 0 && !breakLoopResult) {
    const phase2 = yield* executeToolsParallel(
      complexBlocks,
      enabledTools,
      toolOptions,
      toolContext
    );
    for (const r of phase2.results) {
      resultMap.set(r.toolResult.tool_use_id, r);
    }
    if (phase2.breakLoop) {
      breakLoopResult = phase2.breakLoop;
    }
    if (phase2.checkpoint) checkpointSet = true;
    if (phase2.activeHook !== undefined) activeHookChanged = phase2.activeHook;
    if (phase2.chatMetadata) chatMetadata = { ...chatMetadata, ...phase2.chatMetadata };
  }

  if (breakLoopResult) {
    return { breakLoop: breakLoopResult };
  }

  if (checkpointSet) {
    // Don't return immediately — fall through to build the tool result message,
    // then signal checkpoint to the main loop
  }

  // --- Merge results in original tool order ---
  const finalToolResults: ToolResultBlock[] = [];
  const finalRenderBlocks: ToolResultRenderBlock[] = [];
  for (const block of toolUseBlocks) {
    const entry = resultMap.get(block.id);
    if (entry) {
      finalToolResults.push(entry.toolResult);
      finalRenderBlocks.push(entry.renderBlock);
    }
  }

  // Accumulate tool-incurred costs (e.g., minion sub-agent API calls)
  const toolTotals = createTokenTotals();
  for (const rb of finalRenderBlocks) {
    if (rb.tokenTotals) {
      addTokens(toolTotals, rb.tokenTotals);
    }
  }

  // Build final tool result message and yield as message_created
  // (consumer replaces the pending message with this — same ID ensures correct replacement)
  const toolResultMsg = buildToolResultMessage(apiType, finalToolResults, finalRenderBlocks);
  toolResultMsg.id = pendingMsg.id;

  // If tools incurred costs, attach metadata and propagate to loop totals
  if (hasTokenUsage(toolTotals)) {
    toolResultMsg.metadata = {
      inputTokens: toolTotals.inputTokens,
      outputTokens: toolTotals.outputTokens,
      reasoningTokens: toolTotals.reasoningTokens > 0 ? toolTotals.reasoningTokens : undefined,
      cacheCreationTokens: toolTotals.cacheCreationTokens,
      cacheReadTokens: toolTotals.cacheReadTokens,
      messageCost: toolTotals.cost,
      costUnreliable: toolTotals.costUnreliable || undefined,
    };
    addTokens(totals, toolTotals);
    yield { type: 'tokens_consumed', tokens: toolTotals, isToolCost: true };
  }

  messages.push(toolResultMsg);
  yield { type: 'message_created', message: toolResultMsg };

  // Yield chat metadata update event (passive — doesn't affect loop control)
  if (chatMetadata) {
    yield { type: 'chat_metadata_updated', ...chatMetadata };
  }

  if (checkpointSet) {
    return { checkpoint: true };
  }

  if (activeHookChanged !== undefined) {
    return { activeHook: activeHookChanged };
  }

  if (deferredReturnValue !== undefined) {
    if (deferReturn === 'auto-ack') {
      // Auto-ack parallel: append synthetic assistant message, then break
      const ackText = autoAckMessage || 'Will do.';
      const assistantMsg: Message<unknown> = {
        id: generateUniqueId('msg_assistant'),
        role: 'assistant',
        content: {
          type: 'text',
          content: ackText,
          modelFamily: apiType,
          fullContent: undefined,
          renderingContent: [{ category: 'text', blocks: [{ type: 'text', text: ackText }] }],
        },
        timestamp: new Date(),
      };
      messages.push(assistantMsg);
      yield { type: 'message_created', message: assistantMsg };
      return { breakLoop: { returnValue: deferredReturnValue } };
    }
    return { deferredReturn: deferredReturnValue };
  }

  return undefined;
}

// ============================================================================
// Main Generator
// ============================================================================

/**
 * Run the agentic loop as an async generator.
 *
 * @param options - Flat loop configuration
 * @param context - Initial message context (history + new messages)
 * @yields AgenticLoopEvent during execution
 * @returns AgenticLoopResult when complete
 */
export async function* runAgenticLoop(
  options: AgenticLoopOptions,
  context: Message<unknown>[]
): AsyncGenerator<AgenticLoopEvent, AgenticLoopResult, void> {
  const { apiDef, model, projectId, chatId, enabledTools, toolOptions } = options;

  // Gate extended context on whether the effective model actually supports it.
  // Use model.supportsExtendedContext directly — the model object already carries correct metadata
  // from discovery (resolved via baseModelId). Re-resolving by model.id breaks for Bedrock
  // inference profiles whose IDs (e.g. us.anthropic.claude-...) don't match fuzz patterns.
  const effectiveExtendedContext = options.extendedContext && !!model.supportsExtendedContext;

  // Build tool execution context
  const toolContext = {
    projectId,
    chatId,
    namespace: options.namespace,
    noLineNumbers: options.noLineNumbers,
  };

  // Copy to avoid mutating caller's array (React state safety)
  const messages = [...context];
  const totals = createTokenTotals();
  let iteration = 0;
  let storedReturnValue: string | undefined;
  let deferredReturnIteration: number | undefined;
  let loopHasCoT = false;
  let checkpointSet = false;
  const softStopRounds = options.deferredSoftStopRounds ?? DEFERRED_SOFT_STOP_ROUNDS;
  const forceStopRounds = options.deferredForceStopRounds ?? DEFERRED_FORCE_STOP_ROUNDS;
  const checkpointMessageIds = options.checkpointMessageIds
    ? [...options.checkpointMessageIds]
    : [];

  // DUMMY System: load hook runtime if active (mutable — register/unregister can swap at runtime)
  let activeHookName: string | null = options.activeHook ?? null;
  let hookRuntime = activeHookName
    ? await DummyHookRuntime.load(projectId, options.namespace, activeHookName)
    : null;
  const hookContextDepth = (toolOptions.dummy?.hookContextDepth as number) ?? 0;

  try {
    // Handle pre-existing tool_use blocks before the first API call
    if (options.pendingToolUseBlocks?.length) {
      console.debug(
        '[agenticLoopGen] Executing pending tool blocks:',
        options.pendingToolUseBlocks.length
      );
      const breakResult = yield* executeToolUseBlocks(
        options.pendingToolUseBlocks,
        apiDef.apiType,
        enabledTools,
        toolOptions,
        toolContext,
        messages,
        totals,
        options.deferReturn,
        storedReturnValue !== undefined,
        options.returnAckMessage,
        options.returnDuplicateMessage,
        options.autoAckMessage
      );

      if (breakResult && 'deferredReturn' in breakResult) {
        storedReturnValue = breakResult.deferredReturn;
        deferredReturnIteration = 0;
        // Continue loop — don't return yet
      } else if (breakResult && 'checkpoint' in breakResult) {
        checkpointSet = true;
        // Continue loop — checkpoint will be included in final result
      } else if (breakResult && 'activeHook' in breakResult) {
        hookRuntime?.dispose();
        activeHookName = breakResult.activeHook;
        hookRuntime = activeHookName
          ? await DummyHookRuntime.load(projectId, options.namespace, activeHookName)
          : null;
        yield { type: 'active_hook_changed', hookName: activeHookName };
      } else if (breakResult?.breakLoop) {
        if (storedReturnValue !== undefined) {
          console.debug('[agenticLoopGen] breakLoop ignored: deferred return already captured');
        }
        return {
          status: 'complete',
          messages,
          tokens: totals,
          hasCoT: loopHasCoT || undefined,
          returnValue: storedReturnValue ?? breakResult.breakLoop.returnValue,
        };
      }

      // Inject trailing context (e.g., user follow-up message pre-saved by caller)
      if (options.pendingTrailingContext?.length) {
        for (const msg of options.pendingTrailingContext) {
          messages.push(msg);
          yield { type: 'message_created', message: msg };
        }
      }
    }

    while (iteration < MAX_ITERATIONS) {
      iteration++;
      console.debug('[agenticLoopGen] Iteration:', iteration);

      let hookIntercepted = false;
      let assistantMessage!: Message<unknown>;
      let fallbackExtractedBlocks: ToolUseBlock[] | undefined;
      let toolUseBlocks: ToolUseBlock[];

      // DUMMY System: hook intercept before API call
      if (hookRuntime) {
        const hookName = activeHookName!;
        yield { type: 'dummy_hook_start', hookName };
        const lastMsg = messages[messages.length - 1];
        const hookInput = extractHookInput(lastMsg);
        hookInput.chatId = chatId;
        hookInput.messageId = lastMsg.id;
        if (hookContextDepth > 0) {
          hookInput.history = extractHookHistory(messages, hookContextDepth);
        }
        const { value: hookResult, error: hookError } = await hookRuntime.run(hookInput, iteration);

        if (hookResult === 'user') {
          yield { type: 'dummy_hook_end', result: 'user_stop' };
          return {
            status: 'soft_stopped',
            stopPoint: 'after_tools',
            messages,
            tokens: totals,
            hasCoT: loopHasCoT || undefined,
            returnValue: storedReturnValue,
          };
        }

        if (hookResult && typeof hookResult === 'object') {
          yield { type: 'dummy_hook_end', result: 'intercepted' };
          assistantMessage = buildDummyAssistantMessage(
            hookResult.text,
            hookResult.toolCalls,
            hookResult.brief
          );
          messages.push(assistantMessage);
          yield { type: 'message_created', message: assistantMessage };
          hookIntercepted = true;
        } else if (hookError) {
          yield { type: 'dummy_hook_end', result: 'intercepted' };
          const errorText = `Hook error:\n\`\`\`\n${hookError}\n\`\`\``;
          assistantMessage = buildDummyAssistantMessage(errorText, undefined, 'hook error');
          messages.push(assistantMessage);
          yield { type: 'message_created', message: assistantMessage };
          hookIntercepted = true;
        } else {
          yield { type: 'dummy_hook_end', result: 'passthrough' };
        }
      }

      if (!hookIntercepted) {
        yield { type: 'streaming_start' };

        // Load attachments for user messages
        const messagesWithAttachments = await loadAttachmentsForMessages(messages);

        // Compute tidy boundary: the checkpoint ID that marks where trimming starts.
        // keepSegments: -1 = keep all (disable tidy), 0 = tidy everything before latest, N = keep N previous segments.
        const keepSegments = (toolOptions.checkpoint?.keepSegments as number) ?? 0;
        let tidyBoundaryId: string | undefined;
        if (keepSegments !== -1 && checkpointMessageIds.length > 0) {
          const boundaryIdx = Math.max(0, checkpointMessageIds.length - 1 - keepSegments);
          tidyBoundaryId = checkpointMessageIds[boundaryIdx];
        }

        // Build stream options
        const streamOptions = {
          temperature: options.temperature,
          maxTokens: options.maxTokens,
          enableReasoning: options.enableReasoning,
          reasoningBudgetTokens: options.reasoningBudgetTokens,
          thinkingKeepTurns: options.thinkingKeepTurns,
          reasoningEffort: options.reasoningEffort,
          reasoningSummary: options.reasoningSummary,
          systemPrompt: options.systemPrompt,
          preFillResponse: iteration === 1 ? options.preFillResponse : undefined,
          webSearchEnabled: options.webSearchEnabled,
          enabledTools,
          toolOptions,
          disableStream: options.disableStream,
          extendedContext: effectiveExtendedContext,
          checkpointMessageId: tidyBoundaryId,
          tidyToolNames: deriveTidyToolNames(toolOptions),
        };

        // Create assembler for streaming
        const assembler = new StreamingContentAssembler({
          getToolIcon: (toolName: string) => toolRegistry.get(toolName)?.iconInput,
        });

        // Start API stream
        const stream = apiService.sendMessageStream(
          messagesWithAttachments,
          model.id,
          apiDef,
          streamOptions
        );

        let hasFirstChunk = false;
        let isFirstContentChunk = true;

        // Process stream chunks
        let streamNext = await stream.next();
        while (!streamNext.done) {
          const chunk = streamNext.value;

          if (!hasFirstChunk) {
            hasFirstChunk = true;
            yield { type: 'first_chunk' };
          }

          // Handle prefill prepending for first content chunk
          if (
            chunk.type === 'content' &&
            isFirstContentChunk &&
            iteration === 1 &&
            options.preFillResponse &&
            apiService.shouldPrependPrefill(apiDef)
          ) {
            assembler.pushChunk({
              type: 'content',
              content: options.preFillResponse + chunk.content,
            });
            isFirstContentChunk = false;
          } else {
            assembler.pushChunk(chunk);
          }

          if (chunk.type === 'content') {
            isFirstContentChunk = false;
          }

          yield { type: 'streaming_chunk', groups: assembler.getGroups() };
          streamNext = await stream.next();
        }

        yield { type: 'streaming_end' };

        // Get final result
        const result = streamNext.done ? streamNext.value : null;

        if (!result) {
          // Stream returned no result - create error message
          const errorRenderingContent = assembler.finalizeWithError({
            message: 'Stream returned no result',
          });

          const errorMessage: Message<unknown> = {
            id: generateUniqueId('msg_assistant'),
            role: 'assistant',
            content: {
              type: 'text',
              content: '',
              modelFamily: apiDef.apiType,
              renderingContent: errorRenderingContent,
              stopReason: 'error',
            },
            timestamp: new Date(),
          };

          messages.push(errorMessage);
          yield { type: 'message_created', message: errorMessage };

          return {
            status: 'error',
            messages,
            tokens: totals,
            hasCoT: loopHasCoT || undefined,
            error: new Error('Stream returned no result'),
          };
        }

        // Track chain-of-thought across iterations
        if (result.hasCoT) loopHasCoT = true;

        // Extract tokens and calculate cost
        const iterTokens = extractIterationTokens(result, model);
        if (apiDef.advancedSettings?.isSubscription) {
          iterTokens.cost = 0;
          iterTokens.costUnreliable = false;
        }
        addTokens(totals, iterTokens);
        yield { type: 'tokens_consumed', tokens: iterTokens };

        // Build and record assistant message
        assistantMessage = buildAssistantMessage(
          result,
          assembler,
          apiDef.apiType,
          model.id,
          iterTokens
        );

        // Fill context window from model metadata (extended context overrides to 1M)
        if (assistantMessage.metadata) {
          assistantMessage.metadata.contextWindow = effectiveExtendedContext
            ? 1_000_000
            : model.contextWindow || 0;
        }

        messages.push(assistantMessage);
        yield { type: 'message_created', message: assistantMessage };

        // Check for API error (result.error is set but stopReason is undefined)
        if (result.error) {
          return {
            status: 'error',
            messages,
            tokens: totals,
            hasCoT: loopHasCoT || undefined,
            error: new Error(result.error.message),
          };
        }

        // Check stop reason — fallback extraction for minion loops with wrong stopReason
        if (result.stopReason !== 'tool_use') {
          let hasToolBlocks = false;
          if (options.fallbackToolExtraction) {
            fallbackExtractedBlocks = apiService.extractToolUseBlocks(
              apiDef.apiType,
              result.fullContent
            );
            hasToolBlocks = fallbackExtractedBlocks.length > 0;
            if (hasToolBlocks) {
              console.debug(
                '[agenticLoopGen] Fallback: found',
                fallbackExtractedBlocks.length,
                'tool_use block(s) despite stopReason:',
                result.stopReason
              );
            }
          }

          if (!hasToolBlocks) {
            // Checkpoint auto-continue: instead of returning, send a continue message
            // and let the loop re-enter for a fresh API call
            if (checkpointSet) {
              console.debug('[agenticLoopGen] Checkpoint auto-continue');
              const continueText =
                (toolOptions.checkpoint?.continueMessage as string) || 'please continue';
              const continueMsg: Message<string> = {
                id: generateUniqueId('msg_user'),
                role: 'user',
                content: {
                  type: 'text',
                  content: continueText,
                  renderingContent: [
                    { category: 'text', blocks: [{ type: 'text', text: continueText }] },
                  ],
                },
                timestamp: new Date(),
              };
              messages.push(continueMsg);
              yield { type: 'message_created', message: continueMsg };
              checkpointSet = false;
              continue; // Re-enter the while loop for a new API call
            }

            return {
              status: 'complete',
              messages,
              tokens: totals,
              hasCoT: loopHasCoT || undefined,
              returnValue: storedReturnValue,
            };
          }
        }

        // Extract tool blocks from API response
        toolUseBlocks =
          fallbackExtractedBlocks ??
          apiService.extractToolUseBlocks(apiDef.apiType, result.fullContent);
      } else {
        // Hook path: tool blocks from synthetic message
        toolUseBlocks = (assistantMessage.content.toolCalls ?? []) as ToolUseBlock[];
      }

      // Shared: no tool calls — complete or checkpoint auto-continue
      if (toolUseBlocks.length === 0) {
        if (checkpointSet) {
          console.debug('[agenticLoopGen] Checkpoint auto-continue (shared)');
          const continueText =
            (toolOptions.checkpoint?.continueMessage as string) || 'please continue';
          const continueMsg: Message<string> = {
            id: generateUniqueId('msg_user'),
            role: 'user',
            content: {
              type: 'text',
              content: continueText,
              renderingContent: [
                { category: 'text', blocks: [{ type: 'text', text: continueText }] },
              ],
            },
            timestamp: new Date(),
          };
          messages.push(continueMsg);
          yield { type: 'message_created', message: continueMsg };
          checkpointSet = false;
          continue;
        }
        return {
          status: 'complete',
          messages,
          tokens: totals,
          hasCoT: loopHasCoT || undefined,
          returnValue: storedReturnValue,
        };
      }

      // Check soft stop before executing tools
      if (options.shouldStop?.()) {
        console.debug('[agenticLoopGen] Soft stop: before tools');
        return {
          status: 'soft_stopped',
          stopPoint: 'before_tools',
          messages,
          tokens: totals,
          hasCoT: loopHasCoT || undefined,
          returnValue: storedReturnValue,
        };
      }

      const breakResult = yield* executeToolUseBlocks(
        toolUseBlocks,
        apiDef.apiType,
        enabledTools,
        toolOptions,
        toolContext,
        messages,
        totals,
        options.deferReturn,
        storedReturnValue !== undefined,
        options.returnAckMessage,
        options.returnDuplicateMessage,
        options.autoAckMessage
      );

      if (breakResult && 'deferredReturn' in breakResult) {
        storedReturnValue = breakResult.deferredReturn;
        if (deferredReturnIteration === undefined) {
          deferredReturnIteration = iteration;
        }
        // Continue loop — don't break
      } else if (breakResult && 'checkpoint' in breakResult) {
        checkpointSet = true;
        checkpointMessageIds.push(assistantMessage.id);
        yield { type: 'checkpoint_set', messageId: assistantMessage.id };
        // Continue loop — checkpoint triggers auto-continue at end_turn
      } else if (breakResult && 'activeHook' in breakResult) {
        hookRuntime?.dispose();
        activeHookName = breakResult.activeHook;
        hookRuntime = activeHookName
          ? await DummyHookRuntime.load(projectId, options.namespace, activeHookName)
          : null;
        yield { type: 'active_hook_changed', hookName: activeHookName };
      } else if (breakResult?.breakLoop) {
        if (storedReturnValue !== undefined) {
          console.debug('[agenticLoopGen] breakLoop ignored: deferred return already captured');
        }
        return {
          status: 'complete',
          messages,
          tokens: totals,
          hasCoT: loopHasCoT || undefined,
          returnValue: storedReturnValue ?? breakResult.breakLoop.returnValue,
        };
      }

      // Force stop: deferred return captured too many rounds ago
      if (
        deferredReturnIteration !== undefined &&
        iteration - deferredReturnIteration >= forceStopRounds
      ) {
        console.debug('[agenticLoopGen] Deferred return force stop at iteration', iteration);
        return {
          status: 'complete',
          messages,
          tokens: totals,
          hasCoT: loopHasCoT || undefined,
          returnValue: storedReturnValue,
        };
      }

      // Check soft stop after tool execution
      if (options.shouldStop?.()) {
        console.debug('[agenticLoopGen] Soft stop: after tools');
        return {
          status: 'soft_stopped',
          stopPoint: 'after_tools',
          messages,
          tokens: totals,
          hasCoT: loopHasCoT || undefined,
          returnValue: storedReturnValue,
        };
      }

      // Soft nudge: inject "please stop" message after deferred return threshold
      if (
        deferredReturnIteration !== undefined &&
        iteration - deferredReturnIteration >= softStopRounds
      ) {
        const stopText = 'You should stop and user will call you back.';
        const stopMsg: Message<string> = {
          id: generateUniqueId('msg_user'),
          role: 'user',
          content: {
            type: 'text',
            content: stopText,
            renderingContent: [{ category: 'text', blocks: [{ type: 'text', text: stopText }] }],
          },
          timestamp: new Date(),
        };
        messages.push(stopMsg);
        yield { type: 'message_created', message: stopMsg };
      }

      // Continue loop with updated context
    }

    // Max iterations reached
    return {
      status: 'max_iterations',
      messages,
      tokens: totals,
      hasCoT: loopHasCoT || undefined,
      returnValue: storedReturnValue,
    };
  } catch (error) {
    const errorObj = error instanceof Error ? error : new Error(String(error));
    console.error('[agenticLoopGen] Error:', errorObj.message);

    return {
      status: 'error',
      messages,
      tokens: totals,
      hasCoT: loopHasCoT || undefined,
      error: errorObj,
    };
  } finally {
    hookRuntime?.dispose();
  }
}

// ============================================================================
// Helper for consuming the generator
// ============================================================================

/**
 * Consume generator to completion, discarding events.
 * Useful for nested agent calls that don't need streaming UI.
 */
export async function collectAgenticLoop(
  gen: AsyncGenerator<AgenticLoopEvent, AgenticLoopResult, void>
): Promise<AgenticLoopResult> {
  let result: IteratorResult<AgenticLoopEvent, AgenticLoopResult>;
  do {
    result = await gen.next();
  } while (!result.done);
  return result.value;
}

// ============================================================================
// Exports for backward compatibility
// ============================================================================

export { populateToolRenderFields, createToolResultRenderBlock, loadAttachmentsForMessages };
