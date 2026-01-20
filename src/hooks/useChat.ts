import { useEffect, useState, useMemo, useCallback } from 'react';
import Mustache from 'mustache';
import { apiService } from '../services/api/apiService';
import { storage } from '../services/storage';
import {
  initMemoryTool,
  disposeMemoryTool,
  setMemoryUseSystemPrompt,
} from '../services/tools/memoryTool';
import { initFsTool, disposeFsTool } from '../services/tools/fsTool';
import { initJsTool, disposeJsTool } from '../services/tools/jsTool';
import {
  runAgenticLoop,
  executeToolsAndBuildPendingMessage,
  buildErrorToolResultPendingMessage,
  type AgenticLoopContext,
  type AgenticLoopCallbacks,
  type PendingMessage,
} from './agenticLoop';
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
} from '../types';
import type { ToolResultRenderBlock } from '../types/content';

import { generateUniqueId } from '../utils/idGenerator';
import { showAlert } from '../utils/alerts';

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
 * Parameters for preparing and sending a user message via the agentic loop.
 */
interface PrepareAndSendParams {
  messageText: string;
  attachments?: MessageAttachment[];
  chatId: string;
  chat: Chat;
  project: Project;
  apiDef: APIDefinition;
  model: Model | undefined;
  effectiveModelId: string;
  currentMessages: Message<unknown>[];
  loopCallbacks: AgenticLoopCallbacks;
  /** Messages to send before the user message (e.g., tool results) */
  prependPendingMessages?: PendingMessage[];
}

/**
 * Prepare a user message (with metadata, attachments) and run the agentic loop.
 * Shared logic for sendMessage, resolvePendingToolCalls, and pendingState handling.
 */
