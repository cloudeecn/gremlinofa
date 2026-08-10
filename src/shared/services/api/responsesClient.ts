import OpenAI from 'openai';
import { getProxyConfig } from './proxyConfig';
import type {
  APIDefinition,
  APIType,
  Message,
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
  convertOutputToStreamChunks,
  createMapperState,
  createTokenUsageChunk,
  mapResponsesEventToStreamChunks,
  parseResponsesStreamEvent,
  responsesStopReason,
  STREAM_CUT_MESSAGE,
} from './responsesStreamMapper';
import {
  ResponsesStreamAccumulator,
  buildStreamResultFromAccumulator,
} from './responsesStreamAccumulator';
import { findCheckpointIndex, findThinkingBoundaryN, tidyAgnosticMessage } from './contextTidy';
import { probePrefixDivergence } from './promptCacheDebug';
import { getModelMetadataFor } from '../../engine/lib/api/modelMetadata';
import {
  populateFromOpenRouterModel,
  type OpenRouterModel,
} from '../../engine/lib/api/model_metadatas/openRouterModelMapper';

/**
 * Mandated-replay placeholder (see `mandatesReasoningReplay`). DeepSeek treats an
 * empty `reasoning_text` as missing, but takes a single space.
 */
const REPLAY_PLACEHOLDER = {
  type: 'reasoning',
  summary: [],
  content: [{ type: 'reasoning_text', text: ' ' }],
} as unknown as OpenAI.Responses.ResponseInputItem;

/**
 * Combined message tidy: checkpoint filtering, thinking pruning, empty text removal.
 * Single forward pass with direct access to Responses API item types.
 *
 * `keepToolTurnReasoning` (models with `mandatesReasoningReplay`) exempts
 * messages that still carry a `function_call` from reasoning removal.
 */
function tidyMessages(
  messages: Message<unknown>[],
  checkpointMessageId: string | undefined,
  tidyToolNames: Set<string> | undefined,
  pruneThinking: boolean,
  pruneEmptyText: boolean,
  pruneThinkingKeepTurns: number | undefined,
  ownFamily: APIType,
  keepToolTurnReasoning = false
): Message<unknown>[] {
  const checkpointIdx = findCheckpointIndex(messages, checkpointMessageId);
  const projectPruneActive = pruneThinkingKeepTurns !== undefined && pruneThinkingKeepTurns >= 0;
  const effectiveKeep = projectPruneActive ? (pruneThinkingKeepTurns as number) : 1;
  const anyPrune = pruneThinking || pruneEmptyText || projectPruneActive;
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

    if (msg.content.modelFamily !== ownFamily || msg.content.fullContent == null) {
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

    let items = msg.content.fullContent as {
      type?: string;
      name?: string;
      call_id?: string;
      text?: string;
    }[];
    const pruneReasoning = (list: typeof items) =>
      keepToolTurnReasoning && list.some(it => it.type === 'function_call')
        ? list
        : list.filter(it => it.type !== 'reasoning');

    if (inCheckpoint) {
      const filtered: typeof items = [];
      for (const it of items) {
        if (isCheckpoint || it.type === 'reasoning') {
          filtered.push(it);
          continue;
        }
        if (it.type === 'function_call' && it.name && toolNames.has(it.name)) {
          if (it.call_id) removedToolUseIds.add(it.call_id);
          continue;
        }
        if (it.type === 'function_call_output' && it.call_id && removedToolUseIds.has(it.call_id)) {
          continue;
        }
        filtered.push(it);
      }
      // After the call filter, so the mandated-replay exemption only covers
      // calls that still go out
      items = pruneReasoning(filtered);
    }

    if (inThinking && !inCheckpoint && (pruneThinking || projectPruneActive)) {
      items = pruneReasoning(items);
    }

    if (inThinking && pruneEmptyText) {
      items = items.filter(it => it.type !== 'output_text' || (it.text?.trim()?.length ?? 0) > 0);
    }

    if (items.length === 0) continue;
    if (items !== (msg.content.fullContent as typeof items)) {
      result.push({ ...msg, content: { ...msg.content, fullContent: items } });
    } else {
      result.push(msg);
    }
  }

  for (let i = processUntil + 1; i < messages.length; i++) {
    result.push(messages[i]);
  }

  return result;
}

export class ResponsesClient implements APIClient {
  protected readonly deps: APIServiceDeps;
  /**
   * The `modelFamily` this client stamps on messages and recognizes as its
   * own stored wire format. Stored items from any other family go through
   * cross-model reconstruction instead of being replayed verbatim. Subclasses
   * speaking the same wire format under a different apiType override this.
   */
  protected readonly ownFamily: APIType = 'responses_api';

