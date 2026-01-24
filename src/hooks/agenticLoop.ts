/**
 * Agentic Loop - Core message processing and tool execution loop.
 *
 * This module extracts the agentic loop logic from useChat.ts into a pure async function.
 * It handles:
 * - Message buffer pattern for tool execution loops
 * - Streaming responses and assembling content
 * - Tool execution and result collection
 * - Cost/token tracking across iterations
 * - JS tool configuration (project context, library loading)
 */

import { apiService } from '../services/api/apiService';
import { calculateCost, isCostUnreliable } from '../services/api/modelMetadata';
import { storage } from '../services/storage';
import { StreamingContentAssembler } from '../services/streaming/StreamingContentAssembler';
import { executeClientSideTool, toolRegistry } from '../services/tools/clientSideTools';
import { configureJsTool } from '../services/tools/jsTool';
import type {
  APIDefinition,
  APIType,
  Chat,
  Message,
  MessageAttachment,
  Model,
  Project,
  RenderingBlockGroup,
  ToolResultBlock,
  ToolUseBlock,
} from '../types';
import type { ToolResultRenderBlock, ToolUseRenderBlock } from '../types/content';
import { generateUniqueId } from '../utils/idGenerator';

// Maximum agentic loop iterations to prevent infinite loops
const MAX_TOOL_ITERATIONS = 50;

// ============================================================================
// Types
// ============================================================================

export interface PendingMessage {
  type: 'user' | 'tool_result';
  message: Message<unknown>;
}

export interface AgenticLoopContext {
  chatId: string;
  chat: Chat;
  project: Project;
  apiDef: APIDefinition;
  modelId: string;
  model?: Model;
  currentMessages: Message<unknown>[]; // History snapshot at loop start
}

export interface AgenticLoopCallbacks {
  onMessageSaved: (message: Message<unknown>) => void;
  onStreamingStart: (loadingText: string) => void;
  onStreamingUpdate: (groups: RenderingBlockGroup[]) => void;
  onStreamingEnd: () => void;
  onFirstChunk: () => void;
  /** Receives the fully-built Chat object after storage save */
  onChatUpdated: (chat: Chat) => void;
  /** Receives the fully-built Project object after storage save */
  onProjectUpdated: (project: Project) => void;
  onError: (error: Error) => void;
}

export interface AgenticLoopResult {
  success: boolean;
  savedMessages: Message<unknown>[];
  totalTokens: TokenTotals;
}

interface TokenTotals {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  webSearchCount: number;
  cost: number;
}

interface PricingSnapshot {
  messageCost: number;
  contextWindow: number;
  contextWindowUsage: number;
}

// ============================================================================
// Helper Functions (extracted from useChat.ts)
// ============================================================================

/**
 * Merge tool_use input from fullContent into renderingContent.
 * This fixes streaming providers (like OpenRouter) that don't stream tool arguments.
 * During streaming, tool_use blocks may have empty input; the correct input is in fullContent.
 */
function mergeToolUseInputFromFullContent(
  groups: RenderingBlockGroup[],
  fullContent: unknown,
  apiType: APIType
): void {
  // Extract actual tool inputs from fullContent
  const toolUseBlocks = apiService.extractToolUseBlocks(apiType, fullContent);
  if (toolUseBlocks.length === 0) return;

  // Build map of tool_id -> input
  const inputMap = new Map<string, Record<string, unknown>>();
  for (const toolBlock of toolUseBlocks) {
    inputMap.set(toolBlock.id, toolBlock.input);
  }

  // Update tool_use blocks in renderingContent
  for (const group of groups) {
    for (const block of group.blocks) {
      if (block.type === 'tool_use') {
        const toolUseBlock = block as ToolUseRenderBlock;
        const correctInput = inputMap.get(toolUseBlock.id);
        if (correctInput && Object.keys(toolUseBlock.input).length === 0) {
          // Only update if current input is empty and we have correct input
          toolUseBlock.input = correctInput;
        }
      }
    }
  }
}

/**
 * Post-process rendering content to populate rendered fields on tool blocks.
 * Ensures rendered content is persisted with the message for display even if tool is later disabled.
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
 */
function createToolResultRenderBlock(
  toolUseId: string,
  toolName: string,
  content: string,
  isError?: boolean
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
  };
}

/**
 * Execute tools and build a tool result PendingMessage.
 * Shared by agenticLoop (after tool_use) and resolvePendingToolCalls (continue mode).
 */
