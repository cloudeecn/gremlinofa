import Anthropic from '@anthropic-ai/sdk';
import { AnthropicBedrock } from '@anthropic-ai/bedrock-sdk';
import {
  BedrockClient as BedrockControlPlaneClient,
  ListFoundationModelsCommand,
  ListInferenceProfilesCommand,
  type FoundationModelSummary,
} from '@aws-sdk/client-bedrock';
import type {
  APIDefinition,
  Message,
  MessageStopReason,
  Model,
  RenderingBlockGroup,
  RenderingContentBlock,
  ToolResultBlock,
  ToolUseBlock,
  WebFetchRenderBlock,
  WebSearchRenderBlock,
  ToolOptions,
} from '../../types';

import { groupAndConsolidateBlocks } from '../../types';
import { generateUniqueId } from '../../utils/idGenerator';
import type { APIClient, StreamChunk, StreamResult } from './baseClient';
import {
  createMapperState,
  mapAnthropicEventToStreamChunks,
  type SSEEvent,
} from './anthropicStreamMapper';
import { toolRegistry } from '../tools/clientSideTools';
import { applyContextSwipe, type FilterBlocksFn } from './contextSwipe';
import { getModelMetadataFor } from './modelMetadata';

/**
 * Add cache_control breakpoints to the last 2 eligible messages (walking backwards).
 * Skips thinking/redacted_thinking blocks (they don't support cache_control in the SDK).
 * Skips messages that already have a block with cache_control.
 */
export function applyCacheBreakpoints(messages: Anthropic.Beta.BetaMessageParam[]): void {
  let placed = 0;
  for (let i = messages.length - 1; i >= 0 && placed < 2; i--) {
    const content = messages[i].content;
    if (typeof content === 'string' || !Array.isArray(content)) continue;

    // Skip if any block already has cache_control
    if (content.some(b => typeof b === 'object' && 'cache_control' in b && b.cache_control))
      continue;

    // Find last non-thinking, non-empty block
    let targetIdx = -1;
    for (let j = content.length - 1; j >= 0; j--) {
      const block = content[j] as { type: string; text?: string };
      if (block.type === 'thinking' || block.type === 'redacted_thinking') continue;
      if (block.type === 'text' && !block.text?.trim()) continue;
      targetIdx = j;
      break;
    }
    if (targetIdx === -1) continue;

    content[targetIdx] = {
      ...(content[targetIdx] as unknown as Record<string, unknown>),
      cache_control: { type: 'ephemeral' as const },
    } as (typeof content)[number];
    placed++;
  }
}

/**
 * Parse baseUrl to detect Bedrock endpoints.
 * Supports shorthand format "bedrock:us-east-2" and full URL.
 */
function parseBedrockEndpoint(baseUrl: string | undefined): {
  isBedrock: boolean;
  region: string;
  url: string | undefined;
} {
  if (!baseUrl) {
    return { isBedrock: false, region: 'us-east-1', url: undefined };
  }

  // Shorthand format: "bedrock:us-east-2" - SDK auto-generates URL from region
  const shorthandMatch = baseUrl.match(/^bedrock:([a-z0-9-]+)$/i);
  if (shorthandMatch) {
    return {
      isBedrock: true,
      region: shorthandMatch[1],
      url: undefined, // Let SDK generate URL
    };
  }

  // Full URL format: "https://bedrock-runtime.us-east-2.amazonaws.com"
  const urlMatch = baseUrl.match(/bedrock-runtime\.([a-z0-9-]+)\.amazonaws\.com/i);
  if (urlMatch) {
    return {
      isBedrock: true,
      region: urlMatch[1],
      url: baseUrl,
    };
  }

  return { isBedrock: false, region: 'us-east-1', url: baseUrl };
}

/**
 * Build the betas array for Anthropic API requests.
 */
export function buildAnthropicBetas(options: {
  webSearchEnabled?: boolean;
  enabledTools?: string[];
  thinkingKeepTurns?: number;
  extendedContext?: boolean;
}): string[] {
  const betas: string[] = ['interleaved-thinking-2025-05-14'];
  if (options.webSearchEnabled) {
    betas.push('web-fetch-2025-09-10');
  }
  const enabledTools = options.enabledTools || [];
  const needsContextManagement =
    enabledTools.includes('memory') || options.thinkingKeepTurns !== undefined;
  if (needsContextManagement) {
    betas.push('context-management-2025-06-27');
  }
  if (options.extendedContext) {
    betas.push('context-1m-2025-08-07');
  }
  return betas;
}

