import Anthropic from '@anthropic-ai/sdk';
import type {
  APIDefinition,
  Message,
  MessageStopReason,
  Model,
  RenderingBlockGroup,
  RenderingContentBlock,
  WebFetchRenderBlock,
  WebSearchRenderBlock,
} from '../../types';

import { APIType, groupAndConsolidateBlocks, MessageRole } from '../../types';
import { formatModelInfoForDisplay, getModelInfo } from './anthropicModelInfo';
import type { APIClient, StreamChunk, StreamResult } from './baseClient';
import {
  createMapperState,
  mapAnthropicEventToStreamChunks,
  type SSEEvent,
} from './anthropicStreamMapper';
import type { ModelInfo } from './modelInfo';
import { toolRegistry } from '../tools/clientSideTools';

export class AnthropicClient implements APIClient {
  async discoverModels(apiDefinition: APIDefinition): Promise<Model[]> {
    try {
      // Create Anthropic client with API key and custom baseUrl if provided
      const client = new Anthropic({
        dangerouslyAllowBrowser: true,
        apiKey: apiDefinition.apiKey,
        baseURL: apiDefinition.baseUrl || undefined,
      });

      // Use Anthropic's models API to get the latest available models
      const modelsResponse = await client.models.list();

      // Convert Anthropic models to our Model format
      const models: Model[] = modelsResponse.data.map(anthropicModel => ({
        id: anthropicModel.id,
        name: anthropicModel.display_name || anthropicModel.id,
        apiType: APIType.ANTHROPIC,
        contextWindow: 200000, // Use default as API doesn't expose this field
      }));

      return models;
    } catch (error: unknown) {
      console.error('Failed to discover Anthropic models:', error);

      // Fall back to hardcoded list if API call fails
      return [
        {
          id: 'claude-sonnet-4-5',
          name: 'Claude Sonnet 4.5',
          apiType: APIType.ANTHROPIC,
          contextWindow: 200000,
        },
        {
          id: 'claude-haiku-4-5',
          name: 'Claude Haiku 4.5',
          apiType: APIType.ANTHROPIC,
          contextWindow: 200000,
        },
        {
          id: 'claude-opus-4-5',
          name: 'Claude Opus 4.5',
          apiType: APIType.ANTHROPIC,
          contextWindow: 200000,
        },
      ];
    }
  }

  shouldPrependPrefill(_apiDefinition: APIDefinition): boolean {
    return true;
  }