async function prepareAndSendUserMessage(params: PrepareAndSendParams): Promise<void> {
  const {
    messageText,
    attachments,
    chatId,
    chat,
    project,
    apiDef,
    model,
    effectiveModelId,
    currentMessages,
    loopCallbacks,
    prependPendingMessages = [],
  } = params;

  // Generate message with metadata/template applied
  const firstMessageTimestamp =
    currentMessages.length > 0 ? currentMessages[0].timestamp : undefined;
  const messageWithMetadata = generateMessageWithMetadata(
    messageText,
    project,
    chat,
    effectiveModelId,
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
    console.debug(
      `[useChat] Saving ${attachments.length} attachments for message ${userMessage.id}`
    );
    for (const attachment of attachments) {
      await storage.saveAttachment(userMessage.id, attachment);
    }
  }

  // Build context for agentic loop
  const context: AgenticLoopContext = {
    chatId,
    chat,
    project,
    apiDef,
    modelId: effectiveModelId,
    model,
    currentMessages,
  };

  // Combine prepended messages with user message
  const pending: PendingMessage[] = [
    ...prependPendingMessages,
    { type: 'user', message: userMessage },
  ];

  await runAgenticLoop(context, pending, loopCallbacks);
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

      // 3c. Initialize memory tool if enabled
      if (loadedProject.memoryEnabled) {
        console.debug('[useChat] Initializing memory tool for project:', loadedProject.id);
        // Set system prompt mode before initializing
        setMemoryUseSystemPrompt(loadedProject.id, loadedProject.memoryUseSystemPrompt ?? false);
        await initMemoryTool(loadedProject.id);
        if (isCancelled) return;
      }

      // 3d. Initialize JavaScript tool if enabled
      if (loadedProject.jsExecutionEnabled) {
        console.debug('[useChat] Initializing JavaScript tool');
        initJsTool();
      }

      // 3e. Initialize filesystem tool if enabled
      if (loadedProject.fsToolEnabled) {
        console.debug('[useChat] Initializing filesystem tool for project:', loadedProject.id);
        await initFsTool(loadedProject.id);
        if (isCancelled) return;
      }

      // 4. Load API definition
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

              // Build callbacks that update React state
              const loopCallbacks: AgenticLoopCallbacks = {
                onMessageSaved: (msg: Message<unknown>) => {
                  setMessages(prev => [...prev, msg]);
                  callbacks.onMessageAppended(chatId, msg);
                },
                onStreamingStart: (text: string) => {
                  setIsLoading(true);
                  setHasReceivedFirstChunk(false);
                  callbacks.onStreamingStart(chatId, text);
                },
                onStreamingUpdate: (groups: RenderingBlockGroup[]) => {
                  setStreamingGroups(groups);
                },
                onStreamingEnd: () => {
                  setIsLoading(false);
                  setStreamingGroups([]);
                  callbacks.onStreamingEnd(chatId);
                },
                onFirstChunk: () => setHasReceivedFirstChunk(true),
                onChatUpdated: (chat: Chat) => {
                  setChat(chat);
                  callbacks.onChatMetadataChanged?.(chatId, chat);
                },
                onProjectUpdated: (project: Project) => {
                  setProject(project);
                },
                onError: (error: Error) => console.error('[useChat] Loop error:', error),
              };

              // Use shared helper for message preparation and loop invocation
              prepareAndSendUserMessage({
                messageText,
                attachments,
                chatId,
                chat: updatedChat,
                project: loadedProject,
                apiDef: loadedApiDef,
                model,
                effectiveModelId,
                currentMessages: loadedMessages,
                loopCallbacks,
              });
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
  }, [chatId, callbacks]);

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

  // Cleanup memory tool when project changes or unmounts
  useEffect(() => {
    return () => {
      if (project?.id && project.memoryEnabled) {
        console.debug('[useChat] Disposing memory tool for project:', project.id);
        disposeMemoryTool(project.id);
      }
    };
  }, [project?.id, project?.memoryEnabled]);

  // Cleanup JavaScript tool when project changes or unmounts
  useEffect(() => {
    return () => {
      if (project?.jsExecutionEnabled) {
        console.debug('[useChat] Disposing JavaScript tool');
        disposeJsTool();
      }
    };
  }, [project?.jsExecutionEnabled]);

  // Cleanup filesystem tool when project changes or unmounts
  useEffect(() => {
    return () => {
      if (project?.id && project.fsToolEnabled) {
        console.debug('[useChat] Disposing filesystem tool for project:', project.id);
        disposeFsTool(project.id);
      }
    };
  }, [project?.id, project?.fsToolEnabled]);

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

  /**
   * Build agentic loop callbacks that update React state.
   * The loop handles storage saves; callbacks are pure state setters.
   */
  const buildLoopCallbacks = useCallback(
    (): AgenticLoopCallbacks => ({
      onMessageSaved: (msg: Message<unknown>) => {
        setMessages(prev => [...prev, msg]);
        callbacks.onMessageAppended(chatId, msg);
      },
      onStreamingStart: (text: string) => {
        setIsLoading(true);
        setHasReceivedFirstChunk(false);
        callbacks.onStreamingStart(chatId, text);
      },
      onStreamingUpdate: (groups: RenderingBlockGroup[]) => {
        setStreamingGroups(groups);
      },
      onStreamingEnd: () => {
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
      onError: (error: Error) => console.error('[useChat] Loop error:', error),
    }),
    [chatId, callbacks]
  );

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

    await prepareAndSendUserMessage({
      messageText,
      attachments,
      chatId,
      chat,
      project,
      apiDef: apiDefinition,
      model,
      effectiveModelId,
      currentMessages: messages,
      loopCallbacks: buildLoopCallbacks(),
    });
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

    // Build tool result message based on mode
    const toolResultPending =
      mode === 'stop'
        ? buildErrorToolResultPendingMessage(apiDefinition.apiType, unresolvedToolCalls)
        : await executeToolsAndBuildPendingMessage(apiDefinition.apiType, unresolvedToolCalls);

    const model = await storage.getModel(apiDefinition.id, effectiveModelId);

    // If user message provided, use shared helper with tool results prepended
    if (userMessage?.trim() || attachments?.length) {
      await prepareAndSendUserMessage({
        messageText: userMessage?.trim() || '',
        attachments,
        chatId: chat.id,
        chat,
        project,
        apiDef: apiDefinition,
        model,
        effectiveModelId,
        currentMessages: messages,
        loopCallbacks: buildLoopCallbacks(),
        prependPendingMessages: [toolResultPending],
      });
    } else {
      // No user message - run loop with tool results only
      const context: AgenticLoopContext = {
        chatId: chat.id,
        chat,
        project,
        apiDef: apiDefinition,
        modelId: effectiveModelId,
        model,
        currentMessages: messages,
      };
      await runAgenticLoop(context, [toolResultPending], buildLoopCallbacks());
    }
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
  };
}
