import { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import Mustache from 'mustache';
import { apiService } from '../services/api/apiService';
import { storage } from '../services/storage';
import { toolRegistry } from '../services/tools/clientSideTools';
import {
  runAgenticLoop,
  createTokenTotals,
  addTokens,
  createToolResultRenderBlock,
  type AgenticLoopOptions,
  type AgenticLoopEvent,
  type TokenTotals,
} from '../services/agentic/agenticLoopGenerator';
import type {
  APIDefinition,
  Chat,
  Message,
  MessageAttachment,
  Model,
  Project,
  RenderingBlockGroup,
  TokenUsage,
  ToolUseBlock,
  ToolResultBlock,
} from '../types';
import type { ToolResultRenderBlock } from '../types/content';

import { generateUniqueId } from '../utils/idGenerator';
import { showAlert } from '../utils/alerts';

/** Throttle interval for streaming/tool-block UI updates (ms).
 * Batches rapid state updates from parallel minions into fewer React renders. */
const STREAMING_THROTTLE_MS = 200;

/** Format timestamp for local timezone */
function formatTimestampLocal(): string {
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    timeZoneName: 'short',
  }).format(new Date());
}

/** Format timestamp for UTC timezone */
function formatTimestampUtc(): string {
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    timeZoneName: 'short',
    timeZone: 'UTC',
  }).format(new Date());
}

/** Format timestamp as relative time */
function formatTimestampRelative(firstMessageTimestamp?: Date): string {
  const now = new Date();
  const chatStart = firstMessageTimestamp ?? now;
  const secondsSinceChatStart = Math.floor((now.getTime() - chatStart.getTime()) / 1000);
  return `${secondsSinceChatStart} seconds since chat start`;
}

/**
 * Generate message content based on metadata mode.
 * Returns the formatted message with metadata/template applied.
 */
function generateMessageWithMetadata(
  messageText: string,
  project: Project,
  chat: Chat,
  modelId: string,
  firstMessageTimestamp?: Date
): string {
  // Mode: disabled - return plain message
  if (!project.sendMessageMetadata) {
    return messageText;
  }

  // Mode: template - use Mustache rendering
  if (project.sendMessageMetadata === 'template') {
    const template = project.metadataTemplate || '{{userMessage}}';
    const view = {
      userMessage: messageText,
      timestamp: formatTimestampLocal(),
      timestampUtc: formatTimestampUtc(),
      timestampRelative: formatTimestampRelative(firstMessageTimestamp),
      modelName: modelId,
      contextWindowUsage: chat.contextWindowUsage ? `${chat.contextWindowUsage} tokens` : '',
      currentCost: chat.totalCost !== undefined ? `$${chat.totalCost.toFixed(3)}` : '',
      // Boolean helpers for conditionals
      hasContextWindowUsage: !!chat.contextWindowUsage,
      hasCurrentCost: chat.totalCost !== undefined && chat.totalCost > 0,
    };
    return Mustache.render(template, view);
  }

  // Mode: true (metadata XML format)
  const metadataParts: string[] = [];

  // Add timestamp if enabled
  if (project.metadataTimestampMode && project.metadataTimestampMode !== 'disabled') {
    if (project.metadataTimestampMode === 'relative') {
      metadataParts.push(
        `<timestamp>${formatTimestampRelative(firstMessageTimestamp)}</timestamp>`
      );
    } else if (project.metadataTimestampMode === 'utc') {
      metadataParts.push(`<timestamp>${formatTimestampUtc()}</timestamp>`);
    } else {
      metadataParts.push(`<timestamp>${formatTimestampLocal()}</timestamp>`);
    }
  }

  // Add model name if enabled (after timestamp)
  if (project.metadataIncludeModelName && modelId) {
    metadataParts.push(`<model>${modelId}</model>`);
  }

  // Add context window usage if enabled
  if (project.metadataIncludeContextWindow && chat.contextWindowUsage) {
    metadataParts.push(
      `<context_window_usage>${chat.contextWindowUsage} tokens</context_window_usage>`
    );
  }

  // Add current cost if enabled
  if (project.metadataIncludeCost && chat.totalCost !== undefined) {
    metadataParts.push(`<current_cost>$${chat.totalCost.toFixed(3)}</current_cost>`);
  }

  if (metadataParts.length === 0) {
    return messageText;
  }

  return `<metadata>\n${metadataParts.join('\n')}\n</metadata>\n\n${messageText}`;
}

/**
 * Strip metadata XML from message content
 */
function stripMetadata(content: string): string {
  return content.replace(/^<metadata>.*?<\/metadata>\s*/s, '');
}

/**
 * Create and persist a user message with attachments.
 * Returns the created message (caller is responsible for updating React state).
 */
async function createAndSaveUserMessage(
  chatId: string,
  messageText: string,
  project: Project,
  chat: Chat,
  modelId: string,
  firstMessageTimestamp: Date | undefined,
  attachments?: MessageAttachment[]
): Promise<Message<string>> {
  // Generate message with metadata/template applied
  const messageWithMetadata = generateMessageWithMetadata(
    messageText,
    project,
    chat,
    modelId,
    firstMessageTimestamp
  );

  // Extract attachment IDs if any
  const attachmentIds = attachments?.map(att => att.id) || [];

  // Create user message
  const userMessage: Message<string> = {
    id: generateUniqueId('msg_user'),
    role: 'user',
    content: {
      type: 'text',
      content: messageWithMetadata,
      renderingContent: [{ category: 'text', blocks: [{ type: 'text', text: messageText }] }],
      ...(attachmentIds.length > 0 && {
        attachmentIds,
        originalAttachmentCount: attachmentIds.length,
      }),
    },
    timestamp: new Date(),
  };

  // Save attachments if any
  if (attachments && attachments.length > 0) {
    for (const attachment of attachments) {
      await storage.saveAttachment(userMessage.id, attachment);
    }
  }

  // Save user message to storage
  await storage.saveMessage(chatId, userMessage);

  return userMessage;
}

