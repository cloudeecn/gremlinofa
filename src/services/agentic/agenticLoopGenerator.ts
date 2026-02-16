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

// ============================================================================
// Constants
// ============================================================================

const MAX_ITERATIONS = 999;

/** Maps checkpoint swipe option IDs to tool names */
const SWIPE_OPTION_TO_TOOL: Record<string, string> = {
  swipeFilesystem: 'filesystem',
  swipeMemory: 'memory',
  swipeJavascript: 'javascript',
  swipeMinion: 'minion',
  swipeSketchbook: 'sketchbook',
  swipeCheckpoint: 'checkpoint',
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

  // When true, the return tool stores its value without breaking the loop.
  // The stored value is returned when the loop ends naturally.
  deferReturn?: boolean;

  // Checkpoint message ID from previous checkpoint — enables context swipe
  checkpointMessageId?: string;
}

/**
 * Events yielded during loop execution.
 */
export type AgenticLoopEvent =
  | { type: 'streaming_start' }
  | { type: 'streaming_chunk'; groups: RenderingBlockGroup[] }
  | { type: 'streaming_end' }
  | { type: 'message_created'; message: Message<unknown> }
  | { type: 'tokens_consumed'; tokens: TokenTotals }
  | { type: 'first_chunk' }
  | { type: 'pending_tool_result'; message: Message<unknown> }
  | {
      type: 'tool_block_update';
      toolUseId: string;
      block: Partial<ToolResultRenderBlock>;
    }
  | { type: 'checkpoint_set'; messageId: string };

/**
 * Final result returned when loop completes.
 */
export type AgenticLoopResult =
  | {
      status: 'complete';
      messages: Message<unknown>[];
      tokens: TokenTotals;
      returnValue?: string;
    }
  | {
      status: 'error';
      messages: Message<unknown>[];
      tokens: TokenTotals;
      error: Error;
    }
  | {
      status: 'max_iterations';
      messages: Message<unknown>[];
      tokens: TokenTotals;
      returnValue?: string;
    };

// Re-export for backward compatibility
export { createTokenTotals, addTokens } from '../../utils/tokenTotals';
export type { TokenTotals } from '../../types/content';

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Derive the set of tool names to swipe from checkpoint tool options.
 * Options default to true (swipe enabled) when not explicitly set.
 */