/**
 * Anthropic-specific block filter for context swipe.
 *
 * Assistant messages: removes thinking/redacted_thinking always,
 * removes tool_use by name (collects IDs), keeps text/server_tool_use.
 * User messages: removes tool_result by collected ID,
 * keeps web_search_tool_result/web_fetch_tool_result.
 */
const filterAnthropicBlocks: FilterBlocksFn = (
  fullContent,
  removedToolNames,
  isCheckpoint,
  removedToolUseIds
) => {
  if (!Array.isArray(fullContent)) return { filtered: fullContent, newRemovedIds: [] };

  const filtered: unknown[] = [];
  const newRemovedIds: string[] = [];

  for (const block of fullContent) {
    const b = block as { type?: string; id?: string; name?: string; tool_use_id?: string };

    // Always remove thinking blocks (even on checkpoint message)
    if (b.type === 'thinking' || b.type === 'redacted_thinking') continue;

    // Checkpoint message: only thinking removed, everything else preserved
    if (isCheckpoint) {
      filtered.push(block);
      continue;
    }

    // tool_use — remove if name matches, collect ID
    if (b.type === 'tool_use' && b.name && removedToolNames.has(b.name)) {
      if (b.id) newRemovedIds.push(b.id);
      continue;
    }

    // tool_result — remove if matching a removed tool_use ID
    if (b.type === 'tool_result' && b.tool_use_id && removedToolUseIds.has(b.tool_use_id)) {
      continue;
    }

    // Keep everything else (text, server_tool_use, web_search_tool_result, web_fetch_tool_result)
    filtered.push(block);
  }

  return { filtered, newRemovedIds };
};

