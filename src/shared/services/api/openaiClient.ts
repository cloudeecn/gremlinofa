import OpenAI from 'openai';
import { getProxyConfig } from './proxyConfig';
import type { ChatCompletionCreateParams, ChatCompletionTool } from 'openai/resources/index.mjs';
import type {
  APIDefinition,
  Message,
  MessageStopReason,
  Model,
  ReasoningEffort,
  ReasoningHistoryParam,
  ToolUseBlock,
  ToolOptions,
} from '../../protocol/types';
import {
  effortBesideToggle,
  effortWhenOff,
  mapReasoningEffort,
} from '../../engine/lib/reasoningEffort';
import { resolveReasoningDialect, wantsReasoningHistory } from '../../engine/lib/reasoningDialect';
import {
  parseToolArguments,
  type APIClient,
  type StreamChunk,
  type StreamResult,
} from './baseClient';
import type { APIServiceDeps } from './apiService';
import {
  effectiveInjectionMode,
  buildSeparateBlockText,
  wrapInjectedFile,
  type InjectedFile,
} from './fileInjectionHelper';
import {
  CompletionFullContentAccumulator,
  createFullContentFromMessage,
  reasoningTextOf,
} from './completionFullContentAccumulator';
import type { CompletionChunk, CompletionMessage } from './completionStreamMapper';
import {
  convertMessageToStreamChunks,
  createMapperState,
  mapCompletionChunkToStreamChunks,
} from './completionStreamMapper';
import { findCheckpointIndex, findThinkingBoundaryN, tidyAgnosticMessage } from './contextTidy';
import { getModelMetadataFor } from '../../engine/lib/api/modelMetadata';
import {
  populateFromOpenRouterModel,
  type OpenRouterModel,
} from '../../engine/lib/api/model_metadatas/openRouterModelMapper';

/** OpenRouter's unified `reasoning` request object. `effort` and `max_tokens` are alternatives. */
interface OpenRouterReasoningParam {
  effort?: ReasoningEffort;
  max_tokens?: number;
  enabled?: boolean;
}

/**
 * Combined message tidy for OpenAI Chat Completions: checkpoint tool filtering
 * plus reasoning pruning. Mirrors `responsesClient.tidyMessages`, except the
 * pruning unit is a field on the stored message rather than an array item —
 * Chat Completions carries reasoning as `reasoning_content` / `reasoning` on
 * the assistant message itself.
 *
 * OpenAI fullContent is either:
 * - Object (CompletionMessage) with optional tool_calls[] for assistant messages
 * - Array of { type: 'tool_result', tool_call_id } for user tool result messages
 *
 * `keepToolTurnReasoning` (models with `mandatesReasoningReplay`) exempts
 * assistant turns that still carry tool calls from every kind of stripping.
 */
