import { useEffect, useRef, useState } from 'react';
import { apiService } from '../services/api/apiService';
import { storage } from '../services/storage';
import { StreamingContentAssembler } from '../services/streaming/StreamingContentAssembler';
import { executeClientSideTool, toolRegistry } from '../services/tools/clientSideTools';
import { initMemoryTool, disposeMemoryTool } from '../services/tools/memoryTool';
import type {
  APIDefinition,
  Chat,
  Message,
  MessageAttachment,
  Project,
  RenderingBlockGroup,
  TokenUsage,
  ToolResultBlock,
} from '../types';
import type { ToolResultRenderBlock } from '../types/content';

import { MessageRole } from '../types';
import { generateUniqueId } from '../utils/idGenerator';
import { showAlert } from '../utils/alerts';

// Maximum agentic loop iterations to prevent infinite loops
const MAX_TOOL_ITERATIONS = 10;

/**
 * Generate metadata XML to prepend to user messages
 */
function generateMessageMetadata(project: Project, chat: Chat): string {
  if (!project.sendMessageMetadata) {
    return '';
  }

  const metadataParts: string[] = [];

  // Add timestamp if enabled
  if (project.metadataTimestampMode && project.metadataTimestampMode !== 'disabled') {
    const timezone = project.metadataTimestampMode === 'utc' ? 'UTC' : undefined;
    const formatter = new Intl.DateTimeFormat('en-US', {
      weekday: 'short',
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      timeZoneName: 'short',
      timeZone: timezone,
    });

    metadataParts.push(`<timestamp>${formatter.format(new Date())}</timestamp>`);
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
    return '';
  }

  return `<metadata>\n${metadataParts.join('\n')}\n</metadata>\n\n`;
}

/**
 * Strip metadata XML from message content
 */
function stripMetadata(content: string): string {
  return content.replace(/^<metadata>.*?<\/metadata>\s*/s, '');
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
  tokenUsage: TokenUsage;
  /** Streaming content groups for rendering during streaming */
  streamingGroups: RenderingBlockGroup[];
  /** Last event string from streaming (for status display) */
  streamingLastEvent: string;
  currentApiDefId: string | null;
  currentModelId: string | null;
  parentApiDefId: string | null;
  parentModelId: string | null;
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
}

