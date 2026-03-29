import Anthropic from '@anthropic-ai/sdk';
import { getProxyConfig } from './proxyConfig';
import { AnthropicBedrock } from '@anthropic-ai/bedrock-sdk';
import {
  BedrockClient as BedrockControlPlaneClient,
  ListFoundationModelsCommand,
  ListInferenceProfilesCommand,
  type FoundationModelSummary,
} from '@aws-sdk/client-bedrock';
import type { APIDefinition, Message, Model, ToolUseBlock, ToolOptions } from '../../types';
import type { APIClient, StreamChunk, StreamResult } from './baseClient';
import { effectiveInjectionMode } from './fileInjectionHelper';
import {
  createMapperState,
  mapAnthropicEventToStreamChunks,
  type SSEEvent,
} from './anthropicStreamMapper';
import { toolRegistry } from '../tools/clientSideTools';
import { findCheckpointIndex, findThinkingBoundary, tidyAgnosticMessage } from './contextTidy';
import { getModelMetadataFor } from './modelMetadata';

/**
 * Place cache_control on the last eligible block of a single message.
 * Skips thinking/redacted_thinking and empty text blocks.
 * Returns false (no-op) if the message already has cache_control or has no eligible block.
 */
export function placeCacheControlOnMessage(message: Anthropic.Beta.BetaMessageParam): boolean {
  const content = message.content;
  if (typeof content === 'string' || !Array.isArray(content)) return false;

  if (content.some(b => typeof b === 'object' && 'cache_control' in b && b.cache_control))
    return false;

  for (let j = content.length - 1; j >= 0; j--) {
    const block = content[j] as { type: string; text?: string };
    if (block.type === 'thinking' || block.type === 'redacted_thinking') continue;
    if (block.type === 'text' && !block.text?.trim()) continue;
    content[j] = {
      ...(content[j] as unknown as Record<string, unknown>),
      cache_control: { type: 'ephemeral' as const },
    } as (typeof content)[number];
    return true;
  }
  return false;
}

/**
 * Add a cache_control breakpoint to the last eligible message (walking backwards).
 * Skips messages that already have cache_control (e.g. from a checkpoint anchor).
 * One breakpoint is enough — Anthropic looks back ~30 messages from any breakpoint.
 * @param startIdx - Don't place breakpoints before this index (keeps stable prefix clean)
 */
export function applyCacheBreakpoints(
  messages: Anthropic.Beta.BetaMessageParam[],
  startIdx = 0
): void {
  for (let i = messages.length - 1; i >= startIdx; i--) {
    if (placeCacheControlOnMessage(messages[i])) return;
  }
}

/**
 * Validate that an API response genuinely came from Anthropic.
 * Checks cache activity (Anthropic always honors cache_control blocks) and
 * thinking block signatures (Anthropic cryptographically signs thinking output).
 */