  async *sendMessageStream(
    messages: Message<Array<Anthropic.Beta.BetaContentBlock>>[],
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
      memoryEnabled?: boolean;
    }
  ): AsyncGenerator<
    StreamChunk,
    StreamResult<Anthropic.Beta.BetaContentBlock[] | string>,
    unknown
  > {
    try {
      // Create Anthropic client with API key and custom baseUrl if provided
      const client = new Anthropic({
        dangerouslyAllowBrowser: true,
        apiKey: apiDefinition.apiKey,
        baseURL: apiDefinition.baseUrl || undefined,
      });

      // Convert our message format to Anthropic's format
      const anthropicMessages: Anthropic.Beta.BetaMessageParam[] = messages.map((msg, idx, arr) => {
        // Check if previous message contains tool_result (indicates mid-turn tool call)
        // Citations in text blocks may have invalid document_index references after tool breaks
        const prevMsg = idx > 0 ? arr[idx - 1] : null;
        const prevHasToolResult =
          prevMsg?.content.modelFamily === APIType.ANTHROPIC &&
          Array.isArray(prevMsg?.content.fullContent) &&
          prevMsg.content.fullContent.some((b: { type?: string }) => b.type === 'tool_result');

        // Use fullContent if available and from Anthropic (better caching)
        if (msg.content.modelFamily === APIType.ANTHROPIC && msg.content.fullContent) {
          // Use the stored fullContent blocks, but add cache_control dynamically
          const content = Array.isArray(msg.content.fullContent)
            ? msg.content.fullContent.map(
                (block: Anthropic.Beta.BetaContentBlock, blockIdx: number, blockArr) => {
                  // Destructure to exclude 'parsed' property (SDK adds it, but API rejects it)
                  // eslint-disable-next-line @typescript-eslint/no-unused-vars
                  const { parsed, ...blockWithoutParsed } =
                    block as Anthropic.Beta.BetaContentBlock & { parsed?: unknown };
                  // Strip 'citations' if previous message was tool_result (document indices may be invalid)
                  // See Known Issues in development.md for details
                  let cleanBlock: Anthropic.Beta.BetaContentBlockParam = blockWithoutParsed;
                  if (prevHasToolResult && 'citations' in blockWithoutParsed) {
                    // eslint-disable-next-line @typescript-eslint/no-unused-vars
                    const { citations, ...rest } =
                      blockWithoutParsed as typeof blockWithoutParsed & {
                        citations?: unknown;
                      };
                    cleanBlock = rest as Anthropic.Beta.BetaContentBlockParam;
                  }
                  // Add cache_control to last block of last 2 messages
                  if (idx >= arr.length - 2 && blockIdx === blockArr.length - 1) {
                    return {
                      ...cleanBlock,
                      cache_control: { type: 'ephemeral' } as const,
                    };
                  }
                  return cleanBlock;
                }
              )
            : [
                {
                  type: 'text' as const,
                  text: msg.content.fullContent,
                  cache_control:
                    idx >= arr.length - 2
                      ? ({
                          type: 'ephemeral',
                        } as const)
                      : undefined,
                },
              ];

          return {
            role: msg.role === MessageRole.USER ? 'user' : 'assistant',
            content,
          };
        } else {
          // Fall back to text content (cross-model compatibility)
          const contentBlocks: Array<
            Anthropic.Beta.BetaTextBlockParam | Anthropic.Beta.BetaImageBlockParam
          > = [];

          // Add image blocks if attachments present (for user messages)
          if (msg.role === MessageRole.USER && msg.attachments && msg.attachments.length > 0) {
            for (const attachment of msg.attachments) {
              contentBlocks.push({
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: attachment.mimeType,
                  data: attachment.data,
                },
              });
            }
          }

          // Add text content (only if non-empty)
          // Anthropic doesn't support cache_control on empty text blocks
          if (msg.content.content.trim()) {
            contentBlocks.push({
              type: 'text',
              text: msg.content.content,
              ...(idx >= arr.length - 2 && {
                cache_control: { type: 'ephemeral' as const },
              }),
            });
          }

          return {
            role: msg.role === MessageRole.USER ? 'user' : 'assistant',
            content: contentBlocks,
          };
        }
      });

      // Add pre-fill response if provided. Cannot pre-fill in reasoning mode.
      if (options.preFillResponse && !options.enableReasoning) {
        anthropicMessages.push({
          role: 'assistant',
          content: options.preFillResponse,
        });
      }

      // Prepare tools - always include client-side tools, optionally add web search
      const tools: Anthropic.Beta.BetaToolUnion[] = [];

      // Add web search tools if enabled
      if (options.webSearchEnabled) {
        tools.push(
          {
            type: 'web_search_20250305',
            name: 'web_search',
          },
          {
            type: 'web_fetch_20250910',
            name: 'web_fetch',
            citations: {
              enabled: true,
            },
          }
        );
      }

      // Add client-side tools (ping, etc.)
      // Exclude 'memory' tool if memoryEnabled since we use Anthropic's short-hand definition
      const clientToolDefs = toolRegistry.getToolDefinitions();
      for (const toolDef of clientToolDefs) {
        if (options.memoryEnabled && toolDef.name === 'memory') {
          continue;
        }
        tools.push({
          name: toolDef.name,
          description: toolDef.description,
          input_schema: toolDef.input_schema,
        });
      }

      // Add memory tool if enabled (special short-handed tool type)
      if (options.memoryEnabled) {
        tools.push({
          type: 'memory_20250818',
          name: 'memory',
        } as Anthropic.Beta.BetaToolUnion);
      }

      // Prepare thinking configuration if reasoning is enabled
      const thinkingConfig = options.enableReasoning
        ? ({
            type: 'enabled',
            budget_tokens: options.reasoningBudgetTokens,
          } as const)
        : undefined;

      // Build betas array - always include web-fetch and interleaved-thinking,
      // add context-management when memory is enabled
      const betas = ['web-fetch-2025-09-10', 'interleaved-thinking-2025-05-14'];
      if (options.memoryEnabled) {
        betas.push('context-management-2025-06-27');
      }

      // Create streaming request with cache_control on system prompt
      const stream = client.beta.messages.stream({
        betas,
        model: modelId,
        max_tokens: options.maxTokens,
        temperature: options.enableReasoning ? undefined : options.temperature, // Omit temperature for reasoning
        system: options.systemPrompt
          ? [
              {
                type: 'text',
                text: options.systemPrompt,
                cache_control: { type: 'ephemeral' },
              },
            ]
          : undefined,
        messages: anthropicMessages,
        ...(tools.length > 0 && { tools }),
        ...(thinkingConfig && { thinking: thinkingConfig }),
      });

      // Initialize mapper state for stateful event processing
      let mapperState = createMapperState();

      // Stream the response using anthropicStreamMapper
      for await (const chunk of stream) {
        // Convert Anthropic SDK chunk to SSEEvent format
        const sseEvent: SSEEvent = {
          event: chunk.type,
          data: chunk,
        };

        // Map event to StreamChunks using the mapper
        const result = mapAnthropicEventToStreamChunks(sseEvent, mapperState);
        mapperState = result.state;

        // Yield all resulting chunks
        for (const streamChunk of result.chunks) {
          yield streamChunk;
        }
      }

      // Wait for the stream to complete and get final usage
      const finalMessage = await stream.finalMessage();

      // Extract pure text from content blocks, prepend prefill if needed
      const textContent =
        ((this.shouldPrependPrefill(apiDefinition) &&
          !options.enableReasoning &&
          options.preFillResponse) ||
          '') +
        finalMessage.content
          .filter(block => block.type === 'text')
          .map(block => block.text)
          .join('\n\n');

      const thinkingContent =
        finalMessage.content
          .filter(block => block.type === 'thinking')
          .map(block => block.thinking)
          .join('\n\n') || undefined;

      // Prepare fullContent with prefill if needed
      let fullContent: Anthropic.Beta.BetaContentBlock[] = finalMessage.content;
      if (
        options.preFillResponse &&
        this.shouldPrependPrefill(apiDefinition) &&
        !options.enableReasoning
      ) {
        fullContent = [
          {
            type: 'text',
            text: options.preFillResponse,
            citations: null,
          },
          ...finalMessage.content,
        ];
      }

      return {
        thinkingContent,
        textContent,
        fullContent,
        stopReason: finalMessage.stop_reason ?? undefined,
        inputTokens: mapperState.inputTokens,
        outputTokens: mapperState.outputTokens,
        cacheCreationTokens: mapperState.cacheCreationTokens,
        cacheReadTokens: mapperState.cacheReadTokens,
      };
    } catch (error: unknown) {
      // Handle errors and yield error chunk
      let errorMessage = '';
      let errorStatus = undefined;
      let errorStack = undefined;

      if (error && typeof error === 'object') {
        if ('status' in error) {
          errorStatus = Number(error.status);

          if (error.status === 401) {
            errorMessage = 'Invalid API key. Please check your Anthropic API key in settings.';
          } else if (error.status === 429) {
            errorMessage = 'Rate limit exceeded. Please try again later.';
          } else if (error.status === 500 || error.status === 502 || error.status === 503) {
            errorMessage = 'Anthropic API is currently unavailable. Please try again later.';
          }
        }

        if ('message' in error) {
          errorMessage += error.message;
        }

        if (error instanceof Error) {
          errorStack = error.stack;
        }
      }

      // Return empty message on error
      return {
        textContent: '',
        fullContent: [],
        error: {
          message: errorMessage,
          status: errorStatus,
          stack: errorStack,
        },
        inputTokens: 0,
        outputTokens: 0,
      };
    }
  }

  calculateCost(
    modelId: string,
    inputTokens: number,
    outputTokens: number,
    _reasoningTokens?: number,
    cacheCreationTokens?: number,
    cacheReadTokens?: number
  ): number {
    // Get model info with pricing data
    const modelInfo = getModelInfo(modelId);

    let cost = (inputTokens / 1_000_000) * modelInfo.inputPrice;
    cost += (outputTokens / 1_000_000) * modelInfo.outputPrice;

    // Add cache token costs
    if (cacheCreationTokens && modelInfo.cacheWritePrice) {
      cost += (cacheCreationTokens / 1_000_000) * modelInfo.cacheWritePrice;
    }
    if (cacheReadTokens) {
      cost += (cacheReadTokens / 1_000_000) * modelInfo.cacheReadPrice;
    }

    return cost;
  }

  getModelInfo(modelId: string): ModelInfo {
    return getModelInfo(modelId);
  }

  formatModelInfoForDisplay(info: ModelInfo): string {
    return formatModelInfoForDisplay(info);
  }

  isReasoningModel(_modelId: string): boolean {
    // Anthropic doesn't have dedicated reasoning models like OpenAI o-series
    return false;
  }

  migrateMessageRendering(
    fullContent: unknown,
    stopReason: string | null
  ): {
    renderingContent: RenderingBlockGroup[];
    stopReason: MessageStopReason;
  } {
    const blocks: RenderingContentBlock[] = [];

    // Handle non-array content (legacy text-only)
    if (!Array.isArray(fullContent)) {
      if (typeof fullContent === 'string' && fullContent.trim()) {
        blocks.push({ type: 'text', text: fullContent });
      }
      return {
        renderingContent: groupAndConsolidateBlocks(blocks),
        stopReason: this.mapStopReason(stopReason),
      };
    }

    // Use Map-based tracking like StreamingContentAssembler for robust toolUseId mapping
    const webSearchMap = new Map<string, WebSearchRenderBlock>();
    const webFetchMap = new Map<
      string,
      {
        url: string;
        title?: string;
      }
    >();

    for (const block of fullContent as Array<Record<string, unknown>>) {
      const blockType = block.type as string;

      switch (blockType) {
        case 'thinking':
          if (typeof block.thinking === 'string' && block.thinking.trim()) {
            blocks.push({ type: 'thinking', thinking: block.thinking });
          }
          break;

        case 'text': {
          // Process text with citations
          const text = block.text as string | undefined;
          const citations = block.citations as
            | Array<{
                type: string;
                url?: string;
                title?: string;
                cited_text?: string;
              }>
            | undefined;

          if (typeof text === 'string' && text.trim()) {
            // If citations present, render them as <a> tags
            const processedText = this.renderCitations(text, citations);
            blocks.push({ type: 'text', text: processedText });
          }
          break;
        }

        case 'server_tool_use': {
          const toolId = (block.id as string) || `ws_${Date.now()}`;
          const toolName = block.name as string | undefined;
          const input = block.input as Record<string, unknown> | undefined;

          if (toolName === 'web_search' && input?.query) {
            // Create mutable web search block and add to blocks immediately
            const searchBlock: WebSearchRenderBlock = {
              type: 'web_search',
              id: toolId,
              query: input.query as string,
              results: [],
            };
            blocks.push(searchBlock);
            webSearchMap.set(toolId, searchBlock);
          } else if (toolName === 'web_fetch' && input?.url) {
            const fetchBlock: WebFetchRenderBlock = {
              type: 'web_fetch',
              url: input.url as string,
            };
            blocks.push(fetchBlock);
            webFetchMap.set(toolId, fetchBlock);
          }
          break;
        }

        case 'web_search_tool_result': {
          // Extract results and associate with web search using toolUseId
          const toolUseId = block.tool_use_id as string | undefined;
          const content = block.content as Array<Record<string, unknown>> | undefined;

          if (content && Array.isArray(content)) {
            let targetWebSearch: WebSearchRenderBlock | undefined;

            if (toolUseId) {
              // Try to find by explicit toolUseId first
              targetWebSearch = webSearchMap.get(toolUseId);
            } else {
              // Fall back to most recent web search (sequential processing)
              const searches = Array.from(webSearchMap.values());
              targetWebSearch = searches[searches.length - 1];
            }

            // Simply mutate the existing block's results array
            if (targetWebSearch) {
              for (const result of content) {
                if (result.type === 'web_search_result') {
                  const title = result.title as string | undefined;
                  const url = result.url as string | undefined;
                  if (title && url) {
                    targetWebSearch.results.push({ title, url });
                  }
                }
              }
              // No need to add to blocks or remove from map - the mutable block is already in blocks
            }
          }
          break;
        }

        case 'web_fetch_tool_result': {
          // Extract result and associate with web fetch using toolUseId
          const toolUseId = block.tool_use_id as string | undefined;
          const content = block.content as Record<string, unknown> | undefined;

          if (content && toolUseId && content.type === 'web_fetch_result') {
            const targetWebFetch = webFetchMap.get(toolUseId);
            if (targetWebFetch) {
              // Update the existing web_fetch block with final URL and title
              const url = content.url as string | undefined;
              const title = content.title as string | undefined;
              if (url) {
                targetWebFetch.url = url;
              }
              if (title) {
                targetWebFetch.title = title;
              }
            }
          }
          break;
        }

        // Skip these block types - they don't contribute to rendering
        case 'tool_use':
        case 'tool_result':
          break;

        default:
          // Unknown block types are silently ignored
          break;
      }
    }

    return {
      renderingContent: groupAndConsolidateBlocks(blocks),
      stopReason: this.mapStopReason(stopReason),
    };
  }

  /**
   * Render Anthropic citations as inline <a> tags.
   */
  private renderCitations(
    text: string,
    citations?: Array<{
      type: string;
      url?: string;
      title?: string;
      cited_text?: string;
    }>
  ): string {
    if (!citations || citations.length === 0) {
      return text;
    }

    // Build citation link after the text
    // Format: text<a href="..." title="Source Title" class="citation-link">src</a>
    const citationLinks = citations
      .filter(c => c.type === 'web_search_result_location' && c.url)
      .map(c => {
        const href = this.escapeHtmlAttr(c.url || '');
        const title = this.escapeHtmlAttr(c.title || '');
        const cited = this.escapeHtmlAttr(c.cited_text || '');
        return `<a href="${href}" target="_blank" rel="noopener noreferrer" title="${title}" data-cited="${cited}" class="citation-link">src</a>`;
      });

    if (citationLinks.length === 0) {
      return text;
    }

    // Append citation links after the text (separated by space if text doesn't end with space)
    const needsSpace = text.length > 0 && !/\s$/.test(text);
    return text + (needsSpace ? '' : '') + citationLinks.join(', ');
  }

  /**
   * Escape HTML attribute value, including markdown/math special characters.
   * Uses HTML entities to prevent markdown parser from interpreting them.
   */
  private escapeHtmlAttr(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\$/g, '&#36;')
      .replace(/\*/g, '&#42;')
      .replace(/_/g, '&#95;')
      .replace(/`/g, '&#96;')
      .replace(/\[/g, '&#91;')
      .replace(/\]/g, '&#93;');
  }

  /**
   * Map Anthropic stop_reason to MessageStopReason.
   */
  private mapStopReason(stopReason: string | null): MessageStopReason {
    if (!stopReason) {
      return 'end_turn';
    }
    // Anthropic uses: end_turn, max_tokens, stop_sequence, tool_use
    switch (stopReason) {
      case 'end_turn':
      case 'max_tokens':
      case 'stop_sequence':
        return stopReason;
      case 'tool_use':
        // Tool use is treated as normal end for rendering purposes
        return 'end_turn';
      default:
        return stopReason;
    }
  }
}
