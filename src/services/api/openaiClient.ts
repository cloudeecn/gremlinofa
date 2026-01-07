import OpenAI from 'openai';
import type { ChatCompletionCreateParams, ChatCompletionTool } from 'openai/resources/index.mjs';
import type {
  APIDefinition,
  Message,
  MessageStopReason,
  Model,
  RenderingBlockGroup,
  ToolResultBlock,
  ToolUseBlock,
} from '../../types';

import { APIType, groupAndConsolidateBlocks, MessageRole } from '../../types';
import { generateUniqueId } from '../../utils/idGenerator';
import { mapReasoningEffort } from '../../utils/reasoningEffort';
import { toolRegistry } from '../tools/clientSideTools';
import type { APIClient, StreamChunk, StreamResult } from './baseClient';
import type { ModelInfo } from './modelInfo';
import { formatModelInfoForDisplay, getModelInfo, isReasoningModel } from './openaiModelInfo';

export class OpenAIClient implements APIClient {
  async discoverModels(apiDefinition: APIDefinition): Promise<Model[]> {
    try {
      // Create OpenAI client with API key and custom baseUrl if provided
      const client = new OpenAI({
        dangerouslyAllowBrowser: true,
        apiKey: apiDefinition.apiKey,
        baseURL: apiDefinition.baseUrl || undefined,
      });

      // Get all models from the API
      const modelsResponse = await client.models.list();

      // Filter for chat completion models
      // Only filter for OpenAI (no custom baseUrl) to show gpt-* and o* models
      // For custom providers (xAI, etc.), show all models
      const chatModels = apiDefinition.baseUrl
        ? modelsResponse.data // Custom provider: keep all models
        : modelsResponse.data.filter(model => {
            // OpenAI: filter for gpt-* and o* models only
            const id = model.id.toLowerCase();
            return id.startsWith('gpt-') || id.match(/^o\d/);
          });

      // Sort models: gpt-5, gpt-4, o-series, then legacy
      chatModels.sort((a, b) => {
        const idA = a.id.toLowerCase();
        const idB = b.id.toLowerCase();

        // Priority groups
        const getGroup = (id: string): number => {
          if (id.startsWith('gpt-5')) return 1;
          if (id.startsWith('gpt-4')) return 2;
          if (id.match(/^o\d/)) return 3;
          return 4; // Legacy models (gpt-3.5, etc.)
        };

        const groupA = getGroup(idA);
        const groupB = getGroup(idB);

        if (groupA !== groupB) {
          return groupA - groupB;
        }

        // Within same group, sort alphabetically
        return idA.localeCompare(idB);
      });

      // Convert OpenAI models to our Model format
      const models: Model[] = chatModels.map(openaiModel => ({
        id: openaiModel.id,
        name: openaiModel.id, // OpenAI doesn't provide display names
        apiType: APIType.CHATGPT,
        contextWindow: getModelInfo(openaiModel.id).contextWindow,
      }));

      return models;
    } catch (error: unknown) {
      console.error('Failed to discover OpenAI models:', error);
      return [];
    }
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
    }
  ): AsyncGenerator<StreamChunk, StreamResult<unknown>, unknown> {
    try {
      // Create OpenAI client with API key and custom baseUrl if provided
      const client = new OpenAI({
        dangerouslyAllowBrowser: true,
        apiKey: apiDefinition.apiKey,
        baseURL: apiDefinition.baseUrl || undefined,
      });

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
      messages.forEach(msg => {
        if (msg.role === MessageRole.USER) {
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

          // Check if message has attachments (images)
          if (msg.attachments && msg.attachments.length > 0) {
            const contentParts: OpenAI.ChatCompletionContentPart[] = [];

            // Add images first
            for (const attachment of msg.attachments) {
              contentParts.push({
                type: 'image_url',
                image_url: {
                  url: `data:${attachment.mimeType};base64,${attachment.data}`,
                },
              });
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
            // Text-only message
            openaiMessages.push({
              role: 'user',
              content: msg.content.content,
            });
          }
        } else if (msg.role === MessageRole.ASSISTANT) {
          // Check if assistant message has tool_calls in fullContent
          if (msg.content.fullContent && Array.isArray(msg.content.fullContent)) {
            const fullContent = msg.content.fullContent as Array<Record<string, unknown>>;
            const toolCallsBlock = fullContent.find(item => item.type === 'tool_calls');
            if (toolCallsBlock && Array.isArray(toolCallsBlock.tool_calls)) {
              // Assistant message with tool calls - include them in the message
              openaiMessages.push({
                role: 'assistant',
                content: msg.content.content || null,
                tool_calls: toolCallsBlock.tool_calls as OpenAI.ChatCompletionMessageToolCall[],
              });
              return;
            }
          }
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
        } else {
          requestParams.tools = [{ type: 'web_search' } as unknown as ChatCompletionTool];
        }
      }

      // Add client-side tool definitions
      const clientToolDefs = this.getClientSideTools(options.enabledTools || []);
      if (clientToolDefs.length > 0) {
        requestParams.tools = [...(requestParams.tools || []), ...clientToolDefs];
      }

      this.applyReasoning(requestParams, options);

      // Track streamed content and token usage
      let streamedContent = '';
      let inputTokens = 0;
      let outputTokens = 0;
      let cached_tokens = 0;
      let reasoningTokens = 0;
      let finishReason: string | null = null;
      // Track tool calls for client-side tool execution
      const accumulatedToolCalls: Map<number, { id: string; name: string; arguments: string }> =
        new Map();

      // Check if model supports streaming
      const supportsStreaming = this.supportStreaming(modelId);

      if (supportsStreaming) {
        // Streaming path
        const stream = await client.chat.completions.create({
          ...requestParams,
          stream: true,
          stream_options: { include_usage: true },
        });

        // Track whether we've started content block
        let inContentBlock = false;

        // Stream the response
        for await (const chunk of stream) {
          // Capture finish_reason
          const chunkFinishReason = chunk.choices[0]?.finish_reason;
          if (chunkFinishReason) {
            finishReason = chunkFinishReason;
          }

          // Handle content delta
          const contentDelta = chunk.choices[0]?.delta?.content;
          if (contentDelta) {
            // Emit content.start on first content
            if (!inContentBlock) {
              inContentBlock = true;
              yield { type: 'content.start' };
            }
            streamedContent += contentDelta;
            yield { type: 'content', content: contentDelta };
          }

          // Handle tool calls - accumulate across chunks
          const toolCalls = chunk.choices[0]?.delta?.tool_calls;
          if (toolCalls) {
            for (const toolCall of toolCalls) {
              const index = toolCall.index;
              const existing = accumulatedToolCalls.get(index);

              if (existing) {
                // Append to existing tool call's arguments
                if (toolCall.function?.arguments) {
                  existing.arguments += toolCall.function.arguments;
                }
              } else {
                // New tool call
                accumulatedToolCalls.set(index, {
                  id: toolCall.id || `tc_${Date.now()}_${index}`,
                  name: toolCall.function?.name || '',
                  arguments: toolCall.function?.arguments || '',
                });
              }

              // Emit web_search event for UI
              if (toolCall.function?.name === 'web_search') {
                const args = toolCall.function.arguments;
                if (args) {
                  try {
                    const parsed = JSON.parse(args);
                    if (parsed.query) {
                      const toolId = toolCall.id || `ws_${Date.now()}`;
                      yield { type: 'web_search', id: toolId, query: parsed.query };
                    }
                  } catch {
                    // Arguments may be partial JSON during streaming
                  }
                }
              }
            }
          }

          // Handle token usage (comes in the final chunk with stream_options)
          if (chunk.usage) {
            // Emit content.end when we have usage (end of stream)
            if (inContentBlock) {
              yield { type: 'content.end' };
              inContentBlock = false;
            }

            inputTokens = chunk.usage.prompt_tokens || 0;
            outputTokens = chunk.usage.completion_tokens || 0;

            // Track reasoning tokens for reasoning models
            const completionTokensDetails = chunk.usage.completion_tokens_details;
            if (completionTokensDetails?.reasoning_tokens) {
              reasoningTokens = completionTokensDetails.reasoning_tokens;
            }
            const promptTokensDetails = chunk.usage.prompt_tokens_details;
            if (promptTokensDetails?.cached_tokens) {
              cached_tokens = promptTokensDetails.cached_tokens;
              inputTokens -= cached_tokens;
            }
          }
        }

        // Emit content.end if stream ended without usage chunk
        if (inContentBlock) {
          yield { type: 'content.end' };
        }
      } else {
        // Non-streaming path
        const response = await client.chat.completions.create({
          ...requestParams,
          stream: false,
        });

        // Capture finish_reason
        finishReason = response.choices[0]?.finish_reason || null;

        // Extract and yield content with start/end events
        streamedContent = response.choices[0]?.message?.content || '';
        if (streamedContent) {
          yield { type: 'content.start' };
          yield { type: 'content', content: streamedContent };
          yield { type: 'content.end' };
        }

        // Extract tool calls from non-streaming response
        const messageToolCalls = response.choices[0]?.message?.tool_calls;
        if (messageToolCalls) {
          for (let i = 0; i < messageToolCalls.length; i++) {
            const tc = messageToolCalls[i] as {
              id: string;
              type: string;
              function?: { name: string; arguments: string };
            };
            if (tc.function) {
              accumulatedToolCalls.set(i, {
                id: tc.id,
                name: tc.function.name,
                arguments: tc.function.arguments,
              });
            }
          }
        }

        // Extract token usage
        const usage = response.usage;
        if (usage) {
          inputTokens = usage.prompt_tokens || 0;
          outputTokens = usage.completion_tokens || 0;

          // Track reasoning tokens for reasoning models
          const completionTokensDetails = usage.completion_tokens_details;
          if (completionTokensDetails?.reasoning_tokens) {
            reasoningTokens = completionTokensDetails.reasoning_tokens;
          }
          const promptTokensDetails = usage.prompt_tokens_details;
          if (promptTokensDetails?.cached_tokens) {
            cached_tokens = promptTokensDetails.cached_tokens;
            inputTokens -= cached_tokens;
          }
        }
      }

      // Prepend prefill if provided
      let textContent = streamedContent;
      if (options.preFillResponse) {
        textContent = options.preFillResponse + streamedContent;
      }

      // Build fullContent - include tool_calls if present for agentic loop
      const fullContent: Array<Record<string, unknown>> = [
        { type: 'text' as const, text: textContent },
      ];

      // Add tool_calls block if any tools were called
      if (accumulatedToolCalls.size > 0) {
        const toolCallsArray = Array.from(accumulatedToolCalls.values()).map(tc => ({
          id: tc.id,
          type: 'function',
          function: {
            name: tc.name,
            arguments: tc.arguments,
          },
        }));
        fullContent.push({ type: 'tool_calls', tool_calls: toolCallsArray });
      }

      // Return final result with stopReason for agentic loop
      return {
        textContent,
        fullContent,
        stopReason: finishReason ?? undefined,
        inputTokens,
        outputTokens,
        cacheReadTokens: cached_tokens,
        reasoningTokens: reasoningTokens > 0 ? reasoningTokens : undefined,
      };
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
        fullContent: [],
        error: { message: errorMessage, status: errorStatus, stack: errorStack },
        inputTokens: 0,
        outputTokens: 0,
      };
    }
  }

  protected supportStreaming(modelId: string): boolean {
    if (modelId.startsWith('o') && !modelId.startsWith('o1')) {
      return false;
    }
    if (
      modelId.startsWith('gpt-5') &&
      !(modelId.startsWith('gpt-5-nano') || modelId.startsWith('gpt-5-chat'))
    ) {
      return false;
    }
    return true;
  }

  protected applyReasoning(
    requestParams: ChatCompletionCreateParams,
    options: {
      temperature?: number;
      reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
    }
  ) {
    const modelId = requestParams.model || '';
    const effort = options.reasoningEffort;

    if (options.temperature) requestParams.temperature = options.temperature;

    // Non-reasoning models - early return
    if (modelId.includes('gpt-5') && modelId.includes('-chat')) {
      return;
    }
    if (modelId.startsWith('grok-4') && modelId.includes('non-reasoning')) {
      return;
    }

    // OpenAI o-series: map to low/medium/high
    if (modelId.startsWith('o')) {
      const mappedEffort = mapReasoningEffort(effort, ['low', 'medium', 'high'] as const);
      if (mappedEffort !== undefined) {
        requestParams.reasoning_effort = mappedEffort;
      }
      return;
    }

    // gpt-5.1/5.2: all efforts supported
    if (modelId.startsWith('gpt-5.1') || modelId.startsWith('gpt-5.2')) {
      const mappedEffort = mapReasoningEffort(effort, [
        'none',
        'minimal',
        'low',
        'medium',
        'high',
      ] as const);
      if (mappedEffort !== undefined) {
        requestParams.reasoning_effort = mappedEffort;
      }
      return;
    }

    // gpt-5: all except 'none'
    if (modelId.startsWith('gpt-5')) {
      const mappedEffort = mapReasoningEffort(effort, [
        'minimal',
        'low',
        'medium',
        'high',
      ] as const);
      if (mappedEffort !== undefined) {
        requestParams.reasoning_effort = mappedEffort;
      }
      return;
    }

    // xAI grok-3-mini: only low/high
    if (modelId.startsWith('grok-3-mini')) {
      const mappedEffort = mapReasoningEffort(effort, ['low', 'high'] as const);
      if (mappedEffort !== undefined) {
        requestParams.reasoning_effort = mappedEffort;
      }
      return;
    }

    // xAI grok-4: reasoning-only, no effort param
    if (modelId.startsWith('grok-4')) {
      return;
    }
  }

  protected systemPromptRole(_modelId: string): 'developer' | 'system' {
    return 'system';
  }

  calculateCost(
    modelId: string,
    inputTokens: number,
    outputTokens: number,
    cacheReadTokens: number,
    _reasoningTokens?: number
  ): number {
    // Get model info with pricing data
    const modelInfo = getModelInfo(modelId);

    return (
      (inputTokens / 1_000_000) * modelInfo.inputPrice +
      (outputTokens / 1_000_000) * modelInfo.outputPrice +
      (cacheReadTokens / 1_000_000) * modelInfo.cacheReadPrice
    );
  }

  getModelInfo(modelId: string): ModelInfo {
    return getModelInfo(modelId);
  }

  formatModelInfoForDisplay(info: ModelInfo): string {
    return formatModelInfoForDisplay(info);
  }

  isReasoningModel(modelId: string): boolean {
    return isReasoningModel(modelId);
  }

  migrateMessageRendering(
    fullContent: unknown,
    stopReason: string | null
  ): {
    renderingContent: RenderingBlockGroup[];
    stopReason: MessageStopReason;
  } {
    // OpenAI has simple text-only content: [{ type: 'text', text: string }]
    // Convert to single text group
    let textContent = '';

    if (Array.isArray(fullContent)) {
      for (const block of fullContent as Array<Record<string, unknown>>) {
        if (block.type === 'text' && typeof block.text === 'string') {
          textContent += block.text;
        }
      }
    } else if (typeof fullContent === 'string') {
      textContent = fullContent;
    }

    const renderingContent = textContent.trim()
      ? groupAndConsolidateBlocks([{ type: 'text', text: textContent }])
      : [];

    return {
      renderingContent,
      stopReason: this.mapStopReason(stopReason),
    };
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
   * Extract tool_use blocks from OpenAI Chat Completions fullContent.
   * OpenAI stores tool calls in a different format than Anthropic.
   */
  extractToolUseBlocks(fullContent: unknown): ToolUseBlock[] {
    if (!Array.isArray(fullContent)) return [];

    // OpenAI fullContent may contain tool_calls array from the response
    // Format: [{ type: 'text', text: '...' }, { type: 'tool_calls', tool_calls: [...] }]
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
   * Build tool result messages in OpenAI Chat Completions expected format.
   * OpenAI uses separate tool messages (role: 'tool') for each result.
   */
  buildToolResultMessages(
    assistantContent: unknown,
    toolResults: ToolResultBlock[],
    textContent: string
  ): Message<unknown>[] {
    // Assistant message with the original fullContent
    const assistantMessage: Message<unknown> = {
      id: generateUniqueId('msg_assistant'),
      role: MessageRole.ASSISTANT,
      content: {
        type: 'text',
        content: textContent,
        modelFamily: APIType.CHATGPT,
        fullContent: assistantContent,
      },
      timestamp: new Date(),
    };

    // OpenAI expects individual tool messages with role: 'tool'
    // We store them as a single user message with tool_results for our internal format
    const toolResultMessage: Message<unknown> = {
      id: generateUniqueId('msg_user'),
      role: MessageRole.USER,
      content: {
        type: 'text',
        content: '',
        modelFamily: APIType.CHATGPT,
        fullContent: toolResults.map(tr => ({
          type: 'tool_result',
          tool_call_id: tr.tool_use_id,
          content: tr.content,
          is_error: tr.is_error,
        })),
      },
      timestamp: new Date(),
    };

    return [assistantMessage, toolResultMessage];
  }

  /**
   * Get client-side tool definitions for OpenAI format.
   */
  protected getClientSideTools(enabledTools: string[]): ChatCompletionTool[] {
    return toolRegistry.getToolDefinitionsForAPI(APIType.CHATGPT, enabledTools);
  }
}
