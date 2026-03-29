import OpenAI from 'openai';
import { getProxyConfig } from './proxyConfig';
import type { ChatCompletionCreateParams, ChatCompletionTool } from 'openai/resources/index.mjs';
import type {
  APIDefinition,
  Message,
  MessageStopReason,
  Model,
  ReasoningEffort,
  ToolUseBlock,
  ToolOptions,
} from '../../types';
import { mapReasoningEffort } from '../../utils/reasoningEffort';
import { toolRegistry } from '../tools/clientSideTools';
import type { APIClient, StreamChunk, StreamResult } from './baseClient';
import { effectiveInjectionMode } from './fileInjectionHelper';
import {
  CompletionFullContentAccumulator,
  createFullContentFromMessage,
} from './completionFullContentAccumulator';
import type { CompletionChunk, CompletionMessage } from './completionStreamMapper';
import {
  convertMessageToStreamChunks,
  createMapperState,
  mapCompletionChunkToStreamChunks,
} from './completionStreamMapper';
import { findCheckpointIndex, tidyAgnosticMessage } from './contextTidy';
import { getModelMetadataFor } from './modelMetadata';
import { storage } from '../storage';
import {
  populateFromOpenRouterModel,
  type OpenRouterModel,
} from './model_metadatas/openRouterModelMapper';

/**
 * Checkpoint-only message tidy for OpenAI Chat Completions.
 * No thinking blocks — only tool filtering via checkpoint.
 *
 * OpenAI fullContent is either:
 * - Object (CompletionMessage) with optional tool_calls[] for assistant messages
 * - Array of { type: 'tool_result', tool_call_id } for user tool result messages
 */
function tidyMessages(
  messages: Message<unknown>[],
  checkpointMessageId: string | undefined,
  tidyToolNames: Set<string> | undefined
): Message<unknown>[] {
  const checkpointIdx = findCheckpointIndex(messages, checkpointMessageId);
  if (checkpointIdx === -1) return messages;

  const toolNames = tidyToolNames ?? new Set<string>();
  const removedToolUseIds = new Set<string>();
  const result: Message<unknown>[] = [];

  for (let i = 0; i <= checkpointIdx; i++) {
    const msg = messages[i];
    const isCheckpoint = i === checkpointIdx;

    // Wrong modelFamily or missing fullContent
    if (msg.content.modelFamily !== 'chatgpt' || msg.content.fullContent == null) {
      if (isCheckpoint) {
        result.push(msg);
        continue;
      }
      const { message, newRemovedIds } = tidyAgnosticMessage(
        msg,
        toolNames,
        removedToolUseIds,
        false
      );
      for (const id of newRemovedIds) removedToolUseIds.add(id);
      if (message) result.push(message);
      continue;
    }

    // Checkpoint message: no filtering needed (no thinking blocks)
    if (isCheckpoint) {
      result.push(msg);
      continue;
    }

    const fullContent = msg.content.fullContent;

    // Array fullContent = tool result message
    if (Array.isArray(fullContent)) {
      const filtered = fullContent.filter((item: unknown) => {
        const it = item as { type?: string; tool_call_id?: string };
        return !(
          it.type === 'tool_result' &&
          it.tool_call_id &&
          removedToolUseIds.has(it.tool_call_id)
        );
      });
      if (filtered.length === 0) continue;
      if (filtered.length !== fullContent.length) {
        result.push({ ...msg, content: { ...msg.content, fullContent: filtered } });
      } else {
        result.push(msg);
      }
      continue;
    }

    // Object fullContent = CompletionMessage with optional tool_calls
    const cmsg = fullContent as {
      tool_calls?: Array<{ id: string; function: { name: string } }>;
    };
    if (!cmsg.tool_calls?.length) {
      result.push(msg);
      continue;
    }

    const keptCalls = cmsg.tool_calls.filter(tc => {
      if (toolNames.has(tc.function.name)) {
        removedToolUseIds.add(tc.id);
        return false;
      }
      return true;
    });

    if (keptCalls.length === 0) {
      const { tool_calls: _, ...rest } = cmsg;
      result.push({ ...msg, content: { ...msg.content, fullContent: rest } });
    } else if (keptCalls.length !== cmsg.tool_calls.length) {
      result.push({
        ...msg,
        content: { ...msg.content, fullContent: { ...cmsg, tool_calls: keptCalls } },
      });
    } else {
      result.push(msg);
    }
  }

  for (let i = checkpointIdx + 1; i < messages.length; i++) {
    result.push(messages[i]);
  }

  return result;
}