async function executeToolsAndBuildPendingMessage(
  apiType: APIType,
  toolUseBlocks: ToolUseBlock[]
): Promise<PendingMessage> {
  const toolResults: ToolResultBlock[] = [];
  const toolResultRenderBlocks: ToolResultRenderBlock[] = [];

  for (const toolUse of toolUseBlocks) {
    console.debug('[agenticLoop] Executing tool:', toolUse.name, 'id:', toolUse.id);
    const toolResult = await executeClientSideTool(toolUse.name, toolUse.input);

    toolResults.push({
      type: 'tool_result',
      tool_use_id: toolUse.id,
      content: toolResult.content,
      is_error: toolResult.isError,
    });

    toolResultRenderBlocks.push(
      createToolResultRenderBlock(toolUse.id, toolUse.name, toolResult.content, toolResult.isError)
    );
  }

  // Build tool result message using API-specific format
  const toolResultMessage = apiService.buildToolResultMessage(apiType, toolResults);

  // Add rendering content to tool result message
  toolResultMessage.content.renderingContent = [
    { category: 'backstage' as const, blocks: toolResultRenderBlocks },
  ];

  return { type: 'tool_result', message: toolResultMessage };
}

/**
 * Build error tool results for unresolved tool calls (stop mode).
 * Creates error responses without executing the tools.
 */
function buildErrorToolResultPendingMessage(
  apiType: APIType,
  toolUseBlocks: ToolUseBlock[],
  errorMessage: string = 'Token limit reached, ask user to continue'
): PendingMessage {
  const toolResults: ToolResultBlock[] = [];
  const toolResultRenderBlocks: ToolResultRenderBlock[] = [];

  for (const toolUse of toolUseBlocks) {
    toolResults.push({
      type: 'tool_result',
      tool_use_id: toolUse.id,
      content: errorMessage,
      is_error: true,
    });

    toolResultRenderBlocks.push(
      createToolResultRenderBlock(toolUse.id, toolUse.name, errorMessage, true)
    );
  }

  // Build tool result message using API-specific format
  const toolResultMessage = apiService.buildToolResultMessage(apiType, toolResults);

  // Add rendering content to tool result message
  toolResultMessage.content.renderingContent = [
    { category: 'backstage' as const, blocks: toolResultRenderBlocks },
  ];

  return { type: 'tool_result', message: toolResultMessage };
}

/**
 * Get pricing snapshot for a message.
 */
async function getPricingSnapshot(
  model: Model,
  inputTokens: number,
  outputTokens: number,
  reasoningTokens: number,
  cacheCreationTokens: number,
  cacheReadTokens: number,
  webSearchCount: number
): Promise<PricingSnapshot> {
  const totalCost = calculateCost(
    model,
    inputTokens,
    outputTokens,
    reasoningTokens,
    cacheCreationTokens,
    cacheReadTokens,
    webSearchCount
  );

  const contextWindowUsage = inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens;
  const contextWindow = model?.contextWindow || 0;

  return {
    messageCost: totalCost,
    contextWindow,
    contextWindowUsage,
  };
}

interface StreamOptions {
  temperature: number | undefined;
  maxTokens: number;
  enableReasoning: boolean;
  reasoningBudgetTokens: number;
  thinkingKeepTurns: number | undefined;
  reasoningEffort: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | undefined;
  reasoningSummary: 'auto' | 'concise' | 'detailed' | undefined;
  systemPrompt: string | undefined;
  preFillResponse: string | undefined;
  webSearchEnabled: boolean;
  enabledTools: string[];
  disableStream: boolean;
}

interface BuildStreamOptionsContext {
  project: Project;
  chatId: string;
  apiDefId: string;
  modelId: string;
  apiType: APIType;
}

/**
 * Build stream options from project settings.
 */
async function buildStreamOptions(
  context: BuildStreamOptionsContext,
  enabledTools: string[]
): Promise<StreamOptions> {
  const { project, chatId, apiDefId, modelId, apiType } = context;

  // Build context for system prompt functions
  const systemPromptContext = {
    projectId: project.id,
    chatId,
    apiDefinitionId: apiDefId,
    modelId,
  };

  // Build combined system prompt: project prompt + tool prompts (async)
  const toolSystemPrompts = await toolRegistry.getSystemPrompts(
    apiType,
    enabledTools,
    systemPromptContext
  );
  const combinedSystemPrompt = [project.systemPrompt, ...toolSystemPrompts]
    .filter(Boolean)
    .join('\n\n');

  return {
    temperature: project.temperature ?? undefined,
    maxTokens: project.maxOutputTokens,
    enableReasoning: project.enableReasoning,
    reasoningBudgetTokens: project.reasoningBudgetTokens,
    thinkingKeepTurns: project.thinkingKeepTurns,
    reasoningEffort: project.reasoningEffort,
    reasoningSummary: project.reasoningSummary,
    systemPrompt: combinedSystemPrompt || undefined,
    preFillResponse: project.preFillResponse,
    webSearchEnabled: project.webSearchEnabled,
    enabledTools,
    disableStream: project.disableStream ?? false,
  };
}