// ============================================================================
// Generator-based Agentic Loop Helpers
// ============================================================================

/**
 * Build AgenticLoopOptions from Chat/Project.
 * The generator expects flat options instead of nested entities.
 */
async function buildAgenticLoopOptions(
  chat: Chat,
  project: Project,
  apiDef: APIDefinition,
  model: Model,
  modelId: string
): Promise<AgenticLoopOptions> {
  // Storage layer handles migration on read, so we can read new fields directly
  const enabledTools = project.enabledTools ?? [];
  const toolOptions = project.toolOptions ?? {};

  // Build system prompt context with apiType for tool prompt generation
  const systemPromptContext = {
    projectId: project.id,
    chatId: chat.id,
    apiDefinitionId: apiDef.id,
    modelId,
    apiType: apiDef.apiType,
  };

  // Build combined system prompt: project prompt + tool prompts (async)
  const toolSystemPrompts = await toolRegistry.getSystemPrompts(
    apiDef.apiType,
    enabledTools,
    systemPromptContext,
    toolOptions
  );
  const combinedSystemPrompt = [project.systemPrompt, ...toolSystemPrompts]
    .filter(Boolean)
    .join('\n\n');

  return {
    apiDef,
    model,
    projectId: project.id,
    chatId: chat.id,
    temperature: project.temperature ?? undefined,
    maxTokens: project.maxOutputTokens,
    systemPrompt: combinedSystemPrompt || undefined,
    preFillResponse: project.preFillResponse,
    webSearchEnabled: project.webSearchEnabled,
    enabledTools,
    toolOptions,
    disableStream: project.disableStream ?? false,
    extendedContext: project.extendedContext ?? false,
    enableReasoning: project.enableReasoning,
    reasoningBudgetTokens: project.reasoningBudgetTokens,
    thinkingKeepTurns: project.thinkingKeepTurns,
    reasoningEffort: project.reasoningEffort,
    reasoningSummary: project.reasoningSummary,
  };
}

/**
 * Event handlers for consuming the agentic loop generator.
 */
interface LoopEventHandlers {
  onMessageSaved: (message: Message<unknown>) => void;
  onStreamingStart: () => void;
  onStreamingUpdate: (groups: RenderingBlockGroup[]) => void;
  onStreamingEnd: () => void;
  onFirstChunk: () => void;
  onChatUpdated: (chat: Chat) => void;
  onProjectUpdated: (project: Project) => void;
  onPendingToolResult: (message: Message<unknown>) => void;
  onToolBlockUpdate: (toolUseId: string, block: Partial<ToolResultRenderBlock>) => void;
}

/**
 * Consume the agentic loop generator, handling events and persistence.
 * Returns the final accumulated tokens.
 */
async function consumeAgenticLoop(
  options: AgenticLoopOptions,
  context: Message<unknown>[],
  chat: Chat,
  project: Project,
  handlers: LoopEventHandlers
): Promise<TokenTotals> {
  const totals = createTokenTotals();
  let currentChat = chat;
  let lastContextWindowUsage = 0;
  let hasUnreliableCost = false;

  handlers.onStreamingStart();

  try {
    const gen = runAgenticLoop(options, context);

    let result: IteratorResult<
      AgenticLoopEvent,
      Awaited<ReturnType<typeof runAgenticLoop>> extends AsyncGenerator<infer _E, infer R, infer _N>
        ? R
        : never
    >;
    do {
      result = await gen.next();

      if (!result.done) {
        const event = result.value;

        switch (event.type) {
          case 'streaming_start':
            // Clear previous iteration's streaming content (multi-iteration agentic loops)
            handlers.onStreamingUpdate([]);
            break;

          case 'streaming_chunk':
            handlers.onStreamingUpdate(event.groups);
            break;

          case 'streaming_end':
            // Will call handlers.onStreamingEnd in finally
            break;

          case 'first_chunk':
            handlers.onFirstChunk();
            break;

          case 'message_created':
            // Save message to storage and notify UI
            await storage.saveMessage(chat.id, event.message);
            handlers.onMessageSaved(event.message);
            // Clear streaming content when assistant message is saved to prevent
            // any gap where both StreamingMessage and MessageBubble show same content
            handlers.onStreamingUpdate([]);
            // Track context window usage from assistant messages
            if (event.message.role === 'assistant' && event.message.metadata?.contextWindowUsage) {
              lastContextWindowUsage = event.message.metadata.contextWindowUsage;
            }
            // Track cost reliability
            if (event.message.metadata?.costUnreliable) {
              hasUnreliableCost = true;
            }
            break;

          case 'tokens_consumed': {
            addTokens(totals, event.tokens);
            // Incrementally update chat so UI shows real-time cost and data survives crashes
            const tokenChat: Chat = {
              ...currentChat,
              totalInputTokens: (currentChat.totalInputTokens ?? 0) + event.tokens.inputTokens,
              totalOutputTokens: (currentChat.totalOutputTokens ?? 0) + event.tokens.outputTokens,
              totalReasoningTokens:
                (currentChat.totalReasoningTokens ?? 0) + event.tokens.reasoningTokens,
              totalCacheCreationTokens:
                (currentChat.totalCacheCreationTokens ?? 0) + event.tokens.cacheCreationTokens,
              totalCacheReadTokens:
                (currentChat.totalCacheReadTokens ?? 0) + event.tokens.cacheReadTokens,
              totalCost: (currentChat.totalCost ?? 0) + event.tokens.cost,
              costUnreliable:
                event.tokens.costUnreliable || currentChat.costUnreliable || undefined,
            };
            currentChat = tokenChat;
            await storage.saveChat(tokenChat);
            handlers.onChatUpdated(tokenChat);
            break;
          }

          case 'pending_tool_result':
            handlers.onPendingToolResult(event.message);
            break;

          case 'tool_block_update':
            handlers.onToolBlockUpdate(event.toolUseId, event.block);
            break;
        }
      }
    } while (!result.done);

    // Handle final result status
    const finalResult = result.value;

    if (finalResult.status === 'error') {
      console.error('[useChat] Agentic loop error:', finalResult.error.message);
    } else if (finalResult.status === 'max_iterations') {
      console.warn('[useChat] Agentic loop reached max iterations');
    }

    // Final save: tokens already accumulated incrementally via tokens_consumed events,
    // just add the fields that are only available after the loop completes
    const updatedChat: Chat = {
      ...currentChat,
      contextWindowUsage: lastContextWindowUsage,
      messageCount: (chat.messageCount ?? 0) + finalResult.messages.length - context.length,
      lastModifiedAt: new Date(),
      costUnreliable: hasUnreliableCost || currentChat.costUnreliable || undefined,
    };
    await storage.saveChat(updatedChat);
    handlers.onChatUpdated(updatedChat);

    // Build and save final Project object with lastUsedAt
    const updatedProject: Project = {
      ...project,
      lastUsedAt: new Date(),
    };
    await storage.saveProject(updatedProject);
    handlers.onProjectUpdated(updatedProject);

    return totals;
  } finally {
    handlers.onStreamingEnd();
  }
}