export class OpenAIClient implements APIClient {
  async discoverModels(apiDefinition: APIDefinition): Promise<Model[]> {
    const proxy = getProxyConfig(apiDefinition);
    const client = new OpenAI({
      dangerouslyAllowBrowser: true,
      apiKey: apiDefinition.apiKey,
      baseURL: proxy?.baseURL ?? (apiDefinition.baseUrl || undefined),
      ...(proxy && { defaultHeaders: proxy.headers }),
    });

    // Get all models from the API
    const modelsResponse = await client.models.list();
    console.debug(`Models for ${apiDefinition.name}:`, modelsResponse);

    // Only filter for OpenAI (no custom baseUrl); custom providers keep all models
    const chatModels = apiDefinition.baseUrl
      ? modelsResponse.data // Custom provider: keep all models
      : modelsResponse.data.filter(model => {
          const id = model.id.toLowerCase();
          return id.startsWith('gpt-') || id.startsWith('chatgpt-') || id.match(/^o\d/);
        });

    // Sort models: gpt-5, gpt-4, o-series, then legacy
    chatModels.sort((a, b) => {
      const idA = a.id.toLowerCase();
      const idB = b.id.toLowerCase();

      const prefixA = a.id.split('-')[0];
      const prefixB = b.id.split('-')[0];
      if (prefixA !== prefixB) {
        return prefixA.localeCompare(prefixB);
      }

      let getGroup = (_id: string) => 0;
      // same prefix, so use prefixA
      if (prefixA === 'gpt') {
        getGroup = (id: string) => {
          if (id.startsWith('gpt-5.2')) return 1;
          if (id.startsWith('gpt-5.1')) return 2;
          if (id.startsWith('gpt-5.')) return 0;
          if (id.startsWith('gpt-5')) return 3;
          if (id.startsWith('gpt-4')) return 4;
          return 5;
        };
      }

      const groupA = getGroup(idA);
      const groupB = getGroup(idB);

      if (groupA !== groupB) {
        return groupA - groupB;
      }

      if (prefixA === 'grok') {
        return idB.localeCompare(idA);
      }

      // Within same group, sort alphabetically
      return idA.localeCompare(idB);
    });

    // Convert OpenAI models to our Model format
    const models: Model[] = chatModels.map(rawModel => {
      // Start with hardcoded knowledge as base
      const model = getModelMetadataFor(apiDefinition, rawModel.id);
      // Overlay OpenRouter-specific fields if present
      populateFromOpenRouterModel(model, rawModel as unknown as OpenRouterModel);
      return model;
    });
    console.debug(`Argumented models for ${apiDefinition.name}:`, models);
    return models;
  }

  shouldPrependPrefill(_apiDefinition: APIDefinition): boolean {
    return false;
  }

