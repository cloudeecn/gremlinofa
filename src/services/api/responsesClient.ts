import OpenAI from 'openai';
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
import { toolRegistry } from '../tools/clientSideTools';
import type { APIClient, StreamChunk, StreamResult } from './baseClient';
import type { ModelInfo } from './modelInfo';
import { formatModelInfoForDisplay, getModelInfo, isReasoningModel } from './openaiModelInfo';

export class ResponsesClient implements APIClient {
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
        apiType: APIType.RESPONSES_API,
        contextWindow: getModelInfo(openaiModel.id).contextWindow,
      }));

      return models;
    } catch (error: unknown) {
      console.error('Failed to discover OpenAI models:', error);

      // Fall back to hardcoded list if API call fails
      return [
        {
          id: 'gpt-5',
          name: 'GPT-5',
          apiType: APIType.RESPONSES_API,
          contextWindow: 128000,
        },
        {
          id: 'gpt-5-chat-latest',
          name: 'GPT-5 Chat',
          apiType: APIType.RESPONSES_API,
          contextWindow: 128000,
        },
        {
          id: 'gpt-4o',
          name: 'GPT-4o',
          apiType: APIType.RESPONSES_API,
          contextWindow: 128000,
        },
        {
          id: 'gpt-4.1-mini',
          name: 'GPT-4.1 Mini',
          apiType: APIType.RESPONSES_API,
          contextWindow: 8192,
        },
        {
          id: 'gpt-4.1',
          name: 'GPT-4.1',
          apiType: APIType.RESPONSES_API,
          contextWindow: 8192,
        },
        {
          id: 'o3',
          name: 'o3',
          apiType: APIType.RESPONSES_API,
          contextWindow: 128000,
        },
        {
          id: 'o3-mini',
          name: 'o3-mini',
          apiType: APIType.RESPONSES_API,
          contextWindow: 128000,
        },
        {
          id: 'o1',
          name: 'o1',
          apiType: APIType.RESPONSES_API,
          contextWindow: 200000,
        },
        {
          id: 'o1-mini',
          name: 'o1-mini',
          apiType: APIType.RESPONSES_API,
          contextWindow: 128000,
        },
      ];
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
      temperature?: number;
      maxTokens: number;
      enableReasoning: boolean;
      reasoningBudgetTokens: number;
      systemPrompt?: string;
      preFillResponse?: string;
      webSearchEnabled?: boolean;
      enabledTools?: string[];
    }
  ): AsyncGenerator<StreamChunk, StreamResult<unknown>, unknown> {
    let requestParams: OpenAI.Responses.ResponseCreateParams = {};
    try {
      // Create OpenAI client with API key and custom baseUrl if provided
      const client = new OpenAI({
        dangerouslyAllowBrowser: true,
        apiKey: apiDefinition.apiKey,
        baseURL: apiDefinition.baseUrl || undefined,
      });

      // Build input array using ResponseInputItem format
      const input: OpenAI.Responses.ResponseInputItem[] = [];

      // Add system prompt if provided
      if (options.systemPrompt) {
        input.push({
          role: 'system',
          content: [
            {
              type: 'input_text',
              text: options.systemPrompt,
            },
          ],
        });
      }

      // Add conversation messages
      messages.forEach(msg => {
        if (msg.role === MessageRole.USER) {
          // Check if this is a tool result message (fullContent has function_call_output items)
          if (msg.content.fullContent && Array.isArray(msg.content.fullContent)) {
            const fullContentArr = msg.content.fullContent as Array<Record<string, unknown>>;
            const hasFunctionCallOutput = fullContentArr.some(
              item => item.type === 'function_call_output'
            );
            if (hasFunctionCallOutput) {
              // Add function_call_output items directly
              for (const item of fullContentArr) {
                if (item.type === 'function_call_output') {
                  input.push(item as unknown as OpenAI.Responses.ResponseInputItem);
                }
              }
              return; // Skip normal user message processing
            }
          }

          const contentItems: (
            | OpenAI.Responses.ResponseInputText
            | OpenAI.Responses.ResponseInputImage
          )[] = [];

          // Add images first if attachments present
          if (msg.attachments && msg.attachments.length > 0) {
            for (const attachment of msg.attachments) {
              contentItems.push({
                type: 'input_image',
                image_url: `data:${attachment.mimeType};base64,${attachment.data}`,
              } as OpenAI.Responses.ResponseInputImage);
            }
          }

          // Add text content
          contentItems.push({
            type: 'input_text',
            text: msg.content.content,
          });

          input.push({
            role: 'user',
            content: contentItems,
          });
        } else if (msg.role === MessageRole.ASSISTANT) {
          if (msg.content.fullContent && Array.isArray(msg.content.fullContent)) {
            // Include message and function_call items (not just messages)
            // Clean items to strip output-only fields (handles old stored messages)
            for (const m of (msg.content.fullContent as Array<Record<string, unknown>>).filter(
              m => m.type === 'message' || m.type === 'function_call'
            )) {
              input.push(this.cleanStoredItem(m) as unknown as OpenAI.Responses.ResponseInputItem);
            }
          } else {
            input.push({
              role: 'assistant',
              content: msg.content.content,
            });
          }
        }
      });

      // Add pre-fill response if provided
      if (options.preFillResponse) {
        input.push({
          role: 'assistant',
          content: [
            {
              type: 'input_text',
              text: options.preFillResponse,
            },
          ],
        });
      }

      // Prepare tools if web search is enabled
      const tools: OpenAI.Responses.Tool[] = options.webSearchEnabled
        ? [
            {
              type: 'web_search',
            },
          ]
        : [];

      // Add client-side tool definitions
      const clientToolDefs = this.getClientSideTools(options.enabledTools || []);
      tools.push(...clientToolDefs);

      // Prepare API request parameters
      requestParams = {
        model: modelId,
        input: input,
        max_output_tokens: options.maxTokens,
        store: false, // Keep chat history in the app
      };

      this.applyReasoning(requestParams, options);

      // Add tools if present
      if (tools.length > 0) {
        requestParams.tools = tools;
      }

      // Check if model supports streaming
      const supportsStreaming = this.supportsStreaming(modelId);

      if (supportsStreaming) {
        // STREAMING PATH
        const stream = client.responses.stream({
          ...requestParams,
          stream: true,
        });

        // Track whether we've started content/thinking blocks
        let inContentBlock = false;
        let inThinkingBlock = false;

        // Stream the response events
        for await (const event of stream) {
          yield { type: 'event', content: event.type };

          // Handle content start event
          if (event.type === 'response.content_part.added') {
            const part = event.part as { type?: string };
            if (part.type === 'output_text') {
              inContentBlock = true;
              yield { type: 'content.start' };
            }
          }

          // Handle content done event
          if (event.type === 'response.content_part.done') {
            const part = event.part as { type?: string };
            if (part.type === 'output_text' && inContentBlock) {
              inContentBlock = false;
              yield { type: 'content.end' };
            }
          }

          // Handle reasoning start event (cast to string for event types not in SDK typings)
          if ((event.type as string) === 'response.reasoning.added') {
            inThinkingBlock = true;
            yield { type: 'thinking.start' };
          }

          // Handle reasoning done event
          if ((event.type as string) === 'response.reasoning.done') {
            if (inThinkingBlock) {
              inThinkingBlock = false;
              yield { type: 'thinking.end' };
            }
          }

          // Handle text delta events
          if (event.type === 'response.output_text.delta') {
            // Emit content.start if we haven't yet (fallback)
            if (!inContentBlock) {
              inContentBlock = true;
              yield { type: 'content.start' };
            }
            yield { type: 'content', content: event.delta };
          }

          // Handle reasoning text delta events
          if (event.type === 'response.reasoning_text.delta') {
            // Emit thinking.start if we haven't yet (fallback)
            if (!inThinkingBlock) {
              inThinkingBlock = true;
              yield { type: 'thinking.start' };
            }
            yield { type: 'thinking', content: event.delta };
          }

          // Handle web search events
          if (event.type === 'response.output_item.added') {
            const item = event.item as { type?: string; status?: string };
            if (item.type === 'web_search_call') {
              // Web search tool invoked
            }
          }

          // Handle web search result events
          if (event.type === 'response.web_search_call.searching') {
            const searchEvent = event as { id?: string; query?: string };
            if (searchEvent.query) {
              yield {
                type: 'web_search',
                id: searchEvent.id || `ws_${Date.now()}`,
                query: searchEvent.query,
              };
            }
          }

          if (event.type === 'response.web_search_call.completed') {
            // Web search completed - results may be in the event
          }

          // Yield token usage updates during streaming if available
          if (event.type === 'response.completed' && event.response.usage) {
            // Emit end events for any open blocks
            if (inContentBlock) {
              yield { type: 'content.end' };
              inContentBlock = false;
            }
            if (inThinkingBlock) {
              yield { type: 'thinking.end' };
              inThinkingBlock = false;
            }

            const usage = event.response.usage;
            const inputTokens = usage.input_tokens || 0;
            const outputTokens = usage.output_tokens || 0;
            const cachedTokens = usage.input_tokens_details?.cached_tokens || 0;
            const reasoningTokens = usage.output_tokens_details?.reasoning_tokens || 0;

            yield {
              type: 'token_usage',
              inputTokens: inputTokens - cachedTokens,
              outputTokens,
              cacheReadTokens: cachedTokens,
              reasoningTokens: reasoningTokens > 0 ? reasoningTokens : undefined,
            };
          }
        }

        // Get the final assembled response after streaming completes
        const finalResponse = await stream.finalResponse();

        // Process and return final response
        return this.processResponse(finalResponse);
      } else {
        // NON-STREAMING PATH
        const response = await client.responses.create({
          ...requestParams,
          stream: false,
        });

        // Process and return response (no yielding for non-streaming)
        return this.processResponse(response);
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
            errorMessage = 'Invalid API key. Please check your API key in settings.';
          } else if (errorStatus === 429) {
            errorMessage = 'Rate limit exceeded. Please try again later.';
          } else if (errorStatus === 500 || errorStatus === 502 || errorStatus === 503) {
            errorMessage = 'API is currently unavailable. Please try again later.';
          } else if (errorStatus >= 400 && errorStatus < 500 && error instanceof Error) {
            errorMessage = `Bad request: ${error.message}, request: \n ${JSON.stringify(requestParams, undefined, 2)}`;
          }
        }
        if (
          'message' in error &&
          typeof error.message === 'string' &&
          !errorMessage.includes('API key') &&
          !errorMessage.includes('Bad request')
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

  /**
   * Check if a model supports streaming
   */
  private supportsStreaming(modelId: string): boolean {
    // Models that don't support streaming:
    // - o3, o3-mini, o4-mini (but o1 does support streaming)
    // - gpt-5 (except gpt-5-nano and gpt-5-chat)
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

  /**
   * Process a Response object and extract content and token usage
   */
  private processResponse(
    response: OpenAI.Responses.Response
  ): StreamResult<OpenAI.Responses.ResponseInputItem[]> {
    // Extract text content from output
    let textContent = response.output_text;
    const fullContent = response.output
      .map(output => this.convertOutputToContext(output))
      .filter(input => input !== undefined);
    let thinkingContent = '';
    let thinkingSummary = '';
    let hasFunctionCall = false;

    if (!textContent) {
      textContent = '';
      for (const item of response.output) {
        if (item.type === 'message') {
          for (const content of item.content) {
            if (content.type === 'output_text') {
              textContent += content.text;
            } else if (content.type === 'refusal') {
              textContent += content.refusal;
            }
          }
        }
        if (item.type === 'function_call') {
          hasFunctionCall = true;
        }
      }
    } else {
      // Check for function_call even when there's text content
      for (const item of response.output) {
        if (item.type === 'function_call') {
          hasFunctionCall = true;
          break;
        }
      }
    }

    for (const item of response.output) {
      if (item.type === 'reasoning') {
        for (const summary of item.summary) {
          if (summary.type === 'summary_text') {
            thinkingSummary += summary.text;
          }
        }
        if (item.content) {
          for (const content of item.content) {
            if (content.type === 'reasoning_text') {
              thinkingContent += content.text;
            }
          }
        }
      }
    }

    // Extract token usage
    const usage = response.usage;
    const inputTokens = usage?.input_tokens || 0;
    const outputTokens = usage?.output_tokens || 0;
    const cachedTokens = usage?.input_tokens_details?.cached_tokens || 0;
    const reasoningTokens = usage?.output_tokens_details?.reasoning_tokens || 0;

    return {
      textContent,
      thinkingContent: thinkingContent || thinkingSummary || undefined,
      fullContent,
      stopReason: hasFunctionCall ? 'tool_use' : undefined,
      inputTokens: inputTokens - cachedTokens,
      outputTokens,
      cacheReadTokens: cachedTokens,
      reasoningTokens: reasoningTokens > 0 ? reasoningTokens : undefined,
    };
  }

  protected applyReasoning(
    requestParams: OpenAI.Responses.ResponseCreateParams,
    options: {
      enableReasoning: boolean;
      temperature?: number;
      reasoningBudgetTokens: number;
    }
  ) {
    const effort = (() => {
      // Map reasoningBudgetTokens to effort level
      if (options.reasoningBudgetTokens <= 1024) {
        return 'low';
      }
      if (options.reasoningBudgetTokens <= 4096) {
        return 'medium';
      }
      return 'high';
    })();
    const modelId = requestParams.model || '';
    // gpt 5 chat series are all non-reasoning
    if (modelId.includes('gpt-5') && modelId.includes('-chat')) {
      if (options.temperature) requestParams.temperature = options.temperature;
      return;
    }
    if (modelId.startsWith('o')) {
      // o-series are reasoning only
      requestParams.reasoning = { effort, summary: 'detailed' };
      return;
    }
    if (modelId.startsWith('gpt-5.1')) {
      // gpt-5 is reasoning only, but can use reasoning_effort minimal to minimize reasoning
      requestParams.reasoning = {
        effort: options.enableReasoning ? effort : 'none',
      };

      return;
    }

    if (modelId.startsWith('gpt-5')) {
      // gpt-5 is reasoning only, but can use reasoning_effort minimal to minimize reasoning
      requestParams.reasoning = {
        effort: options.enableReasoning ? effort : 'minimal',
      };

      return;
    }

    if (modelId.startsWith('grok-3-mini')) {
      if (options.enableReasoning) {
        requestParams.reasoning = {
          effort: effort == 'high' ? 'high' : 'low',
          summary: 'detailed',
        };
      } else {
        if (options.temperature) requestParams.temperature = options.temperature;
      }
      return;
    }

    if (modelId.startsWith('grok-4-fast-non-reasoning')) {
      // No reasoning model
      if (options.temperature) requestParams.temperature = options.temperature;
      return;
    }

    if (modelId.startsWith('grok-4')) {
      // Grok 4 does not have a reasoning_effort parameter and supports only reasoning.
      // Try to request for reasoning summary
      requestParams.reasoning = {
        summary: 'detailed',
      };
      return;
    }
    if (options.temperature) requestParams.temperature = options.temperature;
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

  /**
   * Clean stored items when loading from storage.
   * Uses blacklist approach - spread original and only delete known problematic fields.
   */
  private cleanStoredItem(item: Record<string, unknown>): Record<string, unknown> {
    if (item.type === 'message' && Array.isArray(item.content)) {
      return {
        ...item,
        content: (item.content as Array<Record<string, unknown>>).map(part => {
          if (part.type === 'output_text') {
            const cleaned = { ...part };
            delete cleaned.parsed;
            return cleaned;
          }
          return part;
        }),
      };
    } else if (item.type === 'function_call') {
      {
        const { parsed_arguments: _parsed_arguments, ...cleaned } = item;
        return cleaned;
      }
    }
    return item;
  }

  private convertOutputToContext(
    output: OpenAI.Responses.ResponseOutputItem
  ): OpenAI.Responses.ResponseInputItem | undefined {
    // Handle apply_patch_call - only include if operation is present
    if (output.type === 'apply_patch_call') {
      if (output.operation !== undefined) {
        return { ...output, operation: output.operation };
      } else {
        return undefined; // Skip incomplete patch calls without operation
      }
    }

    if (output.type === 'apply_patch_call_output') {
      if (output.output === null) {
        return { ...output, output: undefined };
      } else {
        return { ...output, output: output.output };
      }
    }

    // Handle function_call - pass through as-is
    if (output.type === 'function_call') {
      return output as unknown as OpenAI.Responses.ResponseInputItem;
    }

    // Handle message - spread and delete problematic fields from content parts
    if (output.type === 'message') {
      return {
        ...output,
        content: output.content.map(part => {
          if (part.type === 'output_text') {
            const cleaned = { ...part } as Record<string, unknown>;
            delete cleaned.parsed;
            delete cleaned.logprobs;
            delete cleaned.annotations;
            return cleaned;
          }
          return part;
        }),
      } as unknown as OpenAI.Responses.ResponseInputItem;
    }

    return output;
  }

  migrateMessageRendering(
    fullContent: unknown,
    stopReason: string | null
  ): {
    renderingContent: RenderingBlockGroup[];
    stopReason: MessageStopReason;
  } {
    // Responses API stores fullContent as ResponseInputItem[] (message objects)
    // Extract text content from the message objects
    let textContent = '';

    if (Array.isArray(fullContent)) {
      for (const item of fullContent as Array<Record<string, unknown>>) {
        if (item.type === 'message' && item.role === 'assistant') {
          const content = item.content;
          if (Array.isArray(content)) {
            for (const part of content as Array<Record<string, unknown>>) {
              if (part.type === 'output_text' && typeof part.text === 'string') {
                textContent += part.text;
              }
            }
          } else if (typeof content === 'string') {
            textContent += content;
          }
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
   * Map OpenAI Responses API status to MessageStopReason.
   */
  private mapStopReason(stopReason: string | null): MessageStopReason {
    if (!stopReason) {
      return 'end_turn';
    }
    // Responses API uses: completed, incomplete, failed, in_progress, cancelled
    switch (stopReason) {
      case 'completed':
        return 'end_turn';
      case 'incomplete':
        return 'max_tokens';
      case 'failed':
        return 'error';
      case 'cancelled':
        return 'cancelled';
      default:
        return stopReason;
    }
  }

  /**
   * Extract tool_use blocks from OpenAI Responses API fullContent.
   * Responses API stores function calls differently than Chat Completions.
   */
  extractToolUseBlocks(fullContent: unknown): ToolUseBlock[] {
    if (!Array.isArray(fullContent)) return [];

    // Responses API fullContent may contain function_call items
    // Format: [{ type: 'function_call', call_id: '...', name: '...', arguments: '...' }]
    // Note: call_id is used for matching function_call_output, not id
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

  /**
   * Build tool result messages in OpenAI Responses API expected format.
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
        modelFamily: APIType.RESPONSES_API,
        fullContent: assistantContent,
      },
      timestamp: new Date(),
    };

    // Store tool results in our internal format
    const toolResultMessage: Message<unknown> = {
      id: generateUniqueId('msg_user'),
      role: MessageRole.USER,
      content: {
        type: 'text',
        content: '',
        modelFamily: APIType.RESPONSES_API,
        fullContent: toolResults.map(tr => ({
          type: 'function_call_output',
          call_id: tr.tool_use_id,
          output: tr.content,
        })),
      },
      timestamp: new Date(),
    };

    return [assistantMessage, toolResultMessage];
  }

  /**
   * Get client-side tool definitions for Responses API format.
   */
  protected getClientSideTools(enabledTools: string[]): OpenAI.Responses.Tool[] {
    const toolDefs = toolRegistry.getToolDefinitionsForAPI(APIType.RESPONSES_API, enabledTools);
    return toolDefs as unknown as OpenAI.Responses.Tool[];
  }
}
