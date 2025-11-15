import OpenAI from 'openai';
import type { ChatCompletionCreateParams, ChatCompletionTool } from 'openai/resources/index.mjs';
import type {
  APIDefinition,
  Message,
  MessageStopReason,
  Model,
  RenderingBlockGroup,
} from '../../types';

import { APIType, groupAndConsolidateBlocks, MessageRole } from '../../types';
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
    messages: Message<OpenAI.ChatCompletionContentPart[]>[],
    modelId: string,
    apiDefinition: APIDefinition,
    options: {
      temperature: number;
      maxTokens: number;
      enableReasoning: boolean;
      reasoningBudgetTokens: number;
      systemPrompt?: string;
      preFillResponse?: string;
      webSearchEnabled?: boolean;
    }
  ): AsyncGenerator<StreamChunk, StreamResult<OpenAI.ChatCompletionContentPart[]>, unknown> {
    try {
      // Create OpenAI client with API key and custom baseUrl if provided
      const client = new OpenAI({
        dangerouslyAllowBrowser: true,
        apiKey: apiDefinition.apiKey,
        baseURL: apiDefinition.baseUrl || undefined,
      });

      const reasoningEffort = this.getReasoningEffort(options.reasoningBudgetTokens);
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
      };

      if (options.webSearchEnabled) {
        if (modelId.startsWith('grok')) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (requestParams as any)['search_parameters'] = { mode: 'auto' };
        } else {
          requestParams.tools = [{ type: 'web_search' } as unknown as ChatCompletionTool];
        }
      }

      this.applyReasoning(requestParams, options, reasoningEffort);

      // Track streamed content and token usage
      let streamedContent = '';
      let inputTokens = 0;
      let outputTokens = 0;
      let cached_tokens = 0;
      let reasoningTokens = 0;

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

          // Handle tool calls (e.g., web_search)
          const toolCalls = chunk.choices[0]?.delta?.tool_calls;
          if (toolCalls) {
            for (const toolCall of toolCalls) {
              if (toolCall.function?.name === 'web_search') {
                // Web search tool invoked - try to extract query from arguments
                const toolId = toolCall.id || `ws_${Date.now()}`;
                const args = toolCall.function.arguments;
                if (args) {
                  try {
                    const parsed = JSON.parse(args);
                    if (parsed.query) {
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

        // Extract and yield content with start/end events
        streamedContent = response.choices[0]?.message?.content || '';
        if (streamedContent) {
          yield { type: 'content.start' };
          yield { type: 'content', content: streamedContent };
          yield { type: 'content.end' };
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

      // Wrap in content block format for consistency
      const fullContent = [{ type: 'text' as const, text: textContent }];

      // Return final result
      return {
        textContent,
        fullContent,
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
    options: { enableReasoning: boolean; temperature: number },
    effort: 'low' | 'medium' | 'high'
  ) {
    const modelId = requestParams.model;
    if (modelId.startsWith('o')) {
      // o-series are reasoning only
      requestParams.reasoning_effort = effort;
      return;
    }
    if (modelId.startsWith('gpt-5') && !modelId.startsWith('gpt-5-chat')) {
      // gpt-5 is reasoning only, but can use reasoning_effort minimal to minimize reasoning
      requestParams.reasoning_effort = options.enableReasoning ? effort : 'minimal';

      return;
    }

    if (modelId.startsWith('grok-3-mini')) {
      if (options.enableReasoning) {
        requestParams.reasoning_effort = effort === 'high' ? 'high' : 'low';
      } else {
        requestParams.temperature = options.temperature;
      }
      return;
    }

    if (modelId.startsWith('grok-4-fast-non-reasoning')) {
      // No reasoning model
      requestParams.temperature = options.temperature;
      return;
    }

    if (modelId.startsWith('grok-4')) {
      // Grok 4 does not have a reasoning_effort parameter and supports only reasoning.
      // Nor grok-4-fast-reasoning, so nothing to deal with them at all.
      return;
    }
    requestParams.temperature = options.temperature;
  }

  protected systemPromptRole(_modelId: string): 'developer' | 'system' {
    return 'system';
  }

  private getReasoningEffort(reasoningBudgetTokens: number): 'low' | 'medium' | 'high' {
    // Map reasoningBudgetTokens to effort level
    if (reasoningBudgetTokens <= 1024) {
      return 'low';
    }
    if (reasoningBudgetTokens <= 4096) {
      return 'medium';
    }
    return 'high';
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
        return 'end_turn'; // Treat tool use as normal end
      case 'content_filter':
        return 'error';
      default:
        return stopReason;
    }
  }
}