  constructor(deps: APIServiceDeps) {
    this.deps = deps;
  }

  /** Build the SDK client. Subclasses swap credentials / base URL / headers here. */
  protected async createClient(apiDefinition: APIDefinition): Promise<OpenAI> {
    const proxy = getProxyConfig(apiDefinition);
    return new OpenAI({
      dangerouslyAllowBrowser: true,
      apiKey: apiDefinition.apiKey,
      baseURL: proxy?.baseURL ?? (apiDefinition.baseUrl || undefined),
      ...(proxy && { defaultHeaders: proxy.headers }),
    });
  }

  /**
   * Last hook before the request goes out — every field (input, tools,
   * reasoning, verbosity) is already set. No-op here; subclasses reshape the
   * request for backends with a narrower contract.
   */
  protected finalizeRequestParams(
    _requestParams: OpenAI.Responses.ResponseCreateParams,
    _options: { systemPrompt?: string },
    _model: Model | undefined
  ): void {}

  /** Whether to bypass the SDK's `.stream()` snapshot accumulator (see the stream branch). */
  protected useStreamAccumulator(apiDefinition: APIDefinition): boolean {
    return apiDefinition.advancedSettings?.useStreamAccumulator === true;
  }

  /**
   * Per-request headers this backend needs on top of the client's defaults.
   * Applied identically to all three request paths. No-op here; subclasses
   * speaking a backend with its own header contract override it.
   */
  protected requestHeaders(_options: {
    cacheRoutingKey?: string;
  }): Record<string, string> | undefined {
    return undefined;
  }

  /**
   * The hosted web-search tool. `web_search_preview` is the legacy alias — the
   * GPT-5 family and the ChatGPT/Codex backend answer 400 for it — so the GA
   * `web_search` is the default and metadata opts a model back to the alias.
   */
  protected buildWebSearchTool(model?: Model): OpenAI.Responses.Tool {
    return { type: model?.webSearchTool ?? 'web_search' };
  }

  /** Whether this backend accepts `stream: false`, i.e. can honour the project's disable-streaming toggle. */
  protected supportsNonStreaming(): boolean {
    return true;
  }