function deriveSwipeToolNames(toolOptions: Record<string, ToolOptions>): Set<string> | undefined {
  const checkpointOpts = toolOptions.checkpoint;
  if (!checkpointOpts) return undefined;

  const names = new Set<string>();
  for (const [optId, toolName] of Object.entries(SWIPE_OPTION_TO_TOOL)) {
    // Default true — swipe unless explicitly disabled
    const enabled = checkpointOpts[optId] !== false;
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

  for (const group of groups) {
    for (const block of group.blocks) {
      if (block.type === 'tool_use') {
        const toolUseBlock = block as ToolUseRenderBlock;
        const correctInput = inputMap.get(toolUseBlock.id);
        if (correctInput && Object.keys(toolUseBlock.input).length === 0) {
          toolUseBlock.input = correctInput;
        }
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
  const defaultIcon = isError ? '❌' : '✅';

  return {
    type: 'tool_result',
    tool_use_id: toolUseId,
    content,
    is_error: isError,
    name: toolName,
    icon: tool?.iconOutput ?? defaultIcon,
    renderedContent: tool?.renderOutput?.(content, isError) ?? content,
    renderingGroups,
    tokenTotals,
  };
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

  return {
    id: generateUniqueId('msg_assistant'),
    role: 'assistant',
    content: {
      type: 'text',
      content: result.textContent,
      modelFamily: apiType,
      fullContent: result.fullContent,
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
  const toolResultMessage = apiService.buildToolResultMessage(apiType, toolResults);

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
  { results: ParallelToolResult[]; breakLoop?: { returnValue?: string }; checkpoint?: boolean },
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

  // Kick off first .next() for each generator
  for (const ag of activeGens) {
    ag.pendingNext = safeGenNext(ag);
  }

  const results: (ParallelToolResult | null)[] = new Array(blocks.length).fill(null);
  let breakLoop: { returnValue?: string } | undefined;
  let checkpointSet = false;

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
  deferReturn?: boolean,
  hasStoredReturn?: boolean
): AsyncGenerator<
  AgenticLoopEvent,
  | { breakLoop: { returnValue?: string } }
  | { deferredReturn: string }
  | { checkpoint: true }
  | undefined,
  void
> {
  console.debug('[agenticLoopGen] Executing', toolUseBlocks.length, 'tool(s)');

  // --- Return tool handling ---
  // If return is the ONLY tool, execute it directly (preserves breakLoop behavior).
  const returnToolIndex = toolUseBlocks.findIndex(b => b.name === 'return');
  if (returnToolIndex !== -1 && toolUseBlocks.length === 1) {
    const returnBlock = toolUseBlocks[0];

    // Reject duplicate deferred return calls without executing the tool
    if (deferReturn && hasStoredReturn) {
      const errorContent =
        'ERROR: A result has already been stored. Do NOT call return again. STOP immediately — do not call any more tools or produce further output.';
      const renderBlock = createToolResultRenderBlock(
        returnBlock.id,
        returnBlock.name,
        errorContent,
        true
      );
      renderBlock.status = 'error';

      const toolResultBlocks: ToolResultBlock[] = [
        { type: 'tool_result', tool_use_id: returnBlock.id, content: errorContent },
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

    if (deferReturn) {
      // Deferred mode: store value, build normal tool_result, continue loop
      const returnValue = toolResult.breakLoop?.returnValue ?? toolResult.content;
      const storedContent = 'Result stored. You MUST stop now — do not call any more tools.';

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
          content: storedContent,
        },
      ];

      const toolResultMsg = buildToolResultMessage(apiType, toolResultBlocks, [renderBlock]);
      messages.push(toolResultMsg);
      yield { type: 'message_created', message: toolResultMsg };

      return { deferredReturn: returnValue };
    }

    return { breakLoop: toolResult.breakLoop ?? { returnValue: toolResult.content } };
  }

  // Separate return tool from executable tools (return gets an error result)
  let returnErrorResult: ParallelToolResult | undefined;
  let executableBlocks = toolUseBlocks;

  if (returnToolIndex !== -1) {
    console.debug('[agenticLoopGen] Return tool in parallel batch — sending error result');
    const returnBlock = toolUseBlocks[returnToolIndex];
    const errorContent = 'return cannot be called in parallel with other tools. please try again';
    const renderBlock = createToolResultRenderBlock(
      returnBlock.id,
      returnBlock.name,
      errorContent,
      true
    );
    renderBlock.status = 'error';
    returnErrorResult = {
      toolResult: {
        type: 'tool_result',
        tool_use_id: returnBlock.id,
        content: errorContent,
        is_error: true,
      },
      renderBlock,
    };
    executableBlocks = toolUseBlocks.filter((_, i) => i !== returnToolIndex);
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
    content: '',
  }));
  const pendingMsg = buildToolResultMessage(apiType, pendingToolResults, pendingRenderBlocks);
  yield { type: 'pending_tool_result', message: pendingMsg };

  // --- Yield return error block update immediately ---
  if (returnErrorResult) {
    yield {
      type: 'tool_block_update',
      toolUseId: returnErrorResult.renderBlock.tool_use_id,
      block: returnErrorResult.renderBlock,
    };
  }

  // --- Collect results keyed by tool_use_id for final merge ---
  const resultMap = new Map<string, ParallelToolResult>();
  if (returnErrorResult) {
    resultMap.set(returnErrorResult.toolResult.tool_use_id, returnErrorResult);
  }

  let breakLoopResult: { returnValue?: string } | undefined;
  let checkpointSet = false;

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
    yield { type: 'tokens_consumed', tokens: toolTotals };
  }

  messages.push(toolResultMsg);
  yield { type: 'message_created', message: toolResultMsg };

  if (checkpointSet) {
    return { checkpoint: true };
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

  // Build tool execution context
  const toolContext = { projectId, chatId, namespace: options.namespace };

  // Copy to avoid mutating caller's array (React state safety)
  const messages = [...context];
  const totals = createTokenTotals();
  let iteration = 0;
  let storedReturnValue: string | undefined;
  let checkpointSet = false;
  let checkpointMessageId = options.checkpointMessageId;

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
        storedReturnValue !== undefined
      );

      if (breakResult && 'deferredReturn' in breakResult) {
        storedReturnValue = breakResult.deferredReturn;
        // Continue loop — don't return yet
      } else if (breakResult && 'checkpoint' in breakResult) {
        checkpointSet = true;
        // Continue loop — checkpoint will be included in final result
      } else if (breakResult?.breakLoop) {
        return {
          status: 'complete',
          messages,
          tokens: totals,
          returnValue: breakResult.breakLoop.returnValue,
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

      yield { type: 'streaming_start' };

      // Load attachments for user messages
      const messagesWithAttachments = await loadAttachmentsForMessages(messages);

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
        extendedContext: options.extendedContext,
        checkpointMessageId,
        swipeToolNames: deriveSwipeToolNames(toolOptions),
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
          error: new Error('Stream returned no result'),
        };
      }

      // Extract tokens and calculate cost
      const iterTokens = extractIterationTokens(result, model);
      addTokens(totals, iterTokens);
      yield { type: 'tokens_consumed', tokens: iterTokens };

      // Build and record assistant message
      const assistantMessage = buildAssistantMessage(
        result,
        assembler,
        apiDef.apiType,
        model.id,
        iterTokens
      );

      // Fill context window from model metadata (extended context overrides to 1M)
      if (assistantMessage.metadata) {
        assistantMessage.metadata.contextWindow = options.extendedContext
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
          error: new Error(result.error.message),
        };
      }

      // Check stop reason
      if (result.stopReason !== 'tool_use') {
        // Checkpoint auto-continue: instead of returning, send a continue message
        // and let the loop re-enter for a fresh API call
        if (checkpointSet) {
          console.debug('[agenticLoopGen] Checkpoint auto-continue');
          yield { type: 'checkpoint_set', messageId: checkpointMessageId! };
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
          returnValue: storedReturnValue,
        };
      }

      // Execute tools
      const toolUseBlocks = apiService.extractToolUseBlocks(apiDef.apiType, result.fullContent);

      if (toolUseBlocks.length === 0) {
        console.debug('[agenticLoopGen] No tool_use blocks found, completing');
        return { status: 'complete', messages, tokens: totals };
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
        storedReturnValue !== undefined
      );

      if (breakResult && 'deferredReturn' in breakResult) {
        storedReturnValue = breakResult.deferredReturn;
        // Continue loop — don't break
      } else if (breakResult && 'checkpoint' in breakResult) {
        checkpointSet = true;
        checkpointMessageId = assistantMessage.id;
        // Continue loop — checkpoint will be included in final result
      } else if (breakResult?.breakLoop) {
        return {
          status: 'complete',
          messages,
          tokens: totals,
          returnValue: breakResult.breakLoop.returnValue,
        };
      }

      // Continue loop with updated context
    }

    // Max iterations reached
    return {
      status: 'max_iterations',
      messages,
      tokens: totals,
      returnValue: storedReturnValue,
    };
  } catch (error) {
    const errorObj = error instanceof Error ? error : new Error(String(error));
    console.error('[agenticLoopGen] Error:', errorObj.message);

    return {
      status: 'error',
      messages,
      tokens: totals,
      error: errorObj,
    };
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