/**
 * Build tool result message from tool results and render blocks.
 */
function buildToolResultMessage(
  apiType: APIDefinition['apiType'],
  toolResults: ToolResultBlock[],
  toolResultRenderBlocks: ToolResultRenderBlock[]
): Message<unknown> {
  const toolResultMessage = apiService.buildToolResultMessage(apiType, toolResults);

  toolResultMessage.content.renderingContent = [
    { category: 'backstage' as const, blocks: toolResultRenderBlocks },
  ];

  return toolResultMessage;
}

/**
 * Calculate context window usage from message metadata.
 */
function getContextWindowUsage(metadata?: {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
}): number {
  return (
    (metadata?.inputTokens || 0) +
    (metadata?.outputTokens || 0) +
    (metadata?.cacheCreationTokens || 0) +
    (metadata?.cacheReadTokens || 0) -
    (metadata?.reasoningTokens || 0)
  );
}

/**
 * Extract tool_use blocks from fullContent using apiService.
 * Uses the same logic as agenticLoop for consistency across all API types.
 */
function extractToolUseBlocksFromMessage(message: Message<unknown>): ToolUseBlock[] {
  const apiType = message.content.modelFamily;
  const fullContent = message.content.fullContent;

  if (!apiType || !fullContent) return [];

  return apiService.extractToolUseBlocks(apiType, fullContent) ?? [];
}

/**
 * Extract tool_result IDs from a message's renderingContent or fullContent.
 */
function extractToolResultIdsFromMessage(message: Message<unknown>): Set<string> {
  const ids = new Set<string>();

  // Check renderingContent
  const renderingContent = message.content.renderingContent;
  if (renderingContent) {
    for (const group of renderingContent) {
      if (group.category === 'backstage') {
        for (const block of group.blocks) {
          if (block.type === 'tool_result') {
            ids.add((block as ToolResultRenderBlock).tool_use_id);
          }
        }
      }
    }
  }

  // Also check fullContent for Anthropic format
  const fullContent = message.content.fullContent;
  if (Array.isArray(fullContent)) {
    for (const block of fullContent) {
      if ((block as Record<string, unknown>).type === 'tool_result') {
        ids.add((block as Record<string, unknown>).tool_use_id as string);
      }
    }
  }

  return ids;
}

/**
 * Detect unresolved tool calls in the message history.
 * Returns the unresolved ToolUseBlocks if any, or null if all are resolved.
 */
function getUnresolvedToolCalls(messages: Message<unknown>[]): ToolUseBlock[] | null {
  if (messages.length === 0) return null;

  // Find last assistant message
  let lastAssistantIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') {
      lastAssistantIdx = i;
      break;
    }
  }

  if (lastAssistantIdx === -1) return null;

  const lastAssistant = messages[lastAssistantIdx];

  // Extract tool_use blocks from the assistant message
  const toolUseBlocks = extractToolUseBlocksFromMessage(lastAssistant);
  if (toolUseBlocks.length === 0) return null;

  // Check if there's a following user message with tool_result for these IDs
  const toolUseIds = new Set(toolUseBlocks.map(t => t.id));

  // Look for tool_result in any message after the assistant message
  for (let i = lastAssistantIdx + 1; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === 'user') {
      const resultIds = extractToolResultIdsFromMessage(msg);
      for (const id of resultIds) {
        toolUseIds.delete(id);
      }
    }
  }

  // Return unresolved blocks
  if (toolUseIds.size === 0) return null;

  return toolUseBlocks.filter(t => toolUseIds.has(t.id));
}

export interface UseChatCallbacks {
  onMessagesLoaded: (chatId: string, messages: Message<unknown>[]) => void;
  onMessageAppended: (chatId: string, message: Message<unknown>) => void;
  onMessagesRemovedOnAndAfter: (chatId: string, afterMessageId: string) => void;
  onStreamingStart: (chatId: string, loadingText: string) => void;
  onStreamingEnd: (chatId: string) => void;
  onChatMetadataChanged?: (chatId: string, chat: Chat) => void;
  onForkMessageLoaded?: (chatId: string, message: string) => void;
}

export interface UseChatProps {
  chatId: string;
  callbacks: UseChatCallbacks;
}