  async discoverModels(apiDefinition: APIDefinition): Promise<Model[]> {
    const client = await this.createClient(apiDefinition);

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
  ): AsyncGenerator<StreamChunk, StreamResult<OpenAI.Responses.ResponseInputItem[]>, unknown> {
    let requestParams: OpenAI.Responses.ResponseCreateParams = {};
    try {
      const client = await this.createClient(apiDefinition);

      // Model metadata drives reasoning, verbosity and the web-search tool shape
      const model = await this.deps.storage.getModel(apiDefinition.id, modelId);
      // Fresh lookup, not the cached model: the cache is a discovery-time
      // snapshot and predates these fields.
      const knowledge = getModelMetadataFor(apiDefinition, modelId);
      const mandatesReplay = knowledge.mandatesReasoningReplay === true;

      // Tidy messages: checkpoint filtering, thinking pruning, empty text removal
      const tidiedMessages = tidyMessages(
        messages,
        options.checkpointMessageId,
        options.tidyToolNames,
        apiDefinition.advancedSettings?.pruneThinking ?? false,
        apiDefinition.advancedSettings?.pruneEmptyText ?? false,
        options.pruneThinkingKeepTurns,
        this.ownFamily,
        mandatesReplay
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
      tidiedMessages.forEach(msg => {
        if (msg.role === 'user') {
          // Legacy stored messages: fullContent has function_call_output items
          if (
            msg.content.modelFamily === this.ownFamily &&
            msg.content.fullContent &&
            Array.isArray(msg.content.fullContent)
          ) {
            const fullContentArr = msg.content.fullContent;
            const hasFunctionCallOutput = fullContentArr.some(
              item => item.type === 'function_call_output'
            );
            if (hasFunctionCallOutput) {
              for (const item of fullContentArr) {
                if (item.type === 'function_call_output') {
                  input.push(item);
                }
              }
              return;
            }
          }

          // New messages and cross-model: use toolResults
          if (msg.content.toolResults?.length) {
            for (const tr of msg.content.toolResults) {
              input.push({
                type: 'function_call_output',
                call_id: tr.tool_use_id,
                output: tr.content,
              } as OpenAI.Responses.ResponseInputItem);
            }
            return;
          }

          const contentItems: OpenAI.Responses.ResponseInputContent[] = [];

          // Add images first if attachments present
          if (msg.attachments && msg.attachments.length > 0) {
            for (const attachment of msg.attachments) {
              contentItems.push({
                type: 'input_image',
                image_url: `data:${attachment.mimeType};base64,${attachment.data}`,
              } as OpenAI.Responses.ResponseInputImage);
            }
          }

          // Add injected file blocks based on injection mode. `injectedFiles`
          // goes before the text item, `injectedFilesAfter` after it.
          const pushInjectedFiles = (files?: InjectedFile[]) => {
            if (!files?.length || !msg.content.injectionMode) return;
            const mode = effectiveInjectionMode(msg.content.injectionMode, this.ownFamily);
            if (mode === 'as-file') {
              for (const file of files) {
                contentItems.push({
                  type: 'input_file',
                  file_data: `data:text/plain;base64,${btoa(unescape(encodeURIComponent(wrapInjectedFile(file))))}`,
                  filename: file.path,
                } as OpenAI.Responses.ResponseInputContent);
              }
            } else if (mode === 'separate-block') {
              for (const file of files) {
                contentItems.push({
                  type: 'input_text',
                  text: buildSeparateBlockText(file),
                });
              }
            }
          };
          pushInjectedFiles(msg.content.injectedFiles);

          // Add text content (only if non-empty — an inject-only minion
          // message has files but no text)
          if (msg.content.content.trim()) {
            contentItems.push({
              type: 'input_text',
              text: msg.content.content,
            });
          }

          pushInjectedFiles(msg.content.injectedFilesAfter);

          // A message with nothing at all still goes out as one empty text
          // item rather than an empty content array.
          if (contentItems.length === 0) {
            contentItems.push({ type: 'input_text', text: msg.content.content });
          }

          input.push({
            role: 'user',
            content: contentItems,
          });
        } else if (msg.role === 'assistant') {
          if (
            msg.content.modelFamily === this.ownFamily &&
            msg.content.fullContent &&
            Array.isArray(msg.content.fullContent)
          ) {
            // Include ALL stored items (message, function_call, reasoning, etc.)
            // Don't filter - API needs full context including encrypted reasoning.
            // Items are copied before reshaping: they are the stored history.
            const storedItems = msg.content.fullContent as OpenAI.Responses.ResponseInputItem[];
            // Placeholders lead the turn, where the vendor's own reasoning item sits
            if (
              mandatesReplay &&
              !storedItems.some(item => item.type === 'reasoning') &&
              storedItems.some(item => item.type === 'function_call')
            ) {
              input.push(REPLAY_PLACEHOLDER);
            }
            for (const item of storedItems) {
              if ('parsed_arguments' in item) {
                const { parsed_arguments: _parsed, ...rest } = item;
                input.push(rest as OpenAI.Responses.ResponseInputItem);
              } else if (item.type === 'reasoning' && !item.summary) {
                // OpenAI 400s on a reasoning item without `summary`. Every probed
                // vendor emits one; this covers the rest.
                input.push({ ...item, summary: [] });
              } else {
                input.push(item);
              }
            }
          } else if (msg.content.toolCalls?.length) {
            // Cross-model reconstruction: text message + function_call items
            if (mandatesReplay) input.push(REPLAY_PLACEHOLDER);
            if (msg.content.content.trim()) {
              input.push({
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: msg.content.content }],
              } as OpenAI.Responses.ResponseInputItem);
            }
            for (const tc of msg.content.toolCalls) {
              input.push({
                type: 'function_call',
                call_id: tc.id,
                name: tc.name,
                arguments: JSON.stringify(tc.input),
              } as OpenAI.Responses.ResponseInputItem);
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

      const tools: OpenAI.Responses.Tool[] = options.webSearchEnabled
        ? [this.buildWebSearchTool(model)]
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
        ...(options.cacheRoutingKey && { prompt_cache_key: options.cacheRoutingKey }),
        ...(options.flexTierEnabled && { service_tier: 'flex' as const }),
      };

      this.applyReasoning(
        requestParams,
        options,
        model,
        apiDefinition,
        knowledge.reasoningHistoryParam
      );

      // Sent whatever the toggle says: an always-reasoning model reasons anyway,
      // and the blob is what the next turn replays. Every probed vendor accepts
      // it, OpenAI's non-reasoning models included.
      if (model?.reasoningMode !== 'none') {
        requestParams.include = ['reasoning.encrypted_content'];
      }

      // Verbosity is GPT-5-era only — older models reject the param, so it
      // rides on the per-model flag rather than the project setting alone.
      if (options.verbosity && model?.supportsVerbosity) {
        requestParams.text = { verbosity: options.verbosity };
      }

      // Add tools if present
      if (tools.length > 0) {
        requestParams.tools = tools;
      }

      this.finalizeRequestParams(requestParams, options, model);

      // One options object for every request path so headers can't drift
      // between them.
      const extraHeaders = this.requestHeaders(options);
      const requestOptions = {
        signal: options.signal,
        ...(extraHeaders && { headers: extraHeaders }),
      };

      probePrefixDivergence(apiDefinition.apiType, options.cacheRoutingKey, requestParams);

      // Use streaming unless explicitly disabled — and unless the backend has no non-streaming mode
      if (!options.disableStream || !this.supportsNonStreaming()) {
        let mapperState = createMapperState();
        const useAccumulator = this.useStreamAccumulator(apiDefinition);

        // === Stream accumulator path (opt-in) ===
        // For third-party Responses API providers (e.g. OpenRouter) that:
        //   - emit non-spec frames like `response.keep_alive` during long
        //     reasoning calls — the SDK's `.stream()` wraps every event
        //     through a strict snapshot accumulator that throws on the first
        //     non-`response.created` event, killing the stream; OR
        //   - return an empty `output` from `stream.finalResponse()` even
        //     though events were streamed.
        // We bypass `.stream()` entirely and iterate the raw event stream from
        // `.create({stream:true})`, then build `textContent` / `fullContent`
        // from the same events the user already saw.
        if (useAccumulator) {
          const rawStream = await client.responses.create(
            {
              ...requestParams,
              stream: true,
            },
            requestOptions
          );

          const accumulator = new ResponsesStreamAccumulator();

          for await (const event of rawStream) {
            const sseEvent = parseResponsesStreamEvent(event);
            const result = mapResponsesEventToStreamChunks(sseEvent, mapperState);
            mapperState = result.state;

            accumulator.pushEvent(sseEvent);

            for (const chunk of result.chunks) {
              yield chunk;
            }
          }

          return buildStreamResultFromAccumulator(accumulator);
        }

        // === finalResponse path (default) ===
        // Stock OpenAI and well-behaved providers return a complete
        // `Response.output` from `stream.finalResponse()`, which we hand to
        // `processResponse` to build the StreamResult.
        const stream = client.responses.stream(
          {
            ...requestParams,
            stream: true,
          },
          requestOptions
        );

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

        const terminal = mapperState.terminalResponse;
        if (!terminal) throw new Error(STREAM_CUT_MESSAGE);

        const snapshot = await stream.finalResponse();
        if (terminal.status === 'completed') return this.processResponse(snapshot);

        // The SDK adopts the terminal response only on `response.completed`;
        // after `response.incomplete` / `response.failed` its snapshot is
        // still the `response.created` one, items and all `in_progress`.
        const terminalOutput = terminal.output as OpenAI.Responses.ResponseOutputItem[] | undefined;
        const response = { ...snapshot, ...terminal } as OpenAI.Responses.Response;
        if (terminalOutput?.length) {
          response.output_text = '';
        } else {
          response.output = snapshot.output;
        }
        return this.processResponse(response);
      } else {
        // NON-STREAMING PATH - convert output to chunks
        const response = await client.responses.create(
          {
            ...requestParams,
            stream: false,
          },
          requestOptions
        );

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
  ): StreamResult<OpenAI.Responses.ResponseInputItem[]> {
    // Extract text content from output
    let textContent = response.output_text;
    // SDK v6.9+: output items can have status:"failed" which input validation rejects.
    // Validate each item — streamed chunks are already yielded so user sees the content.
    const fullContent = response.output
      .filter(output => output !== undefined)
      .map((item): OpenAI.Responses.ResponseInputItem => {
        if ('status' in item && item.status === 'failed') {
          throw new Error(`Response item failed: ${item.type}`);
        }
        return item as OpenAI.Responses.ResponseInputItem;
      });
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
      hasCoT: fullContent.some(item => item.type === 'reasoning'),
      fullContent,
      stopReason: responsesStopReason(response, hasFunctionCall),
      servedModel: response.model,
      inputTokens: inputTokens - cachedTokens,
      outputTokens: outputTokens - reasoningTokens,
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
      thinkingKeepTurns?: number;
    },
    model?: Model,
    apiDefinition?: APIDefinition,
    historyParam?: ReasoningHistoryParam
  ) {
    const effort = options.reasoningEffort;
    const summary = options.reasoningSummary;

    if (options.temperature) requestParams.temperature = options.temperature;

    const reasoningOff = options.enableReasoning === false || model?.reasoningMode === 'none';
    // An always-reasoning model reasons regardless, and some hosts 400 on the
    // attempt to switch it off.
    const sendDisable = reasoningOff && model?.reasoningMode !== 'always';
    const keepHistory = !sendDisable && wantsReasoningHistory(options.thinkingKeepTurns);
    // `openrouter` is Chat-Completions-only — this API has its own native
    // `reasoning` field, handled by the effort path below.
    const dialect = resolveReasoningDialect(model, apiDefinition);

    if (dialect === 'thinking-object') {
      const thinking: Record<string, unknown> = { type: sendDisable ? 'disabled' : 'enabled' };
      if (keepHistory && historyParam === 'clear_thinking') thinking.clear_thinking = false;
      if (keepHistory && historyParam === 'thinking_keep') thinking.keep = 'all';
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (requestParams as any)['thinking'] = thinking;
      // `thinking` stays for Ark, but DeepSeek, MiMo and Z.ai ignore it on this
      // API and switch thinking off only through `reasoning.effort: none` (Z.ai
      // merely shortens it). Effort goes there too, never top-level.
      const thinkingEffort = sendDisable ? 'none' : effortBesideToggle(effort, model, reasoningOff);
      if (thinkingEffort) {
        requestParams.reasoning = { effort: thinkingEffort as OpenAI.ReasoningEffort };
      }
      return;
    }

    if (dialect === 'enable-thinking') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (requestParams as any)['enable_thinking'] = !sendDisable;
      if (keepHistory && historyParam === 'preserve_thinking') {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (requestParams as any)['preserve_thinking'] = true;
      }
      // Alibaba still reads `enable_thinking` here, so the switch needs no
      // `none`; the effort ladder (Qwen 3.8) exists only on this API.
      const toggleEffort = effortBesideToggle(effort, model, reasoningOff);
      if (toggleEffort) {
        requestParams.reasoning = { effort: toggleEffort as OpenAI.ReasoningEffort };
      }
      return;
    }

    // Set before the toggle check: an always-reasoning model with the toggle off
    // still reasons at its lowest level, and that reasoning counts as history.
    if (keepHistory && historyParam === 'reasoning_context') {
      requestParams.reasoning = { context: 'all_turns' };
    }

    if (reasoningOff) {
      // Omitting the effort would leave the model at its default.
      const offEffort = effortWhenOff(model);
      if (offEffort) {
        requestParams.reasoning = {
          ...requestParams.reasoning,
          effort: offEffort as OpenAI.ReasoningEffort,
        };
      }
      return;
    }

    const supportedEfforts = model?.supportedReasoningEfforts;

    // Model with reasoning but no configurable effort (e.g., grok-4.20)
    if (!supportedEfforts || supportedEfforts.length === 0) {
      if (model?.reasoningMode === 'always' || model?.reasoningMode === 'optional') {
        requestParams.reasoning = { ...requestParams.reasoning, summary };
      }
      return;
    }

    // Model with configurable reasoning effort. The cast only satisfies the SDK type, which
    // lacks 'max'; gpt-5.6 and gpt-6 list it and the API accepts it.
    const mappedEffort = mapReasoningEffort(
      effort,
      supportedEfforts as Exclude<ReasoningEffort, 'max'>[]
    );
    requestParams.reasoning = { ...requestParams.reasoning, effort: mappedEffort, summary };
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
      if (item.type !== 'function_call') continue;
      const input = parseToolArguments(item.arguments as string | undefined);
      // Arguments cut off by max_output_tokens: never run or replay the call
      if (!input) continue;
      toolUseBlocks.push({
        type: 'tool_use' as const,
        id: item.call_id as string,
        name: item.name as string,
        input,
      });
    }
    return toolUseBlocks;
  }

  /**
   * Get client-side tool definitions for Responses API format.
   * Translates standard definitions to { type: 'function', name, description, parameters, strict: false }
   */
  protected getClientSideTools(
    enabledTools: string[],
    toolOptions: Record<string, ToolOptions> = {}
  ): OpenAI.Responses.Tool[] {
    const standardDefs = this.deps.toolRegistry.getToolDefinitions(enabledTools, toolOptions);

    return standardDefs.map(def => {
      // Check for provider-specific override first
      const override = this.deps.toolRegistry.getToolOverride(
        def.name,
        this.ownFamily,
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