  async *sendMessageStream(
    messages: Message<unknown>[],
    modelId: string,
    apiDefinition: APIDefinition,
    options: {
      temperature: number;
      maxTokens: number;
      enableReasoning: boolean;
      reasoningBudgetTokens: number;
      reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
      reasoningSummary?: 'auto' | 'concise' | 'detailed';
      systemPrompt?: string;
      preFillResponse?: string;
      webSearchEnabled?: boolean;
      enabledTools?: string[];
      toolOptions?: Record<string, ToolOptions>;
      disableStream?: boolean;
      checkpointMessageId?: string;
      tidyToolNames?: Set<string>;
    }
  ): AsyncGenerator<StreamChunk, StreamResult<CompletionMessage>, unknown> {
    try {
      const proxy = getProxyConfig(apiDefinition);
      const client = new OpenAI({
        dangerouslyAllowBrowser: true,
        apiKey: apiDefinition.apiKey,
        baseURL: proxy?.baseURL ?? (apiDefinition.baseUrl || undefined),
        ...(proxy && { defaultHeaders: proxy.headers }),
      });

      // Tidy messages: checkpoint-based tool filtering
      const tidiedMessages = tidyMessages(
        messages,
        options.checkpointMessageId,
        options.tidyToolNames
      );

      // Convert our message format to OpenAI's format
      const openaiMessages: OpenAI.ChatCompletionMessageParam[] = [];

      // Handle system prompt based on model type
      if (options.systemPrompt) {
        openaiMessages.push({
          role: this.systemPromptRole(modelId),
          content: options.systemPrompt,
        });
      }

      // Add conversation messages
      tidiedMessages.forEach(msg => {
        if (msg.role === 'user') {
          // Cross-model reconstruction: use toolResults if available
          if (msg.content.toolResults?.length) {
            for (const tr of msg.content.toolResults) {
              openaiMessages.push({
                role: 'tool',
                tool_call_id: tr.tool_use_id,
                content: tr.content,
              });
            }
            return;
          }

          // Check if message contains tool_result blocks in fullContent (for agentic loop continuation)
          if (msg.content.fullContent && Array.isArray(msg.content.fullContent)) {
            const fullContent = msg.content.fullContent as Array<Record<string, unknown>>;
            const toolResults = fullContent.filter(item => item.type === 'tool_result');
            if (toolResults.length > 0) {
              // Convert tool_result blocks to OpenAI tool messages
              for (const tr of toolResults) {
                openaiMessages.push({
                  role: 'tool',
                  tool_call_id: tr.tool_call_id as string,
                  content: tr.content as string,
                });
              }
              return;
            }
          }

          // Build user message content — may need array form for attachments or injected files
          const hasAttachments = msg.attachments && msg.attachments.length > 0;
          const hasInjectedFiles = msg.content.injectedFiles?.length && msg.content.injectionMode;
          const injMode = hasInjectedFiles
            ? effectiveInjectionMode(msg.content.injectionMode!, 'chatgpt')
            : undefined;

          if (hasAttachments || (hasInjectedFiles && injMode !== 'inline')) {
            const contentParts: OpenAI.ChatCompletionContentPart[] = [];

            // Add images first
            if (hasAttachments) {
              for (const attachment of msg.attachments!) {
                contentParts.push({
                  type: 'image_url',
                  image_url: {
                    url: `data:${attachment.mimeType};base64,${attachment.data}`,
                  },
                });
              }
            }

            // Add injected file blocks
            if (hasInjectedFiles && injMode === 'as-file') {
              for (const file of msg.content.injectedFiles!) {
                contentParts.push({
                  type: 'file',
                  file: {
                    file_data: `data:text/plain;base64,${btoa(unescape(encodeURIComponent(file.content)))}`,
                    filename: file.path,
                  },
                } as OpenAI.ChatCompletionContentPart);
              }
            } else if (hasInjectedFiles && injMode === 'separate-block') {
              for (const file of msg.content.injectedFiles!) {
                contentParts.push({
                  type: 'text',
                  text: `=== ${file.path} ===\n${file.content}`,
                });
              }
            }

            // Add text content
            contentParts.push({
              type: 'text',
              text: msg.content.content,
            });

            openaiMessages.push({
              role: 'user',
              content: contentParts,
            });
          } else {
            // Text-only message (inline injection already baked into content)
            openaiMessages.push({
              role: 'user',
              content: msg.content.content,
            });
          }
        } else if (msg.role === 'assistant') {
          // Cross-model reconstruction: use toolCalls if available and not own modelFamily
          if (msg.content.modelFamily !== 'chatgpt' && msg.content.toolCalls?.length) {
            openaiMessages.push({
              role: 'assistant',
              content: msg.content.content || null,
              tool_calls: msg.content.toolCalls.map(tc => ({
                id: tc.id,
                type: 'function' as const,
                function: {
                  name: tc.name,
                  arguments: JSON.stringify(tc.input),
                },
              })),
            });
            return;
          }

          // Handle new CompletionMessage fullContent format
          const fullContent = msg.content.fullContent as CompletionMessage | undefined;
          if (fullContent && typeof fullContent === 'object' && !Array.isArray(fullContent)) {
            // New format: CompletionMessage object
            if (fullContent.tool_calls && fullContent.tool_calls.length > 0) {
              openaiMessages.push({
                role: 'assistant',
                content: fullContent.content ?? null,
                tool_calls: fullContent.tool_calls as OpenAI.ChatCompletionMessageToolCall[],
              });
              return;
            }
            // No tool calls, just use content
            openaiMessages.push({
              role: 'assistant',
              content: fullContent.content ?? msg.content.content,
            });
            return;
          }

          // Legacy format: Array with type blocks (backward compatibility)
          if (Array.isArray(msg.content.fullContent)) {
            const legacyContent = msg.content.fullContent as Array<Record<string, unknown>>;
            const toolCallsBlock = legacyContent.find(item => item.type === 'tool_calls');
            if (toolCallsBlock && Array.isArray(toolCallsBlock.tool_calls)) {
              openaiMessages.push({
                role: 'assistant',
                content: msg.content.content || null,
                tool_calls: toolCallsBlock.tool_calls as OpenAI.ChatCompletionMessageToolCall[],
              });
              return;
            }
          }

          // Plain text message
          openaiMessages.push({
            role: 'assistant',
            content: msg.content.content,
          });
        }
      });

      // Add pre-fill response if provided, best effort
      if (options.preFillResponse) {
        openaiMessages.push({
          role: 'assistant',
          content: options.preFillResponse,
        });
      }

      // Prepare API request parameters
      const requestParams: OpenAI.Chat.ChatCompletionCreateParams = {
        model: modelId,
        max_completion_tokens: options.maxTokens,
        messages: openaiMessages,
        store: false,
      };

      if (options.webSearchEnabled) {
        if (modelId.startsWith('grok')) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (requestParams as any)['search_parameters'] = { mode: 'auto' };
        }
      }

      // Add client-side tool definitions
      const clientToolDefs = this.getClientSideTools(
        options.enabledTools || [],
        options.toolOptions || {}
      );
      if (clientToolDefs.length > 0) {
        requestParams.tools = [...(requestParams.tools || []), ...clientToolDefs];
      }

      // Get model metadata for reasoning configuration
      const model = await storage.getModel(apiDefinition.id, modelId);
      this.applyReasoning(requestParams, options, model, apiDefinition);

      // Track token usage and finish reason
      let inputTokens = 0;
      let outputTokens = 0;
      let cacheReadTokens = 0;
      let reasoningTokens = 0;
      let finishReason: string | null = null;

      // Use streaming unless explicitly disabled
      if (!options.disableStream) {
        // Streaming path: use mapper and accumulator
        const stream = await client.chat.completions.create({
          ...requestParams,
          stream: true,
          stream_options: { include_usage: true },
        });

        let mapperState = createMapperState();
        const accumulator = new CompletionFullContentAccumulator();

        for await (const chunk of stream) {
          // Cast SDK chunk to our interface
          const completionChunk = chunk as unknown as CompletionChunk;

          // Accumulate for fullContent
          accumulator.pushChunk(completionChunk);

          // Map to StreamChunks for rendering
          const result = mapCompletionChunkToStreamChunks(completionChunk, mapperState);
          mapperState = result.state;

          // Yield all StreamChunks
          for (const streamChunk of result.chunks) {
            // Extract token usage from token_usage chunks
            if (streamChunk.type === 'token_usage') {
              inputTokens = streamChunk.inputTokens ?? 0;
              outputTokens = streamChunk.outputTokens ?? 0;
              cacheReadTokens = streamChunk.cacheReadTokens ?? 0;
              reasoningTokens = streamChunk.reasoningTokens ?? 0;
            }
            yield streamChunk;
          }

          // Capture finish_reason
          const chunkFinishReason = chunk.choices[0]?.finish_reason;
          if (chunkFinishReason) {
            finishReason = chunkFinishReason;
          }
        }

        // Build fullContent from accumulator
        let fullContent = accumulator.finalize();
        let textContent = accumulator.getContent();

        // Prepend prefill if provided
        if (options.preFillResponse) {
          textContent = options.preFillResponse + textContent;
          fullContent = {
            ...fullContent,
            content: textContent,
          };
        }

        return {
          textContent,
          hasCoT: mapperState.hadReasoning,
          fullContent,
          stopReason: this.mapStopReason(finishReason),
          inputTokens,
          outputTokens,
          cacheReadTokens: cacheReadTokens > 0 ? cacheReadTokens : undefined,
          reasoningTokens: reasoningTokens > 0 ? reasoningTokens : undefined,
        };
      } else {
        // Non-streaming path
        const response = await client.chat.completions.create({
          ...requestParams,
          stream: false,
        });

        const message = response.choices[0]?.message;
        finishReason = response.choices[0]?.finish_reason || null;

        // Yield StreamChunks for renderingContent
        if (message) {
          for (const chunk of convertMessageToStreamChunks(
            message as unknown as CompletionMessage
          )) {
            yield chunk;
          }
        }

        // Extract token usage
        const usage = response.usage;
        if (usage) {
          inputTokens = usage.prompt_tokens || 0;
          outputTokens = usage.completion_tokens || 0;

          const completionTokensDetails = usage.completion_tokens_details;
          if (completionTokensDetails?.reasoning_tokens) {
            reasoningTokens = completionTokensDetails.reasoning_tokens;
          }
          const promptTokensDetails = usage.prompt_tokens_details;
          if (promptTokensDetails?.cached_tokens) {
            cacheReadTokens = promptTokensDetails.cached_tokens;
            inputTokens -= cacheReadTokens;
          }
        }

        // Build fullContent from message
        let fullContent = message
          ? createFullContentFromMessage(message as unknown as CompletionMessage)
          : { role: 'assistant', content: null, refusal: null };
        let textContent = message?.content || '';

        // Prepend prefill if provided
        if (options.preFillResponse) {
          textContent = options.preFillResponse + textContent;
          fullContent = {
            ...fullContent,
            content: textContent,
          };
        }

        return {
          textContent,
          hasCoT: reasoningTokens > 0,
          fullContent,
          stopReason: this.mapStopReason(finishReason),
          inputTokens,
          outputTokens,
          cacheReadTokens: cacheReadTokens > 0 ? cacheReadTokens : undefined,
          reasoningTokens: reasoningTokens > 0 ? reasoningTokens : undefined,
        };
      }
    } catch (error: unknown) {
      // Handle errors - extract message, status, and stack
      let errorMessage = 'Unknown error occurred';
      let errorStatus: number | undefined = undefined;
      let errorStack: string | undefined = undefined;

      if (error && typeof error === 'object') {
        if ('status' in error) {
          errorStatus = Number(error.status);
          if (errorStatus === 401) {
            errorMessage = 'Invalid API key. Please check your OpenAI API key in settings.';
          } else if (errorStatus === 429) {
            errorMessage = 'Rate limit exceeded. Please try again later.';
          } else if (errorStatus === 500 || errorStatus === 502 || errorStatus === 503) {
            errorMessage = 'OpenAI API is currently unavailable. Please try again later.';
          }
        }
        if (
          'message' in error &&
          typeof error.message === 'string' &&
          !errorMessage.includes('API key')
        ) {
          errorMessage = `API Error: ${error.message}`;
        }
        if (error instanceof Error) {
          errorStack = error.stack;
        }
      }

      // Return with error object (no yield)
      return {
        textContent: '',
        fullContent: { role: 'assistant', content: null, refusal: null },
        error: { message: errorMessage, status: errorStatus, stack: errorStack },
        inputTokens: 0,
        outputTokens: 0,
      };
    }
  }

  protected applyReasoning(
    requestParams: ChatCompletionCreateParams,
    options: {
      temperature?: number;
      enableReasoning?: boolean;
      reasoningEffort?: ReasoningEffort;
    },
    model?: Model,
    apiDefinition?: APIDefinition
  ) {
    const effort = options.reasoningEffort;
    const useDeFactoThinking =
      model?.deFactoThinking || apiDefinition?.advancedSettings?.deFactoThinking;

    if (options.temperature) requestParams.temperature = options.temperature;

    // Skip reasoning if explicitly disabled or model doesn't support it
    if (options.enableReasoning === false || model?.reasoningMode === 'none') {
      if (useDeFactoThinking) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (requestParams as any)['thinking'] = { type: 'disabled' };
      }
      return;
    }

    // De facto thinking: inject { thinking: { type: "enabled" } } and skip standard params
    if (useDeFactoThinking) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (requestParams as any)['thinking'] = { type: 'enabled' };
      return;
    }

    const supportedEfforts = model?.supportedReasoningEfforts;

    // Model with reasoning but no configurable effort (e.g., grok-4)
    if (!supportedEfforts || supportedEfforts.length === 0) {
      // No effort param needed - model always reasons or doesn't support effort config
      return;
    }

    // Model with configurable reasoning effort
    const mappedEffort = mapReasoningEffort(effort, supportedEfforts as ReasoningEffort[]);
    if (mappedEffort !== undefined) {
      requestParams.reasoning_effort = mappedEffort;
    }
  }

  protected systemPromptRole(_modelId: string): 'developer' | 'system' {
    return 'system';
  }

  /**
   * Map OpenAI finish_reason to MessageStopReason.
   */
  private mapStopReason(stopReason: string | null): MessageStopReason {
    if (!stopReason) {
      return 'end_turn';
    }
    // OpenAI uses: stop, length, tool_calls, content_filter, function_call
    switch (stopReason) {
      case 'stop':
        return 'end_turn';
      case 'length':
        return 'max_tokens';
      case 'tool_calls':
      case 'function_call':
        return 'tool_use'; // Map to tool_use for agentic loop
      case 'content_filter':
        return 'error';
      default:
        return stopReason;
    }
  }

  /**
   * Extract tool_use blocks from Chat Completions fullContent.
   * Supports both new CompletionMessage format and legacy array format.
   */
  extractToolUseBlocks(fullContent: unknown): ToolUseBlock[] {
    // Handle new CompletionMessage format
    if (fullContent && typeof fullContent === 'object' && !Array.isArray(fullContent)) {
      const msg = fullContent as CompletionMessage;
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

    // Handle legacy array format for backward compatibility
    if (!Array.isArray(fullContent)) return [];

    for (const block of fullContent as Array<Record<string, unknown>>) {
      if (block.type === 'tool_calls' && Array.isArray(block.tool_calls)) {
        return (block.tool_calls as Array<Record<string, unknown>>).map(tc => ({
          type: 'tool_use' as const,
          id: tc.id as string,
          name: (tc.function as Record<string, unknown>)?.name as string,
          input: JSON.parse(
            ((tc.function as Record<string, unknown>)?.arguments as string) || '{}'
          ),
        }));
      }
    }
    return [];
  }

  /**
   * Get client-side tool definitions for OpenAI Chat Completions format.
   * Translates standard definitions to { type: 'function', function: { name, description, parameters } }
   */
  protected getClientSideTools(
    enabledTools: string[],
    toolOptions: Record<string, ToolOptions> = {}
  ): ChatCompletionTool[] {
    const standardDefs = toolRegistry.getToolDefinitions(enabledTools, toolOptions);

    return standardDefs.map(def => {
      // Check for provider-specific override first
      const override = toolRegistry.getToolOverride(
        def.name,
        'chatgpt',
        toolOptions[def.name] ?? {}
      );
      if (override) {
        return override as ChatCompletionTool;
      }

      // Translate standard definition to Chat Completions format
      return {
        type: 'function' as const,
        function: {
          name: def.name,
          description: def.description,
          parameters: def.input_schema,
        },
      };
    });
  }
}