export function tidyMessages(
  messages: Message<unknown>[],
  checkpointMessageId: string | undefined,
  tidyToolNames: Set<string> | undefined,
  pruneThinking: boolean,
  pruneThinkingKeepTurns: number | undefined,
  keepToolTurnReasoning = false
): Message<unknown>[] {
  const checkpointIdx = findCheckpointIndex(messages, checkpointMessageId);
  const projectPruneActive = pruneThinkingKeepTurns !== undefined && pruneThinkingKeepTurns >= 0;
  const anyPrune = pruneThinking || projectPruneActive;
  const effectiveKeep = projectPruneActive ? (pruneThinkingKeepTurns as number) : 1;
  const thinkingBoundary = anyPrune ? findThinkingBoundaryN(messages, effectiveKeep) : -1;

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

    // Wrong modelFamily or missing fullContent
    if (msg.content.modelFamily !== 'chatgpt' || msg.content.fullContent == null) {
      if (isCheckpoint) {
        result.push(msg);
      } else if (inCheckpoint) {
        const { message, newRemovedIds } = tidyAgnosticMessage(
          msg,
          toolNames,
          removedToolUseIds,
          false
        );
        for (const id of newRemovedIds) removedToolUseIds.add(id);
        if (message) result.push(message);
      } else if (inThinking) {
        // Another provider's thinking-only message has nothing left to send
        const hasText = msg.content.content.trim().length > 0;
        const hasTools =
          (msg.content.toolCalls?.length ?? 0) + (msg.content.toolResults?.length ?? 0) > 0;
        if (hasText || hasTools) result.push(msg);
      } else {
        result.push(msg);
      }
      continue;
    }

    const fullContent = msg.content.fullContent;

    // Array fullContent = tool result message, no reasoning to strip
    if (Array.isArray(fullContent)) {
      if (isCheckpoint || !inCheckpoint) {
        result.push(msg);
        continue;
      }
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

    // Object fullContent = CompletionMessage with optional reasoning + tool_calls
    let cmsg = fullContent as CompletionMessage;
    let changed = false;

    if (inCheckpoint && !isCheckpoint && cmsg.tool_calls?.length) {
      const keptCalls = cmsg.tool_calls.filter(tc => {
        if (toolNames.has(tc.function.name)) {
          removedToolUseIds.add(tc.id);
          return false;
        }
        return true;
      });

      if (keptCalls.length !== cmsg.tool_calls.length) {
        changed = true;
        if (keptCalls.length === 0) {
          const { tool_calls: _tc, ...rest } = cmsg;
          cmsg = rest;
        } else {
          cmsg = { ...cmsg, tool_calls: keptCalls };
        }
      }
    }

    // Reasoning goes in the checkpoint range unconditionally (the checkpoint
    // note replaces that history) and before the thinking boundary when pruning.
    // Decided after the tool-call filter, so the mandated-replay exemption only
    // covers calls that still go out.
    //
    // All-or-nothing per message, deliberately: a `reasoning_details` array with
    // some entries removed is an ordering violation upstream, while a message
    // carrying none is just a historical turn without reasoning, which every
    // provider accepts.
    const stripReasoning =
      ((inCheckpoint && !isCheckpoint) || (inThinking && anyPrune)) &&
      !(keepToolTurnReasoning && cmsg.tool_calls?.length);
    if (stripReasoning && (cmsg.reasoning_content || cmsg.reasoning || cmsg.reasoning_details)) {
      const { reasoning_content: _rc, reasoning: _r, reasoning_details: _rd, ...rest } = cmsg;
      cmsg = rest;
      changed = true;
    }

    // Tidying emptied it out: drop rather than send a blank assistant turn
    if (
      changed &&
      !cmsg.content?.trim() &&
      !cmsg.tool_calls?.length &&
      !msg.content.content.trim()
    ) {
      continue;
    }

    if (changed) {
      result.push({ ...msg, content: { ...msg.content, fullContent: cmsg } });
    } else {
      result.push(msg);
    }
  }

  for (let i = processUntil + 1; i < messages.length; i++) {
    result.push(messages[i]);
  }

  return result;
}

export class OpenAIClient implements APIClient {
  protected readonly deps: APIServiceDeps;

  constructor(deps: APIServiceDeps) {
    this.deps = deps;
  }

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
    console.debug('Models for %s:', apiDefinition.name, modelsResponse);

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
    console.debug('Argumented models for %s:', apiDefinition.name, models);
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
      thinkingKeepTurns?: number;
      pruneThinkingKeepTurns?: number;
      reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
      reasoningSummary?: 'auto' | 'concise' | 'detailed';
      verbosity?: 'low' | 'medium' | 'high';
      systemPrompt?: string;
      preFillResponse?: string;
      webSearchEnabled?: boolean;
      enabledTools?: string[];
      toolOptions?: Record<string, ToolOptions>;
      disableStream?: boolean;
      signal: AbortSignal;
      checkpointMessageId?: string;
      tidyToolNames?: Set<string>;
      cacheRoutingKey?: string;
      flexTierEnabled?: boolean;
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

      // Needed before message conversion, not just at request-param time: the
      // dialect decides whether signed `reasoning_details` are echoed back.
      const model = await this.deps.storage.getModel(apiDefinition.id, modelId);
      const dialect = resolveReasoningDialect(model, apiDefinition);
      // Fresh lookup, not the cached model: the cache is a discovery-time
      // snapshot and predates these fields.
      const knowledge = getModelMetadataFor(apiDefinition, modelId);
      const mandatesReplay = knowledge.mandatesReasoningReplay === true;

      // Tidy messages: checkpoint-based tool filtering + reasoning pruning
      const tidiedMessages = tidyMessages(
        messages,
        options.checkpointMessageId,
        options.tidyToolNames,
        apiDefinition.advancedSettings?.pruneThinking ?? false,
        options.pruneThinkingKeepTurns,
        mandatesReplay
      );

      // Mandated replay: a tool-call turn with no reasoning to send still needs
      // the field. DeepSeek accepts an empty string.
      const replayPlaceholder = (mandatesReplay ? { reasoning_content: '' } : undefined) as
        Partial<OpenAI.ChatCompletionAssistantMessageParam> | undefined;

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
          const injectedCount =
            (msg.content.injectedFiles?.length ?? 0) +
            (msg.content.injectedFilesAfter?.length ?? 0);
          const hasInjectedFiles = injectedCount > 0 && Boolean(msg.content.injectionMode);
          const injMode = hasInjectedFiles
            ? effectiveInjectionMode(msg.content.injectionMode!, 'chatgpt')
            : undefined;