export interface UseChatReturn {
  chat: Chat | null;
  messages: Message<unknown>[];
  isLoading: boolean;
  /** True once the first stream chunk has been received (reset when streaming ends) */
  hasReceivedFirstChunk: boolean;
  tokenUsage: TokenUsage;
  /** Streaming content groups for rendering during streaming */
  streamingGroups: RenderingBlockGroup[];
  currentApiDefId: string | null;
  currentModelId: string | null;
  parentApiDefId: string | null;
  parentModelId: string | null;
  /** Unresolved tool_use blocks that need user action (stop/continue) */
  unresolvedToolCalls: ToolUseBlock[] | null;
  sendMessage: (
    chatId: string,
    content: string,
    attachments?: MessageAttachment[]
  ) => Promise<void>;
  editMessage: (chatId: string, messageId: string, content: string) => void;
  copyMessage: (chatId: string, messageId: string) => Promise<void>;
  forkChat: (chatId: string, messageId: string) => Promise<Chat | null>;
  overrideModel: (chatId: string, apiDefId: string | null, modelId: string | null) => Promise<void>;
  updateChatName: (chatId: string, name: string) => Promise<void>;
  /** Resolve pending tool calls with stop (error) or continue (execute) */
  resolvePendingToolCalls: (
    mode: 'stop' | 'continue',
    userMessage?: string,
    attachments?: MessageAttachment[]
  ) => Promise<void>;
  /** Resend from a message - delete messages after and re-run agentic loop */
  resendFromMessage: (messageId: string) => Promise<void>;
}