export function validateAnthropicResponse(
  usage: {
    input_tokens: number;
    cache_creation_input_tokens?: number | null;
    cache_read_input_tokens?: number | null;
  },
  content: Array<{ type: string; signature?: string }>
): void {
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  if (usage.input_tokens > 4096 && cacheWrite === 0 && cacheRead === 0) {
    throw new Error(
      'Cache enforcement failed: sent cache_control blocks but response reported zero cache activity. ' +
        'Your API provider is likely not routing to Anthropic. ' +
        'Disable "Enforce genuine Anthropic" in advanced settings if intentional.'
    );
  }

  const thinkingBlocks = content.filter(b => b.type === 'thinking');
  if (thinkingBlocks.length > 0) {
    const allSigned = thinkingBlocks.every(
      b => typeof b.signature === 'string' && b.signature.length > 0
    );
    if (!allSigned) {
      throw new Error(
        'Thinking signature check failed: thinking blocks are missing cryptographic signatures. ' +
          'Your API provider is likely not routing to Anthropic. ' +
          'Disable "Enforce genuine Anthropic" in advanced settings if intentional.'
      );
    }
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
 * Combined message tidy: checkpoint filtering, thinking pruning, empty text removal.
 * Single forward pass with direct access to Anthropic block types.
 */
function tidyMessages(
  messages: Message<unknown>[],
  checkpointMessageId: string | undefined,
  tidyToolNames: Set<string> | undefined,
  pruneThinking: boolean,
  pruneEmptyText: boolean
): Message<unknown>[] {
  const checkpointIdx = findCheckpointIndex(messages, checkpointMessageId);
  const thinkingBoundary = pruneThinking || pruneEmptyText ? findThinkingBoundary(messages) : -1;

  if (checkpointIdx === -1 && thinkingBoundary <= 0) return messages;

  const toolNames = tidyToolNames ?? new Set<string>();
  const removedToolUseIds = new Set<string>();
  const processUntil = Math.max(checkpointIdx, thinkingBoundary - 1);
  const result: Message<unknown>[] = [];

  for (let i = 0; i <= processUntil; i++) {
    const msg = messages[i];
    const inCheckpoint = checkpointIdx >= 0 && i <= checkpointIdx;
    const isCheckpoint = inCheckpoint && i === checkpointIdx;
    const inThinking = thinkingBoundary > 0 && i < thinkingBoundary;

    // Wrong modelFamily or missing fullContent — model-agnostic path
    if (msg.content.modelFamily !== 'anthropic' || msg.content.fullContent == null) {
      if (inCheckpoint && !isCheckpoint) {
        const { message, newRemovedIds } = tidyAgnosticMessage(
          msg,
          toolNames,
          removedToolUseIds,
          false
        );
        for (const id of newRemovedIds) removedToolUseIds.add(id);
        if (message) result.push(message);
      } else if (inThinking) {
        const hasText = msg.content.content.trim().length > 0;
        const hasTools =
          (msg.content.toolCalls?.length ?? 0) + (msg.content.toolResults?.length ?? 0) > 0;
        if (hasText || hasTools) result.push(msg);
      } else {
        result.push(msg);
      }
      continue;
    }

    // Own modelFamily with fullContent — provider-specific filtering
    let blocks = msg.content.fullContent as {
      type?: string;
      id?: string;
      name?: string;
      tool_use_id?: string;
      text?: string;
    }[];

    if (inCheckpoint) {
      const filtered: typeof blocks = [];
      for (const b of blocks) {
        if (b.type === 'thinking' || b.type === 'redacted_thinking') continue;
        if (isCheckpoint) {
          filtered.push(b);
          continue;
        }
        if (b.type === 'tool_use' && b.name && toolNames.has(b.name)) {
          if (b.id) removedToolUseIds.add(b.id);
          continue;
        }
        if (b.type === 'tool_result' && b.tool_use_id && removedToolUseIds.has(b.tool_use_id)) {
          continue;
        }
        filtered.push(b);
      }
      blocks = filtered;
    }

    if (inThinking && !inCheckpoint && pruneThinking) {
      blocks = blocks.filter(b => b.type !== 'thinking' && b.type !== 'redacted_thinking');
    }

    if (inThinking && pruneEmptyText) {
      blocks = blocks.filter(b => b.type !== 'text' || (b.text?.trim()?.length ?? 0) > 0);
    }

    if (blocks.length === 0) continue;
    if (blocks !== (msg.content.fullContent as typeof blocks)) {
      result.push({ ...msg, content: { ...msg.content, fullContent: blocks } });
    } else {
      result.push(msg);
    }
  }

  for (let i = processUntil + 1; i < messages.length; i++) {
    result.push(messages[i]);
  }

  return result;
}

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

    const proxy = getProxyConfig(apiDefinition);
    const client = new Anthropic({
      dangerouslyAllowBrowser: true,
      apiKey: apiDefinition.apiKey,
      baseURL: proxy?.baseURL ?? bedrockInfo.url,
      ...(proxy && { defaultHeaders: proxy.headers }),
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
      tidyToolNames?: Set<string>;
    }
  ): AsyncGenerator<
    StreamChunk,
    StreamResult<Anthropic.Beta.BetaContentBlock[] | string>,
    unknown
  > {
    try {
      const bedrockInfo = parseBedrockEndpoint(apiDefinition.baseUrl);

      // Create appropriate client based on endpoint type
      const proxy = bedrockInfo.isBedrock ? null : getProxyConfig(apiDefinition);
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
            baseURL: proxy?.baseURL ?? bedrockInfo.url,
            ...(proxy && { defaultHeaders: proxy.headers }),
          });

      // Tidy messages: checkpoint filtering, thinking pruning, empty text removal
      const tidiedMessages = tidyMessages(
        messages,
        options.checkpointMessageId,
        options.tidyToolNames,
        apiDefinition.advancedSettings?.pruneThinking ?? false,
        apiDefinition.advancedSettings?.pruneEmptyText ?? false
      ) as typeof messages;

      // Convert our message format to Anthropic's format
      const anthropicMessages: Anthropic.Beta.BetaMessageParam[] = tidiedMessages.map(
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
            // Cross-model reconstruction: use toolCalls/toolResults if available
            if (msg.role === 'assistant' && msg.content.toolCalls?.length) {
              const contentBlocks: Anthropic.Beta.BetaContentBlockParam[] = [];
              if (msg.content.content.trim()) {
                contentBlocks.push({ type: 'text', text: msg.content.content });
              }
              for (const tc of msg.content.toolCalls) {
                contentBlocks.push({
                  type: 'tool_use',
                  id: tc.id,
                  name: tc.name,
                  input: tc.input,
                });
              }
              return { role: 'assistant' as const, content: contentBlocks };
            }

            if (msg.role === 'user' && msg.content.toolResults?.length) {
              return {
                role: 'user' as const,
                content: msg.content.toolResults.map(tr => ({
                  type: 'tool_result' as const,
                  tool_use_id: tr.tool_use_id,
                  content: tr.content,
                  is_error: tr.is_error,
                })),
              };
            }

            // Fall back to text content
            const contentBlocks: Anthropic.Beta.BetaContentBlockParam[] = [];

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

            // Add injected file blocks based on injection mode
            if (msg.content.injectedFiles?.length && msg.content.injectionMode) {
              const mode = effectiveInjectionMode(msg.content.injectionMode, 'anthropic');
              if (mode === 'as-file') {
                for (const file of msg.content.injectedFiles) {
                  contentBlocks.push({
                    type: 'document',
                    source: {
                      type: 'text',
                      data: file.content,
                      media_type: 'text/plain',
                    },
                    title: file.path,
                  } as Anthropic.Beta.BetaContentBlockParam);
                }
              } else if (mode === 'separate-block') {
                for (const file of msg.content.injectedFiles) {
                  contentBlocks.push({
                    type: 'text',
                    text: `=== ${file.path} ===\n${file.content}`,
                  });
                }
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

      // Stable cache anchor at the last fully-tidied message (one before the tidy
      // boundary checkpoint). In long agentic loops the boundary drifts far from
      // the tail; without an explicit breakpoint the auto-cached window won't reach
      // the stable prefix. Sliding breakpoints are restricted to AFTER the anchor
      // so cache_control markers in the stable prefix stay fixed across calls.
      let anchorEndIdx = 0;
      if (options.checkpointMessageId) {
        const boundaryIdx = tidiedMessages.findIndex(m => m.id === options.checkpointMessageId);
        const anchorIdx = boundaryIdx - 1;
        if (anchorIdx >= 0 && anchorIdx < anthropicMessages.length) {
          if (placeCacheControlOnMessage(anthropicMessages[anchorIdx])) {
            anchorEndIdx = anchorIdx + 1;
          }
        }
      }

      // Add cache breakpoint to last eligible message (before pre-fill)
      applyCacheBreakpoints(anthropicMessages, anchorEndIdx);

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

      if (apiDefinition.advancedSettings?.enforceGenuineAnthropic) {
        validateAnthropicResponse(usage, finalMessage.content);
      }

      return {
        thinkingContent,
        textContent,
        hasCoT: fullContent.some(b => b.type === 'thinking' || b.type === 'redacted_thinking'),
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
}