          // mock-tool-call messages carry the fields for retry-restore only —
          // their content rides the synthetic tool pair messages, so keep the
          // plain string form.
          if (
            hasAttachments ||
            (hasInjectedFiles && injMode !== 'inline' && injMode !== 'mock-tool-call')
          ) {
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

            // Add injected file blocks. `injectedFiles` goes before the text
            // part, `injectedFilesAfter` after it.
            const pushInjectedFiles = (files?: InjectedFile[]) => {
              if (!files?.length) return;
              if (injMode === 'as-file') {
                for (const file of files) {
                  contentParts.push({
                    type: 'file',
                    file: {
                      file_data: `data:text/plain;base64,${btoa(unescape(encodeURIComponent(wrapInjectedFile(file))))}`,
                      filename: file.path,
                    },
                  } as OpenAI.ChatCompletionContentPart);
                }
              } else if (injMode === 'separate-block') {
                for (const file of files) {
                  contentParts.push({
                    type: 'text',
                    text: buildSeparateBlockText(file),
                  });
                }
              }
            };
            pushInjectedFiles(msg.content.injectedFiles);

            // Add text content (only if non-empty — an inject-only minion
            // message has files but no text)
            if (msg.content.content.trim()) {
              contentParts.push({
                type: 'text',
                text: msg.content.content,
              });
            }

            pushInjectedFiles(msg.content.injectedFilesAfter);

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
              ...replayPlaceholder,
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
            // Reasoning goes back as `reasoning_content` whichever key it
            // arrived on: every probed endpoint reads that key, while a plain
            // `reasoning` key is ignored by DeepSeek, GLM and MiniMax. Under the
            // OpenRouter dialect the signed `reasoning_details` array displaces
            // the text rather than joining it: sending both hands the gateway
            // two representations of the same reasoning, and an Anthropic
            // upstream can translate the unsigned one into a second thinking
            // block — the exact sequence mismatch the signature is meant to
            // catch. The SDK's message type has none of these fields, hence the cast.
            const reasoningText = reasoningTextOf(fullContent);
            const reasoningEcho = (
              dialect === 'openrouter' && fullContent.reasoning_details?.length
                ? { reasoning_details: fullContent.reasoning_details }
                : reasoningText
                  ? { reasoning_content: reasoningText }
                  : undefined
            ) as Partial<OpenAI.ChatCompletionAssistantMessageParam> | undefined;

            // New format: CompletionMessage object
            if (fullContent.tool_calls && fullContent.tool_calls.length > 0) {
              openaiMessages.push({
                role: 'assistant',
                content: fullContent.content ?? null,
                ...(reasoningEcho ?? replayPlaceholder),
                tool_calls: fullContent.tool_calls as OpenAI.ChatCompletionMessageToolCall[],
              });
              return;
            }
            // No tool calls, just use content
            openaiMessages.push({
              role: 'assistant',
              content: fullContent.content ?? msg.content.content,
              ...reasoningEcho,
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
                ...replayPlaceholder,
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
        ...(options.cacheRoutingKey && { prompt_cache_key: options.cacheRoutingKey }),
        ...(options.flexTierEnabled && { service_tier: 'flex' as const }),
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

      this.applyReasoning(
        requestParams,
        options,
        model,
        apiDefinition,
        knowledge.reasoningHistoryParam
      );

      // Verbosity is GPT-5-era only — older models reject the param, so it
      // rides on the per-model flag rather than the project setting alone.
      // Chat Completions takes it top-level; Responses nests it under `text`.
      if (options.verbosity && model?.supportsVerbosity) {
        requestParams.verbosity = options.verbosity;
      }

      // Track token usage and finish reason
      let inputTokens = 0;
      let outputTokens = 0;
      let cacheReadTokens = 0;
      let reasoningTokens = 0;
      let finishReason: string | null = null;
      let servedModel: string | undefined;

      // Use streaming unless explicitly disabled
      if (!options.disableStream) {
        // Streaming path: use mapper and accumulator
        const stream = await client.chat.completions.create(
          {
            ...requestParams,
            stream: true,
            stream_options: { include_usage: true },
          },
          { signal: options.signal }
        );

        let mapperState = createMapperState();
        const accumulator = new CompletionFullContentAccumulator();

        for await (const chunk of stream) {
          // Cast SDK chunk to our interface
          const completionChunk = chunk as unknown as CompletionChunk;
          if (completionChunk.model) {
            servedModel = completionChunk.model;
          }

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

        // No finish_reason: the stream was cut off, however much it rendered.
        // Its tool calls never ran, and replaying them without results 400s.
        if (!finishReason) {
          const { tool_calls: _cutCalls, ...partialMessage } = fullContent;
          return {
            textContent,
            fullContent: partialMessage,
            error: { message: 'Stream ended before a finish_reason arrived' },
            inputTokens,
            outputTokens,
            cacheReadTokens: cacheReadTokens > 0 ? cacheReadTokens : undefined,
            reasoningTokens: reasoningTokens > 0 ? reasoningTokens : undefined,
          };
        }

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
          servedModel,
          inputTokens,
          outputTokens,
          cacheReadTokens: cacheReadTokens > 0 ? cacheReadTokens : undefined,
          reasoningTokens: reasoningTokens > 0 ? reasoningTokens : undefined,
        };
      } else {
        // Non-streaming path
        const response = await client.chat.completions.create(
          {
            ...requestParams,
            stream: false,
          },
          { signal: options.signal }
        );

        const message = response.choices[0]?.message;
        finishReason = response.choices[0]?.finish_reason || null;
        servedModel = response.model || undefined;

        if (!message) {
          return {
            textContent: '',
            fullContent: { role: 'assistant', content: null, refusal: null },
            error: { message: 'API returned no message (empty choices)' },
            inputTokens: 0,
            outputTokens: 0,
          };
        }

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
            outputTokens -= reasoningTokens;
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
          // Some providers stream reasoning text without reporting
          // reasoning_tokens, so text presence counts too
          hasCoT:
            reasoningTokens > 0 ||
            reasoningTextOf(fullContent).length > 0 ||
            (fullContent.reasoning_details?.length ?? 0) > 0,
          fullContent,
          stopReason: this.mapStopReason(finishReason),
          servedModel,
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
      reasoningBudgetTokens?: number;
      maxTokens?: number;
      thinkingKeepTurns?: number;
    },
    model?: Model,
    apiDefinition?: APIDefinition,
    historyParam?: ReasoningHistoryParam
  ) {
    if (options.temperature) requestParams.temperature = options.temperature;

    const reasoningOff = options.enableReasoning === false || model?.reasoningMode === 'none';
    // An always-reasoning model reasons regardless, and some hosts 400 on the
    // attempt (Alibaba and OpenRouter for GLM-5.3, Kimi for K2.7 Code).
    const sendDisable = reasoningOff && model?.reasoningMode !== 'always';
    const keepHistory = !sendDisable && wantsReasoningHistory(options.thinkingKeepTurns);

    switch (resolveReasoningDialect(model, apiDefinition)) {
      case 'thinking-object': {
        const thinking: Record<string, unknown> = { type: sendDisable ? 'disabled' : 'enabled' };
        if (keepHistory && historyParam === 'clear_thinking') thinking.clear_thinking = false;
        if (keepHistory && historyParam === 'thinking_keep') thinking.keep = 'all';
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (requestParams as any)['thinking'] = thinking;
        const effort = effortBesideToggle(options.reasoningEffort, model, reasoningOff);
        // `max` is outside the SDK's reasoning_effort type, hence the untyped write.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if (effort) (requestParams as any)['reasoning_effort'] = effort;
        return;
      }

      // Never with `reasoning_effort`: Alibaba's Chat Completions has none for
      // these models (Qwen 3.8's levels are Responses-only).
      case 'enable-thinking':
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (requestParams as any)['enable_thinking'] = !sendDisable;
        if (keepHistory && historyParam === 'preserve_thinking') {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (requestParams as any)['preserve_thinking'] = true;
        }
        return;

      case 'openrouter':
        this.applyOpenRouterReasoning(requestParams, options, model);
        return;

      case 'openai': {
        if (!reasoningOff) {
          this.applyEffortReasoning(requestParams, options.reasoningEffort, model);
          return;
        }
        // Omitting the field would leave the model at its default effort.
        const offEffort = effortWhenOff(model);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if (offEffort) (requestParams as any)['reasoning_effort'] = offEffort;
        return;
      }
    }
  }

  private applyEffortReasoning(
    requestParams: ChatCompletionCreateParams,
    effort: ReasoningEffort,
    model?: Model
  ) {
    const supportedEfforts = model?.supportedReasoningEfforts;

    // Model with reasoning but no configurable effort (e.g., grok-4.20)
    if (!supportedEfforts || supportedEfforts.length === 0) {
      // No effort param needed - model always reasons or doesn't support effort config
      return;
    }

    // Model with configurable reasoning effort. The cast only satisfies the SDK type, which
    // lacks 'max'; gpt-5.6 and gpt-6 list it and the API accepts it.
    const mappedEffort = mapReasoningEffort(
      effort,
      supportedEfforts as Exclude<ReasoningEffort, 'max'>[]
    );
    if (mappedEffort !== undefined) {
      requestParams.reasoning_effort = mappedEffort;
    }
  }

  /**
   * OpenRouter's unified `reasoning` object. `effort` and `max_tokens` are
   * alternatives upstream — never both — and `deFactoThinking` metadata carried
   * by a model routed *through* OpenRouter is deliberately ignored, since the
   * gateway speaks its own shape regardless of what the underlying vendor wants.
   *
   * `exclude` is not wired: it suppresses `reasoning_details` too, which would
   * destroy the round-trip and force `hasCoT` false for every turn.
   */
  protected applyOpenRouterReasoning(
    requestParams: ChatCompletionCreateParams,
    options: {
      enableReasoning?: boolean;
      reasoningEffort?: ReasoningEffort;
      reasoningBudgetTokens?: number;
      maxTokens?: number;
    },
    model?: Model
  ) {
    // A model that can't reason gets no field at all — some upstreams reject it.
    if (model?.reasoningMode === 'none') return;

    const setReasoning = (value: OpenRouterReasoningParam) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (requestParams as any)['reasoning'] = value;
    };

    if (options.enableReasoning === false) {
      // A mandatory-reasoning endpoint 400s on `enabled: false`; ask it for its
      // least effort instead, when the levels are known.
      if (model?.reasoningMode !== 'always') {
        setReasoning({ enabled: false });
      } else {
        const offEffort = effortWhenOff(model);
        if (offEffort) setReasoning({ effort: offEffort });
      }
      return;
    }

    const supportedEfforts = model?.supportedReasoningEfforts;
    // Unlike `reasoning_effort`, this field is ours to shape, so 'xhigh' / 'max'
    // pass through instead of being clamped out by the SDK's narrower type.
    const mappedEffort =
      supportedEfforts && supportedEfforts.length > 0
        ? mapReasoningEffort(options.reasoningEffort, supportedEfforts)
        : options.reasoningEffort;
    if (mappedEffort !== undefined) {
      setReasoning({ effort: mappedEffort });
      return;
    }

    const budget = options.reasoningBudgetTokens ?? 0;
    if (budget > 0) {
      setReasoning({ max_tokens: budget });
      // Anthropic upstream rejects a budget that leaves no room for the answer,
      // and OpenRouter surfaces it as an opaque 400 (mirrors anthropicClient).
      if (options.maxTokens !== undefined && budget >= options.maxTokens) {
        requestParams.max_completion_tokens = budget + 500;
      }
      return;
    }

    setReasoning({ enabled: true });
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
    // Arguments cut off by a `length` finish don't parse: drop the call
    // rather than run or replay it.
    const toBlocks = (calls: { id: string; name: string; args: string | undefined }[]) =>
      calls.flatMap(call => {
        const input = parseToolArguments(call.args);
        return input ? [{ type: 'tool_use' as const, id: call.id, name: call.name, input }] : [];
      });

    // Handle new CompletionMessage format
    if (fullContent && typeof fullContent === 'object' && !Array.isArray(fullContent)) {
      const msg = fullContent as CompletionMessage;
      return toBlocks(
        (msg.tool_calls ?? []).map(tc => ({
          id: tc.id,
          name: tc.function.name,
          args: tc.function.arguments,
        }))
      );
    }

    // Handle legacy array format for backward compatibility
    if (!Array.isArray(fullContent)) return [];

    for (const block of fullContent as Array<Record<string, unknown>>) {
      if (block.type === 'tool_calls' && Array.isArray(block.tool_calls)) {
        return toBlocks(
          (block.tool_calls as Array<Record<string, unknown>>).map(tc => {
            const fn = tc.function as Record<string, unknown> | undefined;
            return {
              id: tc.id as string,
              name: fn?.name as string,
              args: fn?.arguments as string | undefined,
            };
          })
        );
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
    const standardDefs = this.deps.toolRegistry.getToolDefinitions(enabledTools, toolOptions);

    return standardDefs.map(def => {
      // Check for provider-specific override first
      const override = this.deps.toolRegistry.getToolOverride(
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