/**
 * Build enabled tools list from project settings.
 */
function getEnabledTools(project: Project): string[] {
  const enabledTools: string[] = [];
  if (project.memoryEnabled) enabledTools.push('memory');
  if (project.jsExecutionEnabled) enabledTools.push('javascript');
  if (project.fsToolEnabled) enabledTools.push('filesystem');
  return enabledTools;
}

// ============================================================================
// Main Agentic Loop
// ============================================================================

/**
 * Run the agentic loop with a message buffer pattern.
 *
 * The loop processes messages from the buffer, sends them to the API,
 * handles tool execution, and continues until no more tool calls or max iterations.
 *
 * @param context - Chat context (chatId, chat, project, apiDef, modelId, currentMessages)
 * @param initialMessages - Initial messages to process (user message or tool results)
 * @param callbacks - React state update callbacks
 * @returns Result with success status, saved messages, and token totals
 */
export async function runAgenticLoop(
  context: AgenticLoopContext,
  initialMessages: PendingMessage[],
  callbacks: AgenticLoopCallbacks
): Promise<AgenticLoopResult> {
  if (context.model == undefined) {
    throw new Error(
      `Unable to start agentic loop, model ${context.modelId} not found in ${context.apiDef.name}`
    );
  }

  const messageBuffer = [...initialMessages];
  const savedMessages: Message<unknown>[] = [];
  let iteration = 0;

  // Configure JS tool at loop start if enabled
  if (context.project.jsExecutionEnabled) {
    configureJsTool(context.project.id, context.project.jsLibEnabled ?? true);
  }

  // Accumulate totals across all iterations
  const totals: TokenTotals = {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    webSearchCount: 0,
    cost: 0,
  };

  // Build enabled tools and options
  const enabledTools = getEnabledTools(context.project);

  // Track the last context window usage for chat update
  let lastContextWindowUsage = 0;

  // Track if any message has unreliable cost
  let hasUnreliableCost = false;

  callbacks.onStreamingStart('Thinking...');

  // Create assembler for streaming
  let assembler: StreamingContentAssembler | null = null;

  try {
    while (messageBuffer.length > 0 && iteration < MAX_TOOL_ITERATIONS) {
      iteration++;
      console.debug('[agenticLoop] Iteration:', iteration);

      // 1. Take all pending messages from buffer
      const toSend = messageBuffer.splice(0, messageBuffer.length);

      // 2. Save pending messages to storage and notify UI
      for (const pending of toSend) {
        await storage.saveMessage(context.chatId, pending.message);
        savedMessages.push(pending.message);
        callbacks.onMessageSaved(pending.message);
      }

      // 3. Build messages for API (history + new messages)
      // Load attachments for user messages
      const allMessages = [...context.currentMessages, ...savedMessages];
      const messagesWithAttachments = await loadAttachmentsForMessages(allMessages);

      // Apply metadataNewContext: if enabled, only send current user message
      const messagesToSend =
        context.project.sendMessageMetadata === 'template' && context.project.metadataNewContext
          ? [messagesWithAttachments[messagesWithAttachments.length - 1]]
          : messagesWithAttachments;

      // 4. Build options (no prefill for continuation iterations)
      const optionsContext: BuildStreamOptionsContext = {
        project: context.project,
        chatId: context.chatId,
        apiDefId: context.apiDef.id,
        modelId: context.modelId,
        apiType: context.apiDef.apiType,
      };
      const options = await buildStreamOptions(optionsContext, enabledTools);
      if (iteration > 1) {
        options.preFillResponse = undefined; // No prefill for continuation
      }

      // 5. Stream API response
      assembler = new StreamingContentAssembler({
        getToolIcon: (toolName: string) => toolRegistry.get(toolName)?.iconInput,
      });
      callbacks.onStreamingUpdate([]);

      // Yield to allow React to process the streaming reset before new content arrives
      await Promise.resolve();

      console.debug('[agenticLoop] Starting API stream');
      const stream = apiService.sendMessageStream(
        messagesToSend,
        context.modelId,
        context.apiDef,
        options
      );

      let hasFirstChunk = false;
      let isFirstContentChunk = true;

      // Process stream chunks
      let streamNext = await stream.next();
      while (!streamNext.done) {
        const chunk = streamNext.value;

        if (!hasFirstChunk) {
          hasFirstChunk = true;
          callbacks.onFirstChunk();
        }

        // Handle prefill prepending for first content chunk
        if (
          chunk.type === 'content' &&
          isFirstContentChunk &&
          iteration === 1 &&
          context.project.preFillResponse &&
          apiService.shouldPrependPrefill(context.apiDef)
        ) {
          assembler.pushChunk({
            type: 'content',
            content: context.project.preFillResponse + chunk.content,
          });
          isFirstContentChunk = false;
        } else {
          assembler.pushChunk(chunk);
        }

        if (chunk.type === 'content') {
          isFirstContentChunk = false;
        }

        callbacks.onStreamingUpdate(assembler.getGroups());
        streamNext = await stream.next();
      }

      // 6. Get final result
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
            modelFamily: context.apiDef.apiType,
            renderingContent: errorRenderingContent,
            stopReason: 'error',
          },
          timestamp: new Date(),
        };

        await storage.saveMessage(context.chatId, errorMessage);
        savedMessages.push(errorMessage);
        callbacks.onMessageSaved(errorMessage);
        break;
      }

      // 7. Process result - extract tokens and calculate pricing
      const inputTokens = result.inputTokens ?? 0;
      const outputTokens = result.outputTokens ?? 0;
      const reasoningTokens = result.reasoningTokens ?? 0;
      const cacheCreationTokens = result.cacheCreationTokens ?? 0;
      const cacheReadTokens = result.cacheReadTokens ?? 0;
      const webSearchCount = result.webSearchCount ?? 0;

      const pricingSnapshot = await getPricingSnapshot(
        context.model,
        inputTokens,
        outputTokens,
        reasoningTokens,
        cacheCreationTokens,
        cacheReadTokens,
        webSearchCount
      );

      lastContextWindowUsage = pricingSnapshot.contextWindowUsage;

      // Finalize rendering content
      const { renderingContent, stopReason } = result.error
        ? {
            renderingContent: assembler.finalizeWithError(result.error),
            stopReason: 'error' as const,
          }
        : {
            renderingContent: assembler.finalize(),
            stopReason: apiService.mapStopReason(context.apiDef.apiType, result.stopReason ?? null),
          };

      // Merge tool_use input from fullContent (streaming may have empty args)
      if (!result.error) {
        mergeToolUseInputFromFullContent(
          renderingContent,
          result.fullContent,
          context.apiDef.apiType
        );
      }

      // Populate tool render fields (icon, renderedInput)
      populateToolRenderFields(renderingContent);

      // Check if cost calculation is unreliable for this message
      const costUnreliable = isCostUnreliable(
        context.model,
        inputTokens,
        outputTokens,
        reasoningTokens,
        cacheCreationTokens,
        cacheReadTokens,
        webSearchCount
      );
      if (costUnreliable) {
        hasUnreliableCost = true;
      }

      // Create assistant message
      const assistantMessage: Message<unknown> = {
        id: generateUniqueId('msg_assistant'),
        role: 'assistant',
        content: {
          type: 'text',
          content: result.textContent,
          modelFamily: context.apiDef.apiType,
          fullContent: result.fullContent,
          renderingContent,
          stopReason,
        },
        timestamp: new Date(),
        metadata: {
          model: context.modelId,
          inputTokens,
          outputTokens,
          reasoningTokens: reasoningTokens > 0 ? reasoningTokens : undefined,
          cacheCreationTokens,
          cacheReadTokens,
          webSearchCount: webSearchCount > 0 ? webSearchCount : undefined,
          ...pricingSnapshot,
          costUnreliable: costUnreliable || undefined, // Only set if true
        },
      };

      await storage.saveMessage(context.chatId, assistantMessage);
      savedMessages.push(assistantMessage);
      callbacks.onMessageSaved(assistantMessage);

      // Accumulate totals
      totals.inputTokens += inputTokens;
      totals.outputTokens += outputTokens;
      totals.reasoningTokens += reasoningTokens;
      totals.cacheCreationTokens += cacheCreationTokens;
      totals.cacheReadTokens += cacheReadTokens;
      totals.webSearchCount += webSearchCount;
      totals.cost += pricingSnapshot.messageCost;

      // 8. Check for tool_use and execute tools
      // Skip this if MAX_TOOL_ITERATIONS reached, since the tool result will not be send to LLM anyways
      // (Skip will just send a fail message, while Run will rerun the tool calls)
      // TODO: When implementing stop message stream / agentic loop function, stop here too.
      if (result.stopReason === 'tool_use' && iteration < MAX_TOOL_ITERATIONS) {
        const toolUseBlocks = apiService.extractToolUseBlocks(
          context.apiDef.apiType,
          result.fullContent
        );

        if (toolUseBlocks.length === 0) {
          console.debug('[agenticLoop] No tool_use blocks found, ending loop');
          break;
        }

        console.debug('[agenticLoop] Executing', toolUseBlocks.length, 'tool(s)');

        // Execute tools and build result message
        const toolResultPending = await executeToolsAndBuildPendingMessage(
          context.apiDef.apiType,
          toolUseBlocks
        );

        // Push tool result to buffer for next iteration
        messageBuffer.push(toolResultPending);
      }
    }

    // Build and save final Chat object with accumulated totals
    const updatedChat: Chat = {
      ...context.chat,
      totalInputTokens: (context.chat.totalInputTokens ?? 0) + totals.inputTokens,
      totalOutputTokens: (context.chat.totalOutputTokens ?? 0) + totals.outputTokens,
      totalReasoningTokens: (context.chat.totalReasoningTokens ?? 0) + totals.reasoningTokens,
      totalCacheCreationTokens:
        (context.chat.totalCacheCreationTokens ?? 0) + totals.cacheCreationTokens,
      totalCacheReadTokens: (context.chat.totalCacheReadTokens ?? 0) + totals.cacheReadTokens,
      totalCost: (context.chat.totalCost ?? 0) + totals.cost,
      contextWindowUsage: lastContextWindowUsage,
      messageCount: (context.chat.messageCount ?? 0) + savedMessages.length,
      lastModifiedAt: new Date(),
      // Set costUnreliable if any message in this run or previous runs had unreliable cost
      costUnreliable: hasUnreliableCost || context.chat.costUnreliable || undefined,
    };
    await storage.saveChat(updatedChat);
    callbacks.onChatUpdated(updatedChat);

    // Build and save final Project object with lastUsedAt
    const updatedProject: Project = {
      ...context.project,
      lastUsedAt: new Date(),
    };
    await storage.saveProject(updatedProject);
    callbacks.onProjectUpdated(updatedProject);

    return { success: true, savedMessages, totalTokens: totals };
  } catch (error) {
    const errorInfo =
      error instanceof Error
        ? { message: error.message, stack: error.stack }
        : { message: String(error) || 'Unknown error' };

    console.error('[agenticLoop] Error:', errorInfo.message);

    // Create error message if we have an assembler
    const errorRenderingContent = assembler
      ? assembler.finalizeWithError(errorInfo)
      : [
          {
            category: 'error' as const,
            blocks: [
              errorInfo.stack
                ? { type: 'error' as const, message: errorInfo.message, stack: errorInfo.stack }
                : { type: 'error' as const, message: errorInfo.message },
            ],
          },
        ];

    const errorMessage: Message<unknown> = {
      id: generateUniqueId('msg_assistant'),
      role: 'assistant',
      content: {
        type: 'text',
        content: '',
        modelFamily: context.apiDef.apiType,
        renderingContent: errorRenderingContent,
        stopReason: 'error',
      },
      timestamp: new Date(),
    };

    await storage.saveMessage(context.chatId, errorMessage);
    savedMessages.push(errorMessage);
    callbacks.onMessageSaved(errorMessage);

    callbacks.onError(error instanceof Error ? error : new Error(String(error)));
    return { success: false, savedMessages, totalTokens: totals };
  } finally {
    callbacks.onStreamingEnd();
  }
}

// ============================================================================
// Helper: Load attachments for messages
// ============================================================================

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

// ============================================================================
// Exports for useChat.ts integration
// ============================================================================

export {
  populateToolRenderFields,
  createToolResultRenderBlock,
  executeToolsAndBuildPendingMessage,
  buildErrorToolResultPendingMessage,
  getEnabledTools,
  buildStreamOptions,
  loadAttachmentsForMessages,
};