export function useChat({ chatId, callbacks }: UseChatProps): UseChatReturn {
  const [project, setProject] = useState<Project | null>(null);
  const [chat, setChat] = useState<Chat | null>(null);
  const [messages, setMessages] = useState<Message<unknown>[]>([]);
  const [apiDefinition, setApiDefinition] = useState<APIDefinition | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [tokenUsage, setTokenUsage] = useState<TokenUsage>({
    input: 0,
    output: 0,
    cost: 0,
  });

  // Streaming state for UI rendering
  const [streamingGroups, setStreamingGroups] = useState<RenderingBlockGroup[]>([]);
  const [streamingLastEvent, setStreamingLastEvent] = useState<string>('');

  // Streaming assembler ref (created per API call)
  const assemblerRef = useRef<StreamingContentAssembler | null>(null);

  // Track if we've resolved pending state to avoid double resolution
  const pendingStateResolved = useRef(false);

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
      pendingStateResolved.current = false;

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
            if (msg.role === MessageRole.ASSISTANT) {
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
          if (msg.role === MessageRole.ASSISTANT && msg.metadata) {
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
        if (msg.role === MessageRole.ASSISTANT && !msg.content.renderingContent) {
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
        await initMemoryTool(loadedProject.id);
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
      if (loadedChat.pendingState && !pendingStateResolved.current) {
        console.debug('[useChat] Resolving pending state, type:', loadedChat.pendingState.type);
        pendingStateResolved.current = true;

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
            console.debug('[useChat] Calling sendMessageToAPI for pending message');
            if (!messageText) {
              updatedChat.name = 'Unnamed Image';
            }
            sendMessageToAPI(
              messageText,
              loadedMessages,
              updatedChat,
              loadedProject,
              loadedApiDef,
              attachments
            );
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

  // Calculate token usage when messages change
  useEffect(() => {
    if (messages.length > 0 && chat) {
      calculateTotalTokens();
    }
  }, [messages, chat]);

  // Cleanup memory tool when project changes or unmounts
  useEffect(() => {
    return () => {
      if (project?.id && project.memoryEnabled) {
        console.debug('[useChat] Disposing memory tool for project:', project.id);
        disposeMemoryTool(project.id);
      }
    };
  }, [project?.id, project?.memoryEnabled]);

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

  const sendMessageToAPI = async (
    messageText: string,
    currentMessages: Message<unknown>[],
    currentChat: Chat,
    currentProject: Project,
    currentApiDef: APIDefinition,
    attachments?: MessageAttachment[]
  ) => {
    console.debug('[useChat] sendMessageToAPI called');

    const streamingChatId = currentChat.id;
    const effectiveApiDefId = currentChat.apiDefinitionId ?? currentProject.apiDefinitionId;
    const effectiveModelId = currentChat.modelId ?? currentProject.modelId;

    if (!effectiveApiDefId || !effectiveModelId) {
      console.debug('[useChat] Missing API/model configuration');
      showAlert(
        'Configuration Required',
        'Please configure an API and model for this chat or project.'
      );
      return;
    }

    // Generate metadata if enabled and prepend to message
    const metadata = generateMessageMetadata(currentProject, currentChat);
    const messageWithMetadata = metadata + messageText;

    // Extract attachment IDs if any
    const attachmentIds = attachments?.map(att => att.id) || [];

    // Create and save user message
    const userMessage: Message<string> = {
      id: generateUniqueId('msg_user'),
      role: MessageRole.USER,
      content: {
        type: 'text',
        content: messageWithMetadata,
        ...(attachmentIds.length > 0 && {
          attachmentIds,
          originalAttachmentCount: attachmentIds.length,
        }),
      },
      timestamp: new Date(),
    };

    await storage.saveMessage(streamingChatId, userMessage);
    console.debug('[useChat] User message saved');

    // Save attachments if any
    if (attachments && attachments.length > 0) {
      console.debug(
        `[useChat] Saving ${attachments.length} attachments for message ${userMessage.id}`
      );
      for (const attachment of attachments) {
        await storage.saveAttachment(userMessage.id, attachment);
      }
      console.debug('[useChat] All attachments saved');
    }
    setMessages(prev => [...prev, userMessage]);
    callbacks.onMessageAppended(streamingChatId, userMessage);

    setIsLoading(true);
    callbacks.onStreamingStart(streamingChatId, 'Thinking...');

    const updateChat: Partial<Chat> = {};
    try {
      // Load attachments for all user messages that have them
      // Check for missing attachments and prepend system note if any are missing
      const messagesWithAttachments = await Promise.all(
        [...currentMessages, userMessage].map(async msg => {
          if (
            msg.role === MessageRole.USER &&
            (msg.content.attachmentIds?.length || msg.content.originalAttachmentCount)
          ) {
            const attachments = await storage.getAttachments(msg.id);
            const loadedIds = new Set(attachments.map(att => att.id));

            // Use originalAttachmentCount if available (accurate even after attachment deletion)
            // Fall back to attachmentIds.length for backward compatibility with old messages
            const originalCount =
              msg.content.originalAttachmentCount ?? msg.content.attachmentIds?.length ?? 0;
            const currentCount = attachments.length;
            const missingCount = originalCount - currentCount;

            if (missingCount > 0) {
              // Prepend system note about missing attachments
              const systemNote = `<system-note>${missingCount} attachment(s) removed to save space.</system-note>\n\n`;
              return {
                ...msg,
                content: {
                  ...msg.content,
                  content: systemNote + msg.content.content,
                  // Filter attachmentIds to only include found attachments for the API call
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

      // Build enabled tools list from project settings
      const enabledTools: string[] = [];
      if (currentProject.memoryEnabled) {
        enabledTools.push('memory');
      }
      // Note: ping tool is alwaysEnabled, no need to add explicitly

      // Build combined system prompt: project prompt + tool prompts (if not using apiOverrides)
      const toolSystemPrompts = toolRegistry.getSystemPrompts(currentApiDef.apiType, enabledTools);
      const combinedSystemPrompt = [currentProject.systemPrompt, ...toolSystemPrompts]
        .filter(Boolean)
        .join('\n\n');

      console.debug('[useChat] Starting API stream');
      const stream = apiService.sendMessageStream(
        messagesWithAttachments,
        effectiveModelId,
        currentApiDef,
        {
          temperature: currentProject.temperature ?? undefined,
          maxTokens: currentProject.maxOutputTokens,
          enableReasoning: currentProject.enableReasoning,
          reasoningBudgetTokens: currentProject.reasoningBudgetTokens,
          systemPrompt: combinedSystemPrompt || undefined,
          preFillResponse: currentProject.preFillResponse,
          webSearchEnabled: currentProject.webSearchEnabled,
          enabledTools,
        }
      );

      let isFirstChunk = true;

      // Create new assembler for this streaming session
      assemblerRef.current = new StreamingContentAssembler();
      setStreamingGroups([]);
      setStreamingLastEvent('');

      // Manually iterate to get both chunks and final return value
      let streamNext = await stream.next();
      while (!streamNext.done) {
        const chunk = streamNext.value;

        // Push chunk to assembler (only if still on same chat)
        if (chatId === streamingChatId && assemblerRef.current) {
          // Handle prefill prepending for content chunks
          if (
            chunk.type === 'content' &&
            isFirstChunk &&
            currentProject.preFillResponse &&
            apiService.shouldPrependPrefill(currentApiDef)
          ) {
            // Push prefilled chunk with prepended content
            assemblerRef.current.pushChunk({
              type: 'content',
              content: currentProject.preFillResponse + chunk.content,
            });
            isFirstChunk = false;
          } else {
            assemblerRef.current.pushChunk(chunk);
          }

          // Update React state for UI rendering
          setStreamingGroups(assemblerRef.current.getGroups());
          setStreamingLastEvent(assemblerRef.current.getLastEvent());
        }

        // Track first content chunk for prefill handling
        if (chunk.type === 'content' && isFirstChunk) {
          isFirstChunk = false;
        }

        streamNext = await stream.next();
      }

      // Get final result with tokens and content (from generator return value)
      // Type narrow: when done is true, value is StreamResult
      let result = streamNext.done ? streamNext.value : null;

      // Agentic tool loop - continue if stop_reason is tool_use
      let toolIterations = 0;
      // Track messages for tool loop continuation
      let loopMessages = [...messagesWithAttachments];

      while (result && result.stopReason === 'tool_use' && toolIterations < MAX_TOOL_ITERATIONS) {
        toolIterations++;
        console.debug('[useChat] Tool use detected, iteration:', toolIterations);

        // Extract ALL tool_use blocks - unknown tools will receive error responses
        const toolUseBlocks = apiService.extractToolUseBlocks(
          currentApiDef.apiType,
          result.fullContent
        );
        if (toolUseBlocks.length === 0) {
          console.debug('[useChat] No client-side tools to execute');
          break;
        }

        // Execute each tool and collect results
        const toolResults: ToolResultBlock[] = [];
        for (const toolUse of toolUseBlocks) {
          console.debug('[useChat] Executing tool:', toolUse.name, 'id:', toolUse.id);

          const toolResult = await executeClientSideTool(toolUse.name, toolUse.input);

          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: toolResult.content,
            is_error: toolResult.isError,
          });
        }

        // Finalize assembler - tool_use blocks already pushed during streaming
        const assistantRenderingContent = assemblerRef.current?.finalize() ?? [];

        // Build renderingContent for tool result message
        const toolResultRenderBlocks: ToolResultRenderBlock[] = toolResults.map(tr => ({
          type: 'tool_result' as const,
          tool_use_id: tr.tool_use_id,
          content: tr.content,
          is_error: tr.is_error,
        }));

        // Build continuation messages using API-specific format
        const [assistantToolMessage, toolResultMessage] = apiService.buildToolResultMessages(
          currentApiDef.apiType,
          result.fullContent,
          toolResults,
          result.textContent
        );

        // Add rendering content to the messages
        assistantToolMessage.content.renderingContent = assistantRenderingContent;
        assistantToolMessage.content.stopReason = 'tool_use';
        toolResultMessage.content.renderingContent = [
          { category: 'backstage' as const, blocks: toolResultRenderBlocks },
        ];

        // Save intermediate messages to storage and update UI
        await storage.saveMessage(streamingChatId, assistantToolMessage);
        setMessages(prev => [...prev, assistantToolMessage]);
        callbacks.onMessageAppended(streamingChatId, assistantToolMessage);

        await storage.saveMessage(streamingChatId, toolResultMessage);
        setMessages(prev => [...prev, toolResultMessage]);
        callbacks.onMessageAppended(streamingChatId, toolResultMessage);

        console.debug('[useChat] Saved intermediate tool messages');

        loopMessages = [...loopMessages, assistantToolMessage, toolResultMessage];

        // Update token totals from this iteration
        updateChat.totalInputTokens =
          (updateChat.totalInputTokens ?? currentChat.totalInputTokens ?? 0) +
          (result.inputTokens ?? 0);
        updateChat.totalOutputTokens =
          (updateChat.totalOutputTokens ?? currentChat.totalOutputTokens ?? 0) +
          (result.outputTokens ?? 0);
        updateChat.totalCacheCreationTokens =
          (updateChat.totalCacheCreationTokens ?? currentChat.totalCacheCreationTokens ?? 0) +
          (result.cacheCreationTokens ?? 0);
        updateChat.totalCacheReadTokens =
          (updateChat.totalCacheReadTokens ?? currentChat.totalCacheReadTokens ?? 0) +
          (result.cacheReadTokens ?? 0);

        // Send continuation request
        console.debug('[useChat] Sending tool result continuation');
        const continueStream = apiService.sendMessageStream(
          loopMessages,
          effectiveModelId,
          currentApiDef,
          {
            temperature: currentProject.temperature ?? undefined,
            maxTokens: currentProject.maxOutputTokens,
            enableReasoning: currentProject.enableReasoning,
            reasoningBudgetTokens: currentProject.reasoningBudgetTokens,
            systemPrompt: combinedSystemPrompt || undefined,
            preFillResponse: undefined, // No prefill for continuation
            webSearchEnabled: currentProject.webSearchEnabled,
            enabledTools,
          }
        );

        // Reset assembler for continuation
        assemblerRef.current = new StreamingContentAssembler();
        setStreamingGroups([]);

        // Stream continuation response
        let continueNext = await continueStream.next();
        while (!continueNext.done) {
          const chunk = continueNext.value;
          if (chatId === streamingChatId && assemblerRef.current) {
            assemblerRef.current.pushChunk(chunk);
            setStreamingGroups(assemblerRef.current.getGroups());
            setStreamingLastEvent(assemblerRef.current.getLastEvent());
          }
          continueNext = await continueStream.next();
        }

        result = continueNext.done ? continueNext.value : null;
      }

      if (result) {
        // Extract token values from result
        const inputTokens = result.inputTokens ?? 0;
        const outputTokens = result.outputTokens ?? 0;
        const reasoningTokens = result.reasoningTokens;
        const cacheCreationTokens = result.cacheCreationTokens ?? 0;
        const cacheReadTokens = result.cacheReadTokens ?? 0;

        console.debug('[useChat] Stream complete, final tokens:', {
          inputTokens,
          outputTokens,
          reasoningTokens,
          cacheCreationTokens,
          cacheReadTokens,
        });

        // Get pricing snapshot
        const pricingSnapshot = await getPricingSnapshot(
          currentApiDef,
          effectiveModelId,
          inputTokens,
          outputTokens,
          reasoningTokens || 0,
          cacheCreationTokens,
          cacheReadTokens
        );

        // Finalize streaming content from assembler (single source of truth)
        const { renderingContent, stopReason } = result.error
          ? {
              renderingContent: assemblerRef.current!.finalizeWithError(result.error),
              stopReason: 'error' as const,
            }
          : {
              renderingContent: assemblerRef.current!.finalize(),
              stopReason: apiService.mapStopReason(
                currentApiDef.apiType,
                result.stopReason ?? null
              ),
            };

        const assistantMessage: Message<unknown> = {
          id: generateUniqueId('msg_assistant'),
          role: MessageRole.ASSISTANT,
          content: {
            type: 'text',
            content: result.textContent,
            modelFamily: currentApiDef.apiType,
            fullContent: result.fullContent,
            renderingContent,
            stopReason,
          },
          timestamp: new Date(),
          metadata: {
            model: effectiveModelId,
            inputTokens,
            outputTokens,
            reasoningTokens,
            cacheCreationTokens,
            cacheReadTokens,
            ...pricingSnapshot,
          },
        };

        await storage.saveMessage(streamingChatId, assistantMessage);
        console.debug('[useChat] Assistant message saved');
        setMessages(prev => [...prev, assistantMessage]);
        callbacks.onMessageAppended(streamingChatId, assistantMessage);

        // Update token totals - use existing loop totals if we went through tool loop
        updateChat.totalInputTokens =
          (updateChat.totalInputTokens ?? currentChat.totalInputTokens ?? 0) + inputTokens;
        updateChat.totalOutputTokens =
          (updateChat.totalOutputTokens ?? currentChat.totalOutputTokens ?? 0) + outputTokens;
        updateChat.totalReasoningTokens =
          (updateChat.totalReasoningTokens ?? currentChat.totalReasoningTokens ?? 0) +
          (reasoningTokens || 0);
        updateChat.totalCacheCreationTokens =
          (updateChat.totalCacheCreationTokens ?? currentChat.totalCacheCreationTokens ?? 0) +
          cacheCreationTokens;
        updateChat.totalCacheReadTokens =
          (updateChat.totalCacheReadTokens ?? currentChat.totalCacheReadTokens ?? 0) +
          cacheReadTokens;
        updateChat.totalCost = (currentChat.totalCost || 0) + pricingSnapshot.messageCost;
        updateChat.contextWindowUsage = pricingSnapshot.contextWindowUsage;
      } else {
        // Stream returned no result - create error message
        const errorRenderingContent = assemblerRef.current
          ? assemblerRef.current.finalizeWithError({ message: 'Stream returned no result' })
          : [
              {
                category: 'error' as const,
                blocks: [{ type: 'error' as const, message: 'Stream returned no result' }],
              },
            ];

        const errorMessage: Message<unknown> = {
          id: generateUniqueId('msg_assistant'),
          role: MessageRole.ASSISTANT,
          content: {
            type: 'text',
            content: '',
            modelFamily: currentApiDef.apiType,
            renderingContent: errorRenderingContent,
            stopReason: 'error',
          },
          timestamp: new Date(),
        };

        await storage.saveMessage(streamingChatId, errorMessage);
        console.debug('[useChat] Error message saved (no result)');
        setMessages(prev => [...prev, errorMessage]);
        callbacks.onMessageAppended(streamingChatId, errorMessage);
      }

      // Update chat totals with this message's tokens/cost
      // Add 2 to messageCount for user message + assistant message
      const updatedChat: Chat = {
        ...currentChat,
        ...updateChat,
        messageCount: (currentChat.messageCount || 0) + 2, // +1 user, +1 assistant
        lastModifiedAt: new Date(),
      };

      await storage.saveChat(updatedChat);
      console.debug('[useChat] Chat totals updated');
      setChat(updatedChat);
      callbacks.onChatMetadataChanged?.(streamingChatId, updatedChat);

      // Update project's lastUsedAt to reflect recent activity (for sorting)
      const updatedProject: Project = {
        ...currentProject,
        lastUsedAt: new Date(),
      };
      await storage.saveProject(updatedProject);
      setProject(updatedProject);
      console.debug('[useChat] Project lastUsedAt updated');
    } catch (error: unknown) {
      // Extract error info from the caught exception
      const errorInfo =
        error instanceof Error
          ? { message: error.message, stack: error.stack }
          : { message: String(error) || 'Unknown error' };

      console.error('[useChat] API call failed:', errorInfo.message);

      // Create error message using assembler if available, otherwise create manually
      const errorRenderingContent = assemblerRef.current
        ? assemblerRef.current.finalizeWithError(errorInfo)
        : [
            {
              category: 'error' as const,
              blocks: [
                {
                  type: 'error' as const,
                  message: errorInfo.message,
                  ...(errorInfo.stack && { stack: errorInfo.stack }),
                },
              ],
            },
          ];

      const errorAssistantMessage: Message<unknown> = {
        id: generateUniqueId('msg_assistant'),
        role: MessageRole.ASSISTANT,
        content: {
          type: 'text',
          content: '',
          modelFamily: currentApiDef.apiType,
          renderingContent: errorRenderingContent,
          stopReason: 'error',
        },
        timestamp: new Date(),
      };

      await storage.saveMessage(streamingChatId, errorAssistantMessage);
      console.debug('[useChat] Error message saved (exception)');
      setMessages(prev => [...prev, errorAssistantMessage]);
      callbacks.onMessageAppended(streamingChatId, errorAssistantMessage);
    } finally {
      // Only update loading state if still in the same chat (use hook's chatId, not state)
      if (chatId === streamingChatId) {
        setIsLoading(false);
        setStreamingGroups([]);
        setStreamingLastEvent('');
        assemblerRef.current = null;
        callbacks.onStreamingEnd(streamingChatId);
      }
      console.debug('[useChat] API call finished, still same chat:', chatId === streamingChatId);
    }
  };

  const calculateTotalTokens = () => {
    if (!chat) return;

    // Read directly from chat-level totals (no more summing messages)
    setTokenUsage({
      input: chat.totalInputTokens || 0,
      output: chat.totalOutputTokens || 0,
      reasoning: (chat.totalReasoningTokens || 0) > 0 ? chat.totalReasoningTokens : undefined,
      cacheCreation:
        (chat.totalCacheCreationTokens || 0) > 0 ? chat.totalCacheCreationTokens : undefined,
      cacheRead: (chat.totalCacheReadTokens || 0) > 0 ? chat.totalCacheReadTokens : undefined,
      cost: chat.totalCost || 0,
    });
  };

  const sendMessage = async (
    incomingChatId: string,
    content: string,
    attachments?: MessageAttachment[]
  ) => {
    if (!verifyChatId(incomingChatId, 'sendMessage')) return;

    const messageText = content.trim();
    // Allow sending if there's text OR attachments
    if ((!messageText && !attachments?.length) || !chat || !project || !apiDefinition) return;

    sendMessageToAPI(messageText, messages, chat, project, apiDefinition, attachments);
  };

  const getContextWindowUsage = (metadata?: {
    inputTokens?: number;
    outputTokens?: number;
    reasoningTokens?: number;
    cacheCreationTokens?: number;
    cacheReadTokens?: number;
  }) => {
    return (
      (metadata?.inputTokens || 0) +
      (metadata?.outputTokens || 0) +
      (metadata?.cacheCreationTokens || 0) +
      (metadata?.cacheReadTokens || 0) -
      (metadata?.reasoningTokens || 0)
    );
  };

  const getPricingSnapshot = async (
    apiDef: APIDefinition,
    modelId: string,
    inputTokens: number,
    outputTokens: number,
    reasoningTokens: number,
    cacheCreationTokens: number,
    cacheReadTokens: number
  ) => {
    // Calculate total cost using apiService
    const totalCost = apiService.calculateCost(
      apiDef.apiType,
      modelId,
      inputTokens,
      outputTokens,
      reasoningTokens,
      cacheCreationTokens,
      cacheReadTokens
    );

    // Get context window from storage
    const models = await storage.getModels(apiDef.id);
    const model = models.find(m => m.id === modelId);
    const contextWindowUsage =
      inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens - (reasoningTokens || 0);
    const contextWindow = model?.contextWindow || 0;

    return {
      messageCost: totalCost,
      contextWindow,
      contextWindowUsage,
    };
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
      if (msg.role === MessageRole.ASSISTANT && msg.metadata?.contextWindowUsage !== undefined) {
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

  return {
    chat,
    messages,
    isLoading,
    tokenUsage,
    streamingGroups,
    streamingLastEvent,
    currentApiDefId: chat?.apiDefinitionId ?? project?.apiDefinitionId ?? null,
    currentModelId: chat?.modelId ?? project?.modelId ?? null,
    parentApiDefId: project?.apiDefinitionId ?? null,
    parentModelId: project?.modelId ?? null,
    sendMessage,
    editMessage,
    copyMessage,
    forkChat,
    overrideModel,
    updateChatName,
  };
}
