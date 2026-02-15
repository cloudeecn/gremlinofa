import OpenAI from 'openai';
import type {
  APIDefinition,
  Message,
  MessageStopReason,
  Model,
  ReasoningEffort,
  RenderingBlockGroup,
  RenderingContentBlock,
  ToolResultBlock,
  ToolUseBlock,
  ToolOptions,
} from '../../types';

import { groupAndConsolidateBlocks } from '../../types';
import { generateUniqueId } from '../../utils/idGenerator';
import { mapReasoningEffort } from '../../utils/reasoningEffort';
import { toolRegistry } from '../tools/clientSideTools';
import type { APIClient, StreamChunk, StreamResult } from './baseClient';
import {
  convertOutputToStreamChunks,
  createMapperState,
  createTokenUsageChunk,
  mapResponsesEventToStreamChunks,
  parseResponsesStreamEvent,
} from './responsesStreamMapper';
import { applyContextSwipe, type FilterBlocksFn } from './contextSwipe';
import { getModelMetadataFor } from './modelMetadata';
import { storage } from '../storage';
import {
  populateFromOpenRouterModel,
  type OpenRouterModel,
} from './model_metadatas/openRouterModelMapper';

/**
 * Responses API block filter for context swipe.
 * Removes reasoning items always, function_call by name, function_call_output by ID.
 */
const filterResponsesBlocks: FilterBlocksFn = (
  fullContent,
  removedToolNames,
  isCheckpoint,
  removedToolUseIds
) => {
  if (!Array.isArray(fullContent)) return { filtered: fullContent, newRemovedIds: [] };

  const filtered: unknown[] = [];
  const newRemovedIds: string[] = [];

  for (const item of fullContent) {
    const i = item as { type?: string; name?: string; call_id?: string };

    // Always remove reasoning blocks
    if (i.type === 'reasoning') continue;

    // Checkpoint message: only reasoning removed
    if (isCheckpoint) {
      filtered.push(item);
      continue;
    }

    // function_call — remove if name matches
    if (i.type === 'function_call' && i.name && removedToolNames.has(i.name)) {
      if (i.call_id) newRemovedIds.push(i.call_id);
      continue;
    }

    // function_call_output — remove if matching a removed call
    if (i.type === 'function_call_output' && i.call_id && removedToolUseIds.has(i.call_id)) {
      continue;
    }

    filtered.push(item);
  }

  return { filtered, newRemovedIds };
};