export function useChat({ chatId, callbacks }: UseChatProps): UseChatReturn {
  const [project, setProject] = useState<Project | null>(null);
  const [chat, setChat] = useState<Chat | null>(null);
  const [messages, setMessages] = useState<Message<unknown>[]>([]);
  const [apiDefinition, setApiDefinition] = useState<APIDefinition | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [hasReceivedFirstChunk, setHasReceivedFirstChunk] = useState(false);

  // Streaming state for UI rendering
  const [streamingGroups, setStreamingGroups] = useState<RenderingBlockGroup[]>([]);

  // Track if we've resolved pending state to avoid double resolution
  const [pendingStateResolved, setPendingStateResolved] = useState(false);

  // Throttle refs for streaming UI updates
  const pendingStreamingRef = useRef<RenderingBlockGroup[] | null>(null);
  const streamingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingToolUpdatesRef = useRef<Map<string, Partial<ToolResultRenderBlock>>>(new Map());
  const toolUpdateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Verification helper to ensure chatId matches
  const verifyChatId = (incomingChatId: string, methodName: string): boolean => {
    if (incomingChatId !== chatId) {
      console.warn(
        `[useChat.${methodName}] chatId mismatch. Expected: ${chatId}, Got: ${incomingChatId}. Ignoring call.`
      );
      return false;
    }
    return true;
  };

  /** Apply a batch of accumulated tool block updates in a single setMessages call. */
  const applyToolBlockBatch = useCallback((batch: Map<string, Partial<ToolResultRenderBlock>>) => {
    setMessages(prev => {
      // Search backward in last 10 messages for the pending tool result message
      const searchStart = Math.max(0, prev.length - 10);
      let targetIdx = -1;
      for (let i = prev.length - 1; i >= searchStart; i--) {
        if (prev[i].role === 'user' && prev[i].content.renderingContent) {
          targetIdx = i;
          break;
        }
      }

      if (targetIdx < 0) return prev;

      const targetMsg = prev[targetIdx];
      const groups = targetMsg.content.renderingContent;
      if (!groups) return prev;

      let anyFound = false;
      const updatedGroups = groups.map(group => {
        if (group.category !== 'backstage') return group;
        const updatedBlocks = group.blocks.map(block => {
          if (block.type !== 'tool_result') return block;
          const update = batch.get((block as ToolResultRenderBlock).tool_use_id);
          if (update) {
            anyFound = true;
            return { ...block, ...update };
          }
          return block;
        });
        return { ...group, blocks: updatedBlocks };
      });

      if (!anyFound) return prev;

      const updatedMsg = {
        ...targetMsg,
        content: { ...targetMsg.content, renderingContent: updatedGroups },
      };
      return [...prev.slice(0, targetIdx), updatedMsg, ...prev.slice(targetIdx + 1)];
    });
  }, []);

  /**
   * Build event handlers for consuming the agentic loop generator.
   * Defined before useEffect so it can be used in pending state resolution.
   */
  const buildEventHandlers = useCallback(
    (): LoopEventHandlers => ({
      onMessageSaved: (msg: Message<unknown>) => {
        // Replace pending message if same ID exists, otherwise append.
        // Only search last 10 messages - replacements always target recent messages.
        setMessages(prev => {
          const searchStart = Math.max(0, prev.length - 10);
          for (let i = prev.length - 1; i >= searchStart; i--) {
            if (prev[i].id === msg.id) {
              const updated = [...prev];
              updated[i] = msg;
              return updated;
            }
          }
          return [...prev, msg];
        });
        callbacks.onMessageAppended(chatId, msg);
      },
      onStreamingStart: () => {
        setIsLoading(true);
        setHasReceivedFirstChunk(false);
        callbacks.onStreamingStart(chatId, 'Thinking...');
      },
      onStreamingUpdate: (groups: RenderingBlockGroup[]) => {
        pendingStreamingRef.current = groups;
        if (!streamingTimerRef.current) {
          streamingTimerRef.current = setTimeout(() => {
            streamingTimerRef.current = null;
            if (pendingStreamingRef.current !== null) {
              setStreamingGroups(pendingStreamingRef.current);
              pendingStreamingRef.current = null;
            }
          }, STREAMING_THROTTLE_MS);
        }
      },
      onStreamingEnd: () => {
        // Flush pending streaming update
        if (streamingTimerRef.current) {
          clearTimeout(streamingTimerRef.current);
          streamingTimerRef.current = null;
        }
        if (pendingStreamingRef.current !== null) {
          setStreamingGroups(pendingStreamingRef.current);
          pendingStreamingRef.current = null;
        }
        // Flush pending tool block updates
        if (toolUpdateTimerRef.current) {
          clearTimeout(toolUpdateTimerRef.current);
          toolUpdateTimerRef.current = null;
        }
        if (pendingToolUpdatesRef.current.size > 0) {
          const batch = new Map(pendingToolUpdatesRef.current);
          pendingToolUpdatesRef.current.clear();
          applyToolBlockBatch(batch);
        }
        setIsLoading(false);
        setStreamingGroups([]);
        callbacks.onStreamingEnd(chatId);
      },
      onFirstChunk: () => setHasReceivedFirstChunk(true),
      onChatUpdated: (updatedChat: Chat) => {
        setChat(updatedChat);
        callbacks.onChatMetadataChanged?.(chatId, updatedChat);
      },
      onProjectUpdated: (updatedProject: Project) => {
        setProject(updatedProject);
      },
      onPendingToolResult: (msg: Message<unknown>) => {
        setMessages(prev => {
          // Guard: skip if a message with this ID already exists (defensive against
          // StrictMode double-invocation edge cases). Only check last 10 messages.
          const searchStart = Math.max(0, prev.length - 10);
          for (let i = prev.length - 1; i >= searchStart; i--) {
            if (prev[i].id === msg.id) return prev;
          }
          return [...prev, msg];
        });
      },
      onToolBlockUpdate: (toolUseId: string, blockUpdate: Partial<ToolResultRenderBlock>) => {
        // Accumulate updates and flush on timer
        const existing = pendingToolUpdatesRef.current.get(toolUseId);
        pendingToolUpdatesRef.current.set(
          toolUseId,
          existing ? { ...existing, ...blockUpdate } : blockUpdate
        );
        if (!toolUpdateTimerRef.current) {
          toolUpdateTimerRef.current = setTimeout(() => {
            toolUpdateTimerRef.current = null;
            const batch = new Map(pendingToolUpdatesRef.current);
            pendingToolUpdatesRef.current.clear();
            applyToolBlockBatch(batch);
          }, STREAMING_THROTTLE_MS);
        }
      },
    }),
    [chatId, callbacks, applyToolBlockBatch]
  );

  // Cleanup throttle timers on unmount
  useEffect(() => {
    return () => {
      if (streamingTimerRef.current) clearTimeout(streamingTimerRef.current);
      if (toolUpdateTimerRef.current) clearTimeout(toolUpdateTimerRef.current);
    };
  }, []);

  // Single sequential loading effect to avoid race conditions
  useEffect(() => {
    let isCancelled = false;

    const loadChatData = async () => {
      console.debug('[useChat] Starting load sequence');

      // Reset pending state flag when chat changes
      setPendingStateResolved(false);

      // 1. Load chat first
      let loadedChat = await storage.getChat(chatId);
      if (!loadedChat) {
        throw new Error(`Chat not found: ${chatId}`);
      }
      if (isCancelled) return;
      console.debug('[useChat] Chat loaded, has pendingState:', !!loadedChat.pendingState);

      // 1a. Migrate chat if it doesn't have the new totalCost field
      if (loadedChat.totalCost === undefined) {
        console.debug('[useChat] Migrating chat from old tracking model');

        // Load messages to calculate old-style totals
        const messages = await storage.getMessages(chatId);

        let totalInput = loadedChat.sinkInputTokens || 0;
        let totalOutput = loadedChat.sinkOutputTokens || 0;
        let totalReasoning = loadedChat.sinkReasoningTokens || 0;
        let totalCacheCreation = loadedChat.sinkCacheCreationTokens || 0;
        let totalCacheRead = loadedChat.sinkCacheReadTokens || 0;
        let totalCost = loadedChat.sinkCost || 0;
        let contextWindowUsage = 0;

        // Add current messages
        for (const msg of messages) {
          if (msg.metadata) {
            totalInput += msg.metadata.inputTokens || 0;
            totalOutput += msg.metadata.outputTokens || 0;
            totalReasoning += msg.metadata.reasoningTokens || 0;
            totalCacheCreation += msg.metadata.cacheCreationTokens || 0;
            totalCacheRead += msg.metadata.cacheReadTokens || 0;
            totalCost += msg.metadata.messageCost || 0;

            // Migrate contextWindowUsage and get latest value from assistant messages
            if (msg.role === 'assistant') {
              if (msg.metadata.contextWindowUsage === undefined) {
                msg.metadata.contextWindowUsage = getContextWindowUsage(msg.metadata);
                await storage.saveMessage(chatId, msg);
              }
              contextWindowUsage = msg.metadata.contextWindowUsage;
            }
          }
        }

        // Update chat with new totals and clear sink costs
        loadedChat = {
          ...loadedChat,
          totalInputTokens: totalInput,
          totalOutputTokens: totalOutput,
          totalReasoningTokens: totalReasoning,
          totalCacheCreationTokens: totalCacheCreation,
          totalCacheReadTokens: totalCacheRead,
          totalCost: totalCost,
          contextWindowUsage: contextWindowUsage,
          contextWindowUsageMigrated: true,
          // Clear deprecated sink costs
          sinkInputTokens: undefined,
          sinkOutputTokens: undefined,
          sinkReasoningTokens: undefined,
          sinkCacheCreationTokens: undefined,
          sinkCacheReadTokens: undefined,
          sinkCost: undefined,
        };

        await storage.saveChat(loadedChat);
        console.debug('[useChat] Chat migrated successfully');
      }

      setChat(loadedChat);

      // 2. Load project using chat's projectId
      const loadedProject = await storage.getProject(loadedChat.projectId);
      if (!loadedProject) {
        throw new Error(`Project not found: ${loadedChat.projectId}`);
      }
      if (isCancelled) return;
      console.debug('[useChat] Project loaded');
      setProject(loadedProject);

      // 3. Load messages
      const loadedMessages = await storage.getMessages(chatId);
      if (isCancelled) return;
      console.debug('[useChat] Messages loaded, count:', loadedMessages.length);

      // 3a. Lightweight migration: contextWindowUsage for old messages
      if (!loadedChat.contextWindowUsageMigrated) {
        console.debug('[useChat] Running contextWindowUsage migration');

        for (const msg of loadedMessages) {
          if (msg.role === 'assistant' && msg.metadata) {
            if (msg.metadata.contextWindowUsage === undefined) {
              msg.metadata.contextWindowUsage = getContextWindowUsage(msg.metadata);
              await storage.saveMessage(chatId, msg);
            }
            loadedChat.contextWindowUsage = msg.metadata.contextWindowUsage;
          }
        }

        loadedChat.contextWindowUsageMigrated = true;
        await storage.saveChat(loadedChat);
      }

      // 3b. Lightweight migration: renderingContent for messages without it
      for (const msg of loadedMessages) {
        if (msg.role === 'assistant' && !msg.content.renderingContent) {
          // Only migrate messages that have fullContent or content to render
          if (msg.content.fullContent || msg.content.content) {
            console.debug('[useChat] Migrating renderingContent for message:', msg.id);
            const { renderingContent, stopReason } = apiService.migrateMessageRendering(
              msg.content.modelFamily,
              msg.content.fullContent ?? msg.content.content,
              null // stopReason not stored on old messages
            );
            msg.content.renderingContent = renderingContent;
            msg.content.stopReason = stopReason;
            await storage.saveMessage(chatId, msg);
          }
        }
      }

      setMessages(loadedMessages);
      callbacks.onMessagesLoaded(chatId, loadedMessages);

      // 3c. Load API definition
      let loadedApiDef: APIDefinition | null = null;
      const effectiveApiDefId = loadedChat.apiDefinitionId ?? loadedProject.apiDefinitionId;
      if (effectiveApiDefId) {
        loadedApiDef = await storage.getAPIDefinition(effectiveApiDefId);
        if (isCancelled) return;
        if (loadedApiDef) {
          console.debug('[useChat] API definition loaded:', loadedApiDef.name);
          setApiDefinition(loadedApiDef);
        }
      }

      // 5. Resolve pending state (if any)
      if (loadedChat.pendingState && !pendingStateResolved) {
        console.debug('[useChat] Resolving pending state, type:', loadedChat.pendingState.type);
        setPendingStateResolved(true);

        // Clear pending state first
        const updatedChat: Chat = {
          ...loadedChat,
          pendingState: undefined,
          lastModifiedAt: new Date(),
        };
        await storage.saveChat(updatedChat);
        if (isCancelled) return;
        setChat(updatedChat);
        callbacks.onChatMetadataChanged?.(chatId, updatedChat);

        const messageText = loadedChat.pendingState.content.message.trim();
        const attachments = loadedChat.pendingState.content.attachments;

        // Handle different pending state types
        if (loadedChat.pendingState.type === 'userMessage' && loadedApiDef) {
          // Send message to API with attachments if present
          if ((messageText || attachments?.length) && !isCancelled) {
            console.debug('[useChat] Running agentic loop for pending message');
            if (!messageText) {
              updatedChat.name = 'Unnamed Image';
              await storage.saveChat(updatedChat);
            }

            const effectiveModelId = updatedChat.modelId ?? loadedProject.modelId;
            if (effectiveModelId) {
              const model = await storage.getModel(loadedApiDef.id, effectiveModelId);
              if (!model) {
                console.error('[useChat] Model not found:', effectiveModelId);
                return;
              }

              // Create and save user message
              const firstMessageTimestamp =
                loadedMessages.length > 0 ? loadedMessages[0].timestamp : undefined;
              const userMessage = await createAndSaveUserMessage(
                updatedChat.id,
                messageText,
                loadedProject,
                updatedChat,
                effectiveModelId,
                firstMessageTimestamp,
                attachments
              );

              // Update React state with user message and notify UI
              setMessages(prev => [...prev, userMessage]);
              callbacks.onMessageAppended(chatId, userMessage);

              // Build context with user message
              const context = [...loadedMessages, userMessage];

              // Build loop options
              const options = await buildAgenticLoopOptions(
                updatedChat,
                loadedProject,
                loadedApiDef,
                model,
                effectiveModelId
              );

              // Consume the agentic loop generator (fire and forget, no await to avoid blocking)
              consumeAgenticLoop(
                options,
                context,
                updatedChat,
                loadedProject,
                buildEventHandlers()
              );
            }
          }
        } else if (loadedChat.pendingState.type === 'forkMessage') {
          // Just populate the input box, don't send
          if (messageText) {
            console.debug('[useChat] Loading fork message into input');
            // Strip metadata before loading into input
            const messageWithoutMetadata = stripMetadata(messageText);
            callbacks.onForkMessageLoaded?.(chatId, messageWithoutMetadata);
          }
        }
      }
    };

    loadChatData();

    return () => {
      isCancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId, callbacks, buildEventHandlers]);

  // Token usage derived from chat-level totals
  const tokenUsage: TokenUsage = useMemo(() => {
    if (!chat) {
      return { input: 0, output: 0, cost: 0 };
    }
    return {
      input: chat.totalInputTokens || 0,
      output: chat.totalOutputTokens || 0,
      reasoning: (chat.totalReasoningTokens || 0) > 0 ? chat.totalReasoningTokens : undefined,
      cacheCreation:
        (chat.totalCacheCreationTokens || 0) > 0 ? chat.totalCacheCreationTokens : undefined,
      cacheRead: (chat.totalCacheReadTokens || 0) > 0 ? chat.totalCacheReadTokens : undefined,
      cost: chat.totalCost || 0,
    };
  }, [chat]);

  // Reload API definition when chat/project API definition changes
  useEffect(() => {
    if (!chat || !project) return;

    const effectiveApiDefId = chat.apiDefinitionId ?? project.apiDefinitionId;

    // Only reload if the effective API definition has changed
    if (effectiveApiDefId && effectiveApiDefId !== apiDefinition?.id) {
      console.debug('[useChat] API definition changed, reloading:', effectiveApiDefId);

      storage.getAPIDefinition(effectiveApiDefId).then(loadedApiDef => {
        if (loadedApiDef) {
          setApiDefinition(loadedApiDef);
        }
      });
    }
  }, [chat?.apiDefinitionId, project?.apiDefinitionId, apiDefinition?.id]);

  const sendMessage = async (
    incomingChatId: string,
    content: string,
    attachments?: MessageAttachment[]
  ) => {
    if (!verifyChatId(incomingChatId, 'sendMessage')) return;

    const messageText = content.trim();
    // Allow sending if there's text OR attachments
    if ((!messageText && !attachments?.length) || !chat || !project || !apiDefinition) return;

    const effectiveModelId = chat.modelId ?? project.modelId;
    if (!effectiveModelId) {
      showAlert('Configuration Required', 'Please configure a model for this chat or project.');
      return;
    }

    const model = await storage.getModel(apiDefinition.id, effectiveModelId);
    if (!model) {
      showAlert('Model Not Found', `Model ${effectiveModelId} not found in ${apiDefinition.name}.`);
      return;
    }

    // Create and save user message
    const firstMessageTimestamp = messages.length > 0 ? messages[0].timestamp : undefined;
    const userMessage = await createAndSaveUserMessage(
      chat.id,
      messageText,
      project,
      chat,
      effectiveModelId,
      firstMessageTimestamp,
      attachments
    );

    // Update React state with user message and notify UI
    setMessages(prev => [...prev, userMessage]);
    callbacks.onMessageAppended(chatId, userMessage);

    // Build context with user message
    const context = [...messages, userMessage];

    // Build loop options
    const options = await buildAgenticLoopOptions(
      chat,
      project,
      apiDefinition,
      model,
      effectiveModelId
    );

    // Consume the agentic loop generator
    await consumeAgenticLoop(options, context, chat, project, buildEventHandlers());
  };

  const editMessage = async (incomingChatId: string, messageId: string, _content: string) => {
    if (!verifyChatId(incomingChatId, 'editMessage')) return;
    if (!chat) return;

    const messageIndex = messages.findIndex(m => m.id === messageId);
    if (messageIndex === -1) return;

    // Recalculate context window from remaining messages
    const remainingMessages = messages.slice(0, messageIndex);
    let contextWindowUsage = 0;

    // Find last assistant message's context window usage
    for (let i = remainingMessages.length - 1; i >= 0; i--) {
      const msg = remainingMessages[i];
      if (msg.role === 'assistant' && msg.metadata?.contextWindowUsage !== undefined) {
        contextWindowUsage = msg.metadata.contextWindowUsage;
        break;
      }
    }

    // Update chat (DO NOT modify totals, they're cumulative)
    const updatedChat = {
      ...chat,
      contextWindowUsage: contextWindowUsage,
      lastModifiedAt: new Date(),
    };

    // Update local state and UI first
    setChat(updatedChat);
    setMessages(prev => prev.slice(0, messageIndex));

    callbacks.onChatMetadataChanged?.(updatedChat.id, updatedChat);
    callbacks.onMessagesRemovedOnAndAfter(updatedChat.id, messageId);

    await storage.saveChat(updatedChat);
    await storage.deleteMessageAndAfter(incomingChatId, messageId);
  };

  const copyMessage = async (_incomingChatId: string, messageId: string) => {
    // copyMessage does not need verifyChatId since messageId is unique
    const message = messages.find(m => m.id === messageId);
    if (!message) return;

    try {
      // Strip metadata before copying
      const contentWithoutMetadata = stripMetadata(message.content.content);
      await navigator.clipboard.writeText(contentWithoutMetadata);
      showAlert('Copied', 'Message copied to clipboard');
    } catch (_error) {
      showAlert('Error', 'Failed to copy message');
    }
  };

  const forkChat = async (incomingChatId: string, messageId: string): Promise<Chat | null> => {
    if (!verifyChatId(incomingChatId, 'forkChat')) return null;
    if (!chat || !project) return null;

    // Find the message to get its content
    const message = messages.find(m => m.id === messageId);
    const messageContent = message?.content.content;

    // Pass message content to cloneChat
    const newChat = await storage.cloneChat(chat.id, project.id, messageId, messageContent);

    return newChat;
  };

  const overrideModel = async (
    incomingChatId: string,
    apiDefId: string | null,
    modelId: string | null
  ) => {
    if (!verifyChatId(incomingChatId, 'overrideModel')) return;
    if (!chat) return;

    const updatedChat = {
      ...chat,
      apiDefinitionId: apiDefId,
      modelId: modelId,
      lastModifiedAt: new Date(),
    };

    setChat(updatedChat);
    callbacks.onChatMetadataChanged?.(incomingChatId, updatedChat);
    await storage.saveChat(updatedChat);
  };

  const updateChatName = async (incomingChatId: string, name: string) => {
    if (!verifyChatId(incomingChatId, 'updateChatName')) return;
    if (!chat || !name.trim()) return;

    const updatedChat = {
      ...chat,
      name: name.trim(),
      lastModifiedAt: new Date(),
    };

    setChat(updatedChat);
    callbacks.onChatMetadataChanged?.(chat.id, updatedChat);
    await storage.saveChat(updatedChat);
  };

  // Memoized detection of unresolved tool calls
  const unresolvedToolCalls = useMemo(() => {
    if (isLoading) return null;
    return getUnresolvedToolCalls(messages);
  }, [messages, isLoading]);

  /**
   * Resolve pending tool calls by either stopping (error response) or continuing (execute tools).
   * Both modes send to API via runAgenticLoop. Optionally appends a user message after the tool results.
   *
   * Stop mode: builds error tool results immediately, then sends to API.
   * Continue mode: delegates tool execution to the agentic loop for full streaming support.
   */
  const resolvePendingToolCalls = async (
    mode: 'stop' | 'continue',
    userMessage?: string,
    attachments?: MessageAttachment[]
  ) => {
    if (!chat || !project || !apiDefinition) return;
    if (!unresolvedToolCalls || unresolvedToolCalls.length === 0) return;

    console.debug('[useChat] resolvePendingToolCalls called, mode:', mode);

    const effectiveModelId = chat.modelId ?? project.modelId;
    if (!effectiveModelId) return;

    const model = await storage.getModel(apiDefinition.id, effectiveModelId);
    if (!model) return;

    // Build loop options (shared by both modes)
    const options = await buildAgenticLoopOptions(
      chat,
      project,
      apiDefinition,
      model,
      effectiveModelId
    );

    if (mode === 'continue') {
      // Continue mode: delegate tool execution to the agentic loop for streaming
      options.pendingToolUseBlocks = unresolvedToolCalls;

      const context = [...messages];

      // If user message provided, save it and pass as trailing context
      // (injected after tool results by the loop for correct API ordering)
      if (userMessage?.trim() || attachments?.length) {
        const messageText = userMessage?.trim() || '';
        const firstMessageTimestamp = messages.length > 0 ? messages[0].timestamp : undefined;

        const userMsg = await createAndSaveUserMessage(
          chat.id,
          messageText,
          project,
          chat,
          effectiveModelId,
          firstMessageTimestamp,
          attachments
        );

        options.pendingTrailingContext = [userMsg];
      }

      await consumeAgenticLoop(options, context, chat, project, buildEventHandlers());
    } else {
      // Stop mode: build error tool results immediately (no streaming needed)
      const toolResults: ToolResultBlock[] = [];
      const toolResultRenderBlocks: ToolResultRenderBlock[] = [];

      for (const toolUse of unresolvedToolCalls) {
        const errorMessage = 'Error, ask user to continue';
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

      const toolResultMessage = buildToolResultMessage(
        apiDefinition.apiType,
        toolResults,
        toolResultRenderBlocks
      );

      // Save tool result message to storage
      await storage.saveMessage(chat.id, toolResultMessage);

      // Update React state with tool result message and notify UI
      setMessages(prev => [...prev, toolResultMessage]);
      callbacks.onMessageAppended(chatId, toolResultMessage);

      // Build context with tool result message
      let context = [...messages, toolResultMessage];

      // If user message provided, add it to context
      if (userMessage?.trim() || attachments?.length) {
        const messageText = userMessage?.trim() || '';
        const firstMessageTimestamp = messages.length > 0 ? messages[0].timestamp : undefined;

        const userMsg = await createAndSaveUserMessage(
          chat.id,
          messageText,
          project,
          chat,
          effectiveModelId,
          firstMessageTimestamp,
          attachments
        );

        setMessages(prev => [...prev, userMsg]);
        callbacks.onMessageAppended(chatId, userMsg);

        context = [...context, userMsg];
      }

      await consumeAgenticLoop(options, context, chat, project, buildEventHandlers());
    }
  };

  /**
   * Resend from a message - delete messages after and re-run agentic loop.
   * Useful when a costly tool call succeeded but the following API call failed.
   */
  const resendFromMessage = async (messageId: string) => {
    if (!chat || !project || !apiDefinition) return;

    const msgIndex = messages.findIndex(m => m.id === messageId);
    if (msgIndex === -1) return;

    const targetMessage = messages[msgIndex];
    console.debug(
      '[useChat] resendFromMessage called, messageId:',
      messageId,
      'role:',
      targetMessage.role
    );

    const effectiveModelId = chat.modelId ?? project.modelId;
    if (!effectiveModelId) {
      showAlert('Configuration Required', 'Please configure a model for this chat or project.');
      return;
    }

    const model = await storage.getModel(apiDefinition.id, effectiveModelId);
    if (!model) {
      showAlert('Model Not Found', `Model ${effectiveModelId} not found in ${apiDefinition.name}.`);
      return;
    }

    // Delete messages AFTER the target (keep the target message)
    if (msgIndex + 1 < messages.length) {
      const nextMessageId = messages[msgIndex + 1].id;
      await storage.deleteMessageAndAfter(chat.id, nextMessageId);
      callbacks.onMessagesRemovedOnAndAfter(chat.id, nextMessageId);
    }

    // Update state to keep only messages up to and including target
    const context = messages.slice(0, msgIndex + 1);
    setMessages(context);

    // Recalculate context window from remaining messages
    let contextWindowUsage = 0;
    for (let i = context.length - 1; i >= 0; i--) {
      const msg = context[i];
      if (msg.role === 'assistant' && msg.metadata?.contextWindowUsage !== undefined) {
        contextWindowUsage = msg.metadata.contextWindowUsage;
        break;
      }
    }

    // Update chat context window usage
    const updatedChat = {
      ...chat,
      contextWindowUsage,
      lastModifiedAt: new Date(),
    };
    await storage.saveChat(updatedChat);
    setChat(updatedChat);
    callbacks.onChatMetadataChanged?.(chat.id, updatedChat);

    // Build loop options and re-run agentic loop from this context
    const options = await buildAgenticLoopOptions(
      updatedChat,
      project,
      apiDefinition,
      model,
      effectiveModelId
    );

    await consumeAgenticLoop(options, context, updatedChat, project, buildEventHandlers());
  };

  return {
    chat,
    messages,
    isLoading,
    hasReceivedFirstChunk,
    tokenUsage,
    streamingGroups,
    currentApiDefId: chat?.apiDefinitionId ?? project?.apiDefinitionId ?? null,
    currentModelId: chat?.modelId ?? project?.modelId ?? null,
    parentApiDefId: project?.apiDefinitionId ?? null,
    parentModelId: project?.modelId ?? null,
    unresolvedToolCalls,
    sendMessage,
    editMessage,
    copyMessage,
    forkChat,
    overrideModel,
    updateChatName,
    resolvePendingToolCalls,
    resendFromMessage,
  };
}
