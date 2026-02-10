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
  ToolResultBlock,
  ToolStreamEvent,
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

const MAX_ITERATIONS = 50;

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

  // VFS namespace for isolated minion personas
  namespace?: string;

  // Anthropic reasoning
  enableReasoning: boolean;
  reasoningBudgetTokens: number;
  thinkingKeepTurns?: number;

  // OpenAI/Responses reasoning
  reasoningEffort?: ReasoningEffort;
  reasoningSummary?: ReasoningSummary;
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
    };

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
    };

// Re-export for backward compatibility
export { createTokenTotals, addTokens } from '../../utils/tokenTotals';
export type { TokenTotals } from '../../types/content';

// ============================================================================
// Helper Functions
// ============================================================================

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

  try {
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

      // Fill context window from model metadata
      if (assistantMessage.metadata) {
        assistantMessage.metadata.contextWindow = model.contextWindow || 0;
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
        return { status: 'complete', messages, tokens: totals };
      }

      // Execute tools
      const toolUseBlocks = apiService.extractToolUseBlocks(apiDef.apiType, result.fullContent);

      if (toolUseBlocks.length === 0) {
        console.debug('[agenticLoopGen] No tool_use blocks found, completing');
        return { status: 'complete', messages, tokens: totals };
      }

      console.debug('[agenticLoopGen] Executing', toolUseBlocks.length, 'tool(s)');

      // Create pending render blocks with status: 'running'
      const pendingRenderBlocks: ToolResultRenderBlock[] = toolUseBlocks.map(toolUse => ({
        type: 'tool_result' as const,
        tool_use_id: toolUse.id,
        name: toolUse.name,
        content: '',
        status: 'pending' as const,
        icon: toolRegistry.get(toolUse.name)?.iconOutput ?? '⏳',
      }));

      // Build pending tool_result message and yield for UI display
      const pendingToolResults: ToolResultBlock[] = toolUseBlocks.map(toolUse => ({
        type: 'tool_result' as const,
        tool_use_id: toolUse.id,
        content: '',
      }));
      const pendingMsg = buildToolResultMessage(
        apiDef.apiType,
        pendingToolResults,
        pendingRenderBlocks
      );
      yield { type: 'pending_tool_result', message: pendingMsg };

      // Execute each tool, consuming generator events
      const toolResults: ToolResultBlock[] = [];
      const toolResultRenderBlocks: ToolResultRenderBlock[] = [];

      for (let i = 0; i < toolUseBlocks.length; i++) {
        const toolUse = toolUseBlocks[i];
        console.debug('[agenticLoopGen] Executing tool:', toolUse.name, 'id:', toolUse.id);
        yield {
          type: 'tool_block_update',
          toolUseId: toolUse.id,
          block: { status: 'running' as const },
        };

        const toolGen = executeClientSideTool(
          toolUse.name,
          toolUse.input,
          enabledTools,
          toolOptions,
          toolContext
        );

        // Consume the tool generator
        let toolNext = await toolGen.next();
        while (!toolNext.done) {
          const event = toolNext.value as ToolStreamEvent;
          if (event.type === 'groups_update') {
            // Forward streaming update for this tool block
            yield {
              type: 'tool_block_update',
              toolUseId: toolUse.id,
              block: { renderingGroups: event.groups, status: 'running' as const },
            };
          }
          toolNext = await toolGen.next();
        }

        const toolResult = toolNext.value;

        // Check for completion (return tool)
        if (toolResult.breakLoop) {
          return {
            status: 'complete',
            messages,
            tokens: totals,
            returnValue: toolResult.breakLoop.returnValue,
          };
        }

        // Build final render block for this tool
        const renderBlock = createToolResultRenderBlock(
          toolUse.id,
          toolUse.name,
          toolResult.content,
          toolResult.isError,
          toolResult.renderingGroups,
          toolResult.tokenTotals
        );
        renderBlock.status = toolResult.isError ? 'error' : 'complete';

        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: toolResult.content,
          is_error: toolResult.isError,
        });
        toolResultRenderBlocks.push(renderBlock);

        // Yield final block update so consumer can update the pending message
        yield {
          type: 'tool_block_update',
          toolUseId: toolUse.id,
          block: renderBlock,
        };
      }

      // Accumulate tool-incurred costs (e.g., minion sub-agent API calls)
      const toolTotals = createTokenTotals();
      for (const rb of toolResultRenderBlocks) {
        if (rb.tokenTotals) {
          addTokens(toolTotals, rb.tokenTotals);
        }
      }

      // Build final tool result message and yield as message_created
      // (consumer replaces the pending message with this — same ID ensures correct replacement)
      const toolResultMsg = buildToolResultMessage(
        apiDef.apiType,
        toolResults,
        toolResultRenderBlocks
      );
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

      // Continue loop with updated context
    }

    // Max iterations reached
    return { status: 'max_iterations', messages, tokens: totals };
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