export class ResponsesClient implements APIClient {
  async discoverModels(apiDefinition: APIDefinition): Promise<Model[]> {
    // Create OpenAI client with API key and custom baseUrl if provided
    const client = new OpenAI({
      dangerouslyAllowBrowser: true,
      apiKey: apiDefinition.apiKey,
      baseURL: apiDefinition.baseUrl || undefined,
    });

    // Get all models from the API
    const modelsResponse = await client.models.list();

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
      toolOptions?: Record<string, ToolOptions>;
      disableStream?: boolean;
      checkpointMessageId?: string;
      swipeToolNames?: Set<string>;
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

      // Apply context swipe before message conversion
      const swipedMessages = applyContextSwipe(
        messages,
        options.checkpointMessageId,
        options.swipeToolNames,
        'responses_api',
        filterResponsesBlocks
      );

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
      swipedMessages.forEach(msg => {
        if (msg.role === 'user') {
          // Check if this is a tool result message (fullContent has function_call_output items)
          if (
            msg.content.modelFamily === 'responses_api' &&
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
        } else if (msg.role === 'assistant') {
          if (
            msg.content.modelFamily === 'responses_api' &&
            msg.content.fullContent &&
            Array.isArray(msg.content.fullContent)
          ) {
            // Include ALL stored items (message, function_call, reasoning, etc.)
            // Don't filter - API needs full context including encrypted reasoning
            // Cast through unknown since stored data loses SDK type info
            const storedItems = msg.content.fullContent as OpenAI.Responses.ResponseOutputItem[];
            for (const item of storedItems) {
              if ('parsed_arguments' in item) {
                delete item.parsed_arguments;
              }
              input.push(item);
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
              type: 'web_search_preview',
            },
          ]
        : [];

      // Add client-side tool definitions
      const clientToolDefs = this.getClientSideTools(
        options.enabledTools || [],
        options.toolOptions || {}
      );
      tools.push(...clientToolDefs);

      // Prepare API request parameters
      requestParams = {
        model: modelId,
        input: input,
        max_output_tokens: options.maxTokens,
        store: false, // Keep chat history in the app
      };

      // Get model metadata for reasoning configuration
      const model = await storage.getModel(apiDefinition.id, modelId);
      this.applyReasoning(requestParams, options, model);

      // Add tools if present
      if (tools.length > 0) {
        requestParams.tools = tools;
      }

      // Use streaming unless explicitly disabled
      if (!options.disableStream) {
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
    let webSearchCount = 0;

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
        if (item.type === 'web_search_call') {
          webSearchCount++;
        }
      }
    } else {
      // Check for function_call and web_search_call even when there's text content
      for (const item of response.output) {
        if (item.type === 'function_call') {
          hasFunctionCall = true;
        }
        if (item.type === 'web_search_call') {
          webSearchCount++;
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
      webSearchCount: webSearchCount > 0 ? webSearchCount : undefined,
    };
  }

  protected applyReasoning(
    requestParams: OpenAI.Responses.ResponseCreateParams,
    options: {
      temperature?: number;
      enableReasoning?: boolean;
      reasoningEffort?: ReasoningEffort;
      reasoningSummary?: 'auto' | 'concise' | 'detailed';
    },
    model?: Model
  ) {
    const effort = options.reasoningEffort;
    const summary = options.reasoningSummary;

    if (options.temperature) requestParams.temperature = options.temperature;

    // Skip reasoning if explicitly disabled or model doesn't support it
    if (options.enableReasoning === false || model?.reasoningMode === 'none') {
      return;
    }

    const supportedEfforts = model?.supportedReasoningEfforts;

    // Model with reasoning but no configurable effort (e.g., grok-4)
    if (!supportedEfforts || supportedEfforts.length === 0) {
      if (model?.reasoningMode === 'always' || model?.reasoningMode === 'optional') {
        requestParams.reasoning = { summary };
        requestParams.include = ['reasoning.encrypted_content'];
      }
      return;
    }

    // Model with configurable reasoning effort
    const mappedEffort = mapReasoningEffort(effort, supportedEfforts as ReasoningEffort[]);
    requestParams.reasoning = { effort: mappedEffort, summary };
    requestParams.include = ['reasoning.encrypted_content'];
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
   * Build tool result message in OpenAI Responses API expected format.
   * Tool results are stored as FunctionCallOutput items.
   */
  buildToolResultMessage(
    toolResults: ToolResultBlock[]
  ): Message<OpenAI.Responses.ResponseInputItem[]> {
    const functionCallOutputs: OpenAI.Responses.ResponseInputItem.FunctionCallOutput[] =
      toolResults.map(tr => ({
        type: 'function_call_output' as const,
        call_id: tr.tool_use_id,
        output: tr.content,
      }));

    return {
      id: generateUniqueId('msg_user'),
      role: 'user',
      content: {
        type: 'text',
        content: '',
        modelFamily: 'responses_api',
        fullContent: functionCallOutputs,
      },
      timestamp: new Date(),
    };
  }

  /**
   * Get client-side tool definitions for Responses API format.
   * Translates standard definitions to { type: 'function', name, description, parameters, strict: false }
   */
  protected getClientSideTools(
    enabledTools: string[],
    toolOptions: Record<string, ToolOptions> = {}
  ): OpenAI.Responses.Tool[] {
    const standardDefs = toolRegistry.getToolDefinitions(enabledTools, toolOptions);

    return standardDefs.map(def => {
      // Check for provider-specific override first
      const override = toolRegistry.getToolOverride(
        def.name,
        'responses_api',
        toolOptions[def.name] ?? {}
      );
      if (override) {
        return override as OpenAI.Responses.Tool;
      }

      // Translate standard definition to Responses API format
      return {
        type: 'function' as const,
        name: def.name,
        description: def.description,
        parameters: def.input_schema,
        strict: false,
      };
    });
  }
}