export class AnthropicClient implements APIClient {
  async discoverModels(apiDefinition: APIDefinition): Promise<Model[]> {
    const bedrockInfo = parseBedrockEndpoint(apiDefinition.baseUrl);

    // Use AWS SDK for Bedrock model discovery
    if (bedrockInfo.isBedrock) {
      try {
        const controlPlaneClient = new BedrockControlPlaneClient({
          region: bedrockInfo.region,
          ...(apiDefinition.apiKey && {
            token: { token: apiDefinition.apiKey },
            authSchemePreference: ['httpBearerAuth'],
          }),
          ...(bedrockInfo.url && {
            endpoint: bedrockInfo.url.replace('bedrock-runtime', 'bedrock'),
          }),
        });

        // Fetch foundation models and inference profiles in parallel
        const [modelsResponse, profilesResponse] = await Promise.all([
          controlPlaneClient.send(
            new ListFoundationModelsCommand({
              byProvider: 'Anthropic',
              byOutputModality: 'TEXT',
            })
          ),
          controlPlaneClient.send(new ListInferenceProfilesCommand({})),
        ]);

        console.debug(
          `[AnthropicClient] Bedrock foundation models for ${apiDefinition.name}:`,
          modelsResponse
        );
        console.debug(
          `[AnthropicClient] Bedrock inference profiles for ${apiDefinition.name}:`,
          profilesResponse
        );

        // Build modelArn � model lookup from foundation models
        const arnToModel = new Map<string, FoundationModelSummary>();
        const models: Model[] = [];

        for (const m of modelsResponse.modelSummaries ?? []) {
          if (m.modelId && m.modelArn && m.modelLifecycle?.status !== 'LEGACY') {
            arnToModel.set(m.modelArn, m);
            // Add on-demand foundation models directly
            if (m.inferenceTypesSupported?.includes('ON_DEMAND')) {
              models.push({
                ...getModelMetadataFor(apiDefinition, m.modelId),
                id: m.modelId,
                name: `${m.providerName} ${m.modelName || m.modelId}`,
                baseModelId: m.modelId,
              });
            }
          }
        }

        // Add inference profiles (most models require these)
        for (const profile of profilesResponse.inferenceProfileSummaries ?? []) {
          if (!profile.inferenceProfileId || profile.status !== 'ACTIVE') continue;

          for (const profileModel of profile.models ?? []) {
            const baseModel = arnToModel.get(profileModel.modelArn ?? '');
            if (baseModel && baseModel.modelId) {
              models.push({
                ...getModelMetadataFor(apiDefinition, baseModel.modelId),
                id: profile.inferenceProfileId,
                name: profile.inferenceProfileName || profile.inferenceProfileId,
                baseModelId: baseModel.modelId,
              });
            }
          }
        }

        // Sort by base model ID first, then by full ID
        models.sort((a, b) => {
          const baseA = a.baseModelId ?? a.id;
          const baseB = b.baseModelId ?? b.id;
          const baseCompare = baseA.localeCompare(baseB);
          if (baseCompare !== 0) return baseCompare;
          return a.id.localeCompare(b.id);
        });

        console.debug(
          `[AnthropicClient] Discovered ${models.length} Bedrock models for ${apiDefinition.name}`
        );
        return models;
      } catch (error) {
        console.warn('[AnthropicClient] Failed to discover Bedrock models:', error);
        return [];
      }
    }

    // Create Anthropic client with API key and custom baseUrl if provided
    const client = new Anthropic({
      dangerouslyAllowBrowser: true,
      apiKey: apiDefinition.apiKey,
      baseURL: bedrockInfo.url,
    });

    // Use Anthropic's models API to get the latest available models
    const modelsResponse = await client.models.list();
    console.debug(`Models for ${apiDefinition.name}:`, modelsResponse);

    // Convert Anthropic models to our Model format
    const models: Model[] = modelsResponse.data.map(anthropicModel => ({
      ...getModelMetadataFor(apiDefinition, anthropicModel.id),
      name: anthropicModel.display_name || anthropicModel.id,
    }));
    console.debug(`Argumented models for ${apiDefinition.name}:`, models);
    return models;
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
      thinkingKeepTurns?: number; // undefined = model default, -1 = all, 0+ = thinking_turns
      reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
      reasoningSummary?: 'auto' | 'concise' | 'detailed';
      systemPrompt?: string;
      preFillResponse?: string;
      webSearchEnabled?: boolean;
      enabledTools?: string[];
      toolOptions?: Record<string, ToolOptions>;
      extendedContext?: boolean;
      checkpointMessageId?: string;
      swipeToolNames?: Set<string>;
    }
  ): AsyncGenerator<
    StreamChunk,
    StreamResult<Anthropic.Beta.BetaContentBlock[] | string>,
    unknown
  > {
    try {
      const bedrockInfo = parseBedrockEndpoint(apiDefinition.baseUrl);

      // Create appropriate client based on endpoint type
      const client: Anthropic | AnthropicBedrock = bedrockInfo.isBedrock
        ? new AnthropicBedrock({
            dangerouslyAllowBrowser: true,
            awsRegion: bedrockInfo.region,
            ...(bedrockInfo.url && { baseURL: bedrockInfo.url }),
            skipAuth: true, // Skip AWS SigV4 signing
            defaultHeaders: {
              Authorization: `Bearer ${apiDefinition.apiKey}`,
            },
          })
        : new Anthropic({
            dangerouslyAllowBrowser: true,
            apiKey: apiDefinition.apiKey,
            baseURL: bedrockInfo.url,
          });

      // Apply context swipe before message conversion
      const swipedMessages = applyContextSwipe(
        messages,
        options.checkpointMessageId,
        options.swipeToolNames,
        'anthropic',
        filterAnthropicBlocks
      ) as typeof messages;

      // Convert our message format to Anthropic's format
      const anthropicMessages: Anthropic.Beta.BetaMessageParam[] = swipedMessages.map(
        (msg, idx, arr) => {
          // Check if previous message contains tool_result (indicates mid-turn tool call)
          // Citations in text blocks may have invalid document_index references after tool breaks
          const prevMsg = idx > 0 ? arr[idx - 1] : null;
          const prevHasToolResult =
            prevMsg?.content.modelFamily === 'anthropic' &&
            Array.isArray(prevMsg?.content.fullContent) &&
            prevMsg.content.fullContent.some((b: { type?: string }) => b.type === 'tool_result');

          // Use fullContent if available and from Anthropic (better caching)
          if (msg.content.modelFamily === 'anthropic' && msg.content.fullContent) {
            // Use the stored fullContent blocks, but add cache_control dynamically
            const content = Array.isArray(msg.content.fullContent)
              ? msg.content.fullContent.map((block: Anthropic.Beta.BetaContentBlock) => {
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
                  // Replace empty text blocks with a space (API rejects empty text)
                  if (
                    cleanBlock.type === 'text' &&
                    !(cleanBlock as { text?: string }).text?.trim()
                  ) {
                    return { ...cleanBlock, text: ' ' };
                  }
                  return cleanBlock;
                })
              : [
                  {
                    type: 'text' as const,
                    text: msg.content.fullContent,
                  },
                ];

            return {
              role: msg.role === 'user' ? 'user' : 'assistant',
              content,
            };
          } else {
            // Fall back to text content (cross-model compatibility)
            const contentBlocks: Array<
              Anthropic.Beta.BetaTextBlockParam | Anthropic.Beta.BetaImageBlockParam
            > = [];

            // Add image blocks if attachments present (for user messages)
            if (msg.role === 'user' && msg.attachments && msg.attachments.length > 0) {
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
            if (msg.content.content.trim()) {
              contentBlocks.push({
                type: 'text',
                text: msg.content.content,
              });
            }

            return {
              role: msg.role === 'user' ? 'user' : 'assistant',
              content: contentBlocks,
            };
          }
        }
      );

      // Add cache breakpoints to last 2 eligible messages (before pre-fill)
      applyCacheBreakpoints(anthropicMessages);

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

      // Get client-side tool definitions and translate to Anthropic format
      const enabledTools = options.enabledTools || [];
      const toolOpts = options.toolOptions || {};
      const standardDefs = toolRegistry.getToolDefinitions(enabledTools, toolOpts);

      for (const def of standardDefs) {
        // Check for provider-specific override first
        const override = toolRegistry.getToolOverride(
          def.name,
          'anthropic',
          toolOpts[def.name] ?? {}
        );
        if (override) {
          tools.push(override as Anthropic.Beta.BetaToolUnion);
        } else {
          // Standard definition already matches Anthropic format
          tools.push({
            name: def.name,
            description: def.description,
            input_schema: def.input_schema,
          });
        }
      }

      // Prepare thinking configuration if reasoning is enabled
      const thinkingConfig = options.enableReasoning
        ? ({
            type: 'enabled',
            budget_tokens: options.reasoningBudgetTokens,
          } as const)
        : undefined;

      // Auto-adjust maxTokens if reasoning is enabled and maxTokens <= reasoningBudgetTokens
      // Anthropic requires max_tokens > budget_tokens for reasoning to work
      let effectiveMaxTokens = options.maxTokens;
      if (options.enableReasoning && options.maxTokens <= options.reasoningBudgetTokens) {
        effectiveMaxTokens = options.reasoningBudgetTokens + 500;
      }

      const betas = buildAnthropicBetas({
        webSearchEnabled: options.webSearchEnabled,
        enabledTools,
        thinkingKeepTurns: options.thinkingKeepTurns,
        extendedContext: options.extendedContext,
      });

      // Build context_management config if thinkingKeepTurns is set
      let contextManagement: Anthropic.Beta.BetaContextManagementConfig | undefined;
      if (options.thinkingKeepTurns !== undefined) {
        const keepValue:
          | Anthropic.Beta.BetaThinkingTurns
          | Anthropic.Beta.BetaAllThinkingTurns
          | 'all' =
          options.thinkingKeepTurns === -1
            ? 'all'
            : { type: 'thinking_turns' as const, value: options.thinkingKeepTurns };
        contextManagement = {
          edits: [
            {
              type: 'clear_thinking_20251015',
              keep: keepValue,
            },
          ],
        };
      }

      // Create streaming request with cache_control on system prompt
      const stream = client.beta.messages.stream({
        betas,
        model: modelId,
        max_tokens: effectiveMaxTokens,
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
        ...(contextManagement && { context_management: contextManagement }),
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

      // Use finalMessage.usage from SDK (more authoritative than mapper state)
      const usage = finalMessage.usage;
      return {
        thinkingContent,
        textContent,
        fullContent,
        stopReason: finalMessage.stop_reason ?? undefined,
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        cacheCreationTokens: usage.cache_creation_input_tokens ?? undefined,
        cacheReadTokens: usage.cache_read_input_tokens ?? undefined,
        webSearchCount: usage.server_tool_use?.web_search_requests ?? undefined,
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

  /**
   * Extract tool_use blocks from Anthropic fullContent.
   * Includes all tool_use blocks - unknown tools will receive error responses.
   */
  extractToolUseBlocks(fullContent: unknown): ToolUseBlock[] {
    if (!Array.isArray(fullContent)) return [];

    return fullContent
      .filter((block: Record<string, unknown>) => block.type === 'tool_use')
      .map((block: Record<string, unknown>) => ({
        type: 'tool_use' as const,
        id: block.id as string,
        name: block.name as string,
        input: (block.input as Record<string, unknown>) || {},
      }));
  }

  /**
   * Build tool result message in Anthropic's expected format.
   * Anthropic expects tool_result blocks in user role.
   */
  buildToolResultMessage(toolResults: ToolResultBlock[]): Message<unknown> {
    return {
      id: generateUniqueId('msg_user'),
      role: 'user',
      content: {
        type: 'text',
        content: '',
        modelFamily: 'anthropic',
        fullContent: toolResults,
        // renderingContent will be set by caller
      },
      timestamp: new Date(),
    };
  }
}
