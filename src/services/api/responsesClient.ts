import OpenAI from 'openai';
import type {
  APIDefinition,
  Message,
  MessageStopReason,
  Model,
  RenderingBlockGroup,
  RenderingContentBlock,
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
import {
  convertOutputToStreamChunks,
  createMapperState,
  createTokenUsageChunk,
  mapResponsesEventToStreamChunks,
  parseResponsesStreamEvent,
} from './responsesStreamMapper';

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
    messages: Message<OpenAI.Responses.ResponseInputItem[]>[],
    modelId: string,
    apiDefinition: APIDefinition,
    options: {
      temperature?: number;
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
  ): AsyncGenerator<StreamChunk, StreamResult<OpenAI.Responses.ResponseInputItem[]>, unknown> {
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
          if (
            msg.content.modelFamily === APIType.RESPONSES_API &&
            msg.content.fullContent &&
            Array.isArray(msg.content.fullContent)
          ) {
            // Cast through unknown since stored data loses SDK type info
            const fullContentArr = msg.content.fullContent;
            const hasFunctionCallOutput = fullContentArr.some(
              item => item.type === 'function_call_output'
            );
            if (hasFunctionCallOutput) {
              // Add function_call_output items directly
              for (const item of fullContentArr) {
                if (item.type === 'function_call_output') {
                  input.push(item);
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
          if (
            msg.content.modelFamily === APIType.RESPONSES_API &&
            msg.content.fullContent &&
            Array.isArray(msg.content.fullContent)
          ) {
            // Include message and function_call items (not just messages)
            // Clean items to strip output-only fields (handles old stored messages)
            // Cast through unknown since stored data loses SDK type info
            const storedItems = msg.content.fullContent as OpenAI.Responses.ResponseOutputItem[];
            for (const m of storedItems.filter(
              m => m.type === 'message' || m.type === 'function_call'
            )) {
              input.push(m);
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
        // STREAMING PATH - use mapper functions
        const stream = client.responses.stream({
          ...requestParams,
          stream: true,
        });

        let mapperState = createMapperState();

        for await (const event of stream) {
          // Convert SDK event to SSE event format for mapper
          // ResponseStreamEvent is a union type - cast through unknown to access generic properties
          const sseEvent = parseResponsesStreamEvent(event);
          const result = mapResponsesEventToStreamChunks(sseEvent, mapperState);
          mapperState = result.state;

          for (const chunk of result.chunks) {
            yield chunk;
          }
        }

        // Get the final assembled response after streaming completes
        const finalResponse = await stream.finalResponse();

        // Process and return final response
        return this.processResponse(finalResponse);
      } else {
        // NON-STREAMING PATH - convert output to chunks
        const response = await client.responses.create({
          ...requestParams,
          stream: false,
        });

        // Yield chunks for non-streaming response
        const chunks = convertOutputToStreamChunks(response.output);
        for (const chunk of chunks) {
          yield chunk;
        }

        // Yield token usage
        if (response.usage) {
          yield createTokenUsageChunk(response.usage);
        }

        // Process and return response
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
  ): StreamResult<OpenAI.Responses.ResponseOutputItem[]> {
    // Extract text content from output
    let textContent = response.output_text;
    const fullContent = response.output.filter(output => output !== undefined);
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
      temperature?: number;
      reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
      reasoningSummary?: 'auto' | 'concise' | 'detailed';
    }
  ) {
    const modelId = requestParams.model || '';
    const effort = options.reasoningEffort;
    const summary = options.reasoningSummary;

    if (options.temperature) requestParams.temperature = options.temperature;

    // No reasoning models - early return
    if (modelId.includes('gpt-5') && modelId.includes('-chat')) {
      return;
    }
    if (modelId.startsWith('grok-4') && modelId.includes('non-reasoning')) {
      return;
    }

    // OpenAI o-series: map to low/medium/high
    if (modelId.startsWith('o')) {
      const mappedEffort = mapReasoningEffort(effort, ['low', 'medium', 'high'] as const);
      if (mappedEffort !== undefined || summary !== undefined) {
        requestParams.reasoning = { effort: mappedEffort, summary };
      }
      requestParams.include = ['reasoning.encrypted_content'];
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
      if (mappedEffort !== undefined || summary !== undefined) {
        requestParams.reasoning = { effort: mappedEffort, summary };
      }
      requestParams.include = ['reasoning.encrypted_content'];
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
      if (mappedEffort !== undefined || summary !== undefined) {
        requestParams.reasoning = { effort: mappedEffort, summary };
      }
      requestParams.include = ['reasoning.encrypted_content'];
      return;
    }

    // xAI grok-3-mini: only low/high
    if (modelId.startsWith('grok-3-mini')) {
      const mappedEffort = mapReasoningEffort(effort, ['low', 'high'] as const);
      if (mappedEffort !== undefined || summary !== undefined) {
        requestParams.reasoning = { effort: mappedEffort, summary };
        requestParams.include = ['reasoning.encrypted_content'];
      }
      return;
    }

    // xAI grok-4: reasoning-only, no effort param
    if (modelId.startsWith('grok-4')) {
      if (summary !== undefined) {
        requestParams.reasoning = { summary };
      }
      requestParams.include = ['reasoning.encrypted_content'];
      return;
    }

    // Other models: inject reasoning if effort or summary specified
    if (effort !== undefined || summary !== undefined) {
      requestParams.reasoning = { summary };
      requestParams.include = ['reasoning.encrypted_content'];
    }
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
    // Responses API stores fullContent as ResponseInputItem[] (output items)
    // Convert each item to appropriate RenderingContentBlock
    const blocks: RenderingContentBlock[] = [];
    let mappedStopReason = this.mapStopReason(stopReason);

    if (Array.isArray(fullContent)) {
      for (const item of fullContent as Array<Record<string, unknown>>) {
        switch (item.type) {
          case 'reasoning': {
            // Extract text from summary array
            const summary = item.summary as Array<Record<string, unknown>> | undefined;
            if (summary && Array.isArray(summary)) {
              let thinkingText = '';
              for (const part of summary) {
                if (part.type === 'summary_text' && typeof part.text === 'string') {
                  thinkingText += part.text;
                }
              }
              if (thinkingText.trim()) {
                blocks.push({ type: 'thinking', thinking: thinkingText });
              }
            }
            break;
          }

          case 'web_search_call': {
            // Extract query from action
            const action = item.action as Record<string, unknown> | undefined;
            const id = (item.id as string) || '';
            if (action) {
              const actionType = action.type as string;
              let query = '';
              if (actionType === 'search') {
                query = (action.query as string) || '';
              } else if (actionType === 'open_page') {
                query = `Opening: ${action.url as string}`;
              }

              // Extract sources as results
              const sources = action.sources as Array<Record<string, unknown>> | undefined;
              const results = (sources || []).map(source => ({
                title: (source.title as string) || '',
                url: (source.url as string) || '',
              }));

              if (query) {
                blocks.push({
                  type: 'web_search',
                  id,
                  query,
                  results,
                });
              }
            }
            break;
          }

          case 'function_call': {
            // Tool use block
            const callId = (item.call_id as string) || (item.id as string) || '';
            const name = (item.name as string) || '';
            const argsStr = (item.arguments as string) || '{}';
            let input: Record<string, unknown> = {};
            try {
              input = JSON.parse(argsStr) as Record<string, unknown>;
            } catch {
              // Keep empty input on parse failure
            }

            blocks.push({
              type: 'tool_use',
              id: callId,
              name,
              input,
            });

            // Function call means tool_use stop reason
            mappedStopReason = 'tool_use';
            break;
          }

          case 'message': {
            // Extract text from message content
            if (item.role !== 'assistant') continue;

            const content = item.content;
            if (Array.isArray(content)) {
              let textContent = '';
              for (const part of content as Array<Record<string, unknown>>) {
                if (part.type === 'output_text' && typeof part.text === 'string') {
                  textContent += part.text;
                } else if (part.type === 'refusal' && typeof part.refusal === 'string') {
                  textContent += part.refusal;
                }
              }
              if (textContent.trim()) {
                blocks.push({ type: 'text', text: textContent });
              }
            } else if (typeof content === 'string' && content.trim()) {
              blocks.push({ type: 'text', text: content });
            }
            break;
          }

          default:
            // Skip unknown item types
            break;
        }
      }
    } else if (typeof fullContent === 'string' && fullContent.trim()) {
      // Legacy format: just text content
      blocks.push({ type: 'text', text: fullContent });
    }

    return {
      renderingContent: groupAndConsolidateBlocks(blocks),
      stopReason: mappedStopReason,
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
  ): Message<OpenAI.Responses.ResponseInputItem[]>[] {
    // Assistant message with the original fullContent (ResponseOutputItem[] which is subset of ResponseInputItem[])
    const assistantMessage: Message<OpenAI.Responses.ResponseInputItem[]> = {
      id: generateUniqueId('msg_assistant'),
      role: MessageRole.ASSISTANT,
      content: {
        type: 'text',
        content: textContent,
        modelFamily: APIType.RESPONSES_API,
        fullContent: assistantContent as OpenAI.Responses.ResponseInputItem[],
      },
      timestamp: new Date(),
    };

    // Store tool results as FunctionCallOutput items
    const functionCallOutputs: OpenAI.Responses.ResponseInputItem.FunctionCallOutput[] =
      toolResults.map(tr => ({
        type: 'function_call_output' as const,
        call_id: tr.tool_use_id,
        output: tr.content,
      }));

    const toolResultMessage: Message<OpenAI.Responses.ResponseInputItem[]> = {
      id: generateUniqueId('msg_user'),
      role: MessageRole.USER,
      content: {
        type: 'text',
        content: '',
        modelFamily: APIType.RESPONSES_API,
        fullContent: functionCallOutputs,
      },
      timestamp: new Date(),
    };

    return [assistantMessage, toolResultMessage];
  }

  /**
   * Get client-side tool definitions for Responses API format.
   */
  protected getClientSideTools(enabledTools: string[]): OpenAI.Responses.Tool[] {
    return toolRegistry.getToolDefinitionsForAPI(APIType.RESPONSES_API, enabledTools);
  }
}
