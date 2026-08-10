/**
 * Google Gemini API Client
 *
 * Implements the APIClient interface for direct Google Gemini API access.
 * Supports streaming, thinking (thinkingBudget/thinkingLevel), Google Search
 * grounding, and function calling via the @google/genai SDK.
 */

import { getProxyConfig } from './proxyConfig';
import {
  GoogleGenAI,
  ServiceTier,
  ThinkingLevel,
  type Content,
  type Part,
  type GenerateContentConfig,
  type ThinkingConfig,
} from '@google/genai';
import type {
  APIDefinition,
  Message,
  Model,
  ReasoningEffort,
  ToolUseBlock,
  ToolOptions,
} from '../../protocol/types';
import type { APIClient, StreamChunk, StreamResult } from './baseClient';
import {
  effectiveInjectionMode,
  buildInlinePrefix,
  buildInlineSuffix,
  buildSeparateBlockText,
  type InjectedFile,
} from './fileInjectionHelper';
import { findCheckpointIndex, findThinkingBoundaryN, tidyAgnosticMessage } from './contextTidy';
import { getModelMetadataFor } from '../../engine/lib/api/modelMetadata';
import { effortWhenOff, mapReasoningEffort } from '../../engine/lib/reasoningEffort';
import type { APIServiceDeps } from './apiService';
import {
  createMapperState,
  mapGoogleChunkToStreamChunks,
  mapGoogleFinishReason,
  extractTextFromParts,
  extractThinkingFromParts,
} from './googleStreamMapper';

/**
 * Google fullContent type — the parts array from a model response.
 */
export type GoogleFullContent = Part[];

/**
 * Combined message tidy: checkpoint filtering, thinking pruning, empty text removal.
 * Single forward pass handles all three concerns with direct access to Google Part types.
 */
function tidyMessages(
  messages: Message<unknown>[],
  checkpointMessageId: string | undefined,
  tidyToolNames: Set<string> | undefined,
  pruneThinking: boolean,
  pruneEmptyText: boolean,
  pruneThinkingKeepTurns: number | undefined
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

    // Wrong modelFamily or missing fullContent — model-agnostic path
    if (msg.content.modelFamily !== 'google' || msg.content.fullContent == null) {
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
        // Drop wrong-modelFamily messages with no content and no tool blocks
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
    let parts = msg.content.fullContent as Part[];

    if (inCheckpoint) {
      const filtered: Part[] = [];
      for (const p of parts) {
        if (p.thought) continue;
        if (isCheckpoint) {
          // Checkpoint message: only thoughts removed, strip thoughtSignature
          if (p.thoughtSignature) {
            const { thoughtSignature: _, ...rest } = p;
            if (Object.keys(rest).length > 0) filtered.push(rest as Part);
          } else {
            filtered.push(p);
          }
          continue;
        }
        if (p.functionCall?.name && toolNames.has(p.functionCall.name)) {
          removedToolUseIds.add(p.functionCall.name);
          continue;
        }
        if (p.functionResponse?.name && removedToolUseIds.has(p.functionResponse.name)) {
          continue;
        }
        // Strip thoughtSignature from kept parts
        if (p.thoughtSignature) {
          const { thoughtSignature: _, ...rest } = p;
          if (Object.keys(rest).length > 0) filtered.push(rest as Part);
        } else {
          filtered.push(p);
        }
      }
      parts = filtered;
    }

    if (inThinking && !inCheckpoint) {
      const stripThinking = pruneThinking || projectPruneActive;
      if (stripThinking) {
        parts = parts.filter(p => !p.thought);
        // Strip thoughtSignature from remaining parts, drop if empty
        parts = parts.reduce<Part[]>((acc, p) => {
          if (!p.thoughtSignature) {
            acc.push(p);
            return acc;
          }
          const { thoughtSignature: _, ...rest } = p;
          if (Object.keys(rest).length > 0) acc.push(rest as Part);
          return acc;
        }, []);
      }
    }

    // Empty text block removal (both checkpoint and thinking ranges)
    if (inThinking && pruneEmptyText) {
      parts = parts.filter(p => {
        if (p.text === undefined || p.thought) return true;
        return p.text.trim().length > 0;
      });
    }

    if (parts.length === 0) continue;
    if (parts !== (msg.content.fullContent as Part[])) {
      result.push({ ...msg, content: { ...msg.content, fullContent: parts } });
    } else {
      result.push(msg);
    }
  }

  for (let i = processUntil + 1; i < messages.length; i++) {
    result.push(messages[i]);
  }

  return result;
}

/**
 * Gemini 2.5 and older take a token `thinkingBudget`; Gemini 3 onward takes
 * `thinkingLevel`, and Gemini 4 Argon 400s on a budget ("Thinking budget is not
 * supported for this model"). Matching the old generations instead of the new
 * ones keeps the next release, and aliases like `gemini-pro-latest`, on levels.
 */
function usesThinkingLevel(modelId: string): boolean {
  return !/gemini-[12]\./.test(modelId);
}

const THINKING_LEVELS: Record<string, ThinkingLevel> = {
  none: ThinkingLevel.THINKING_LEVEL_UNSPECIFIED,
  minimal: ThinkingLevel.MINIMAL,
  low: ThinkingLevel.LOW,
  medium: ThinkingLevel.MEDIUM,
  high: ThinkingLevel.HIGH,
  xhigh: ThinkingLevel.HIGH,
  max: ThinkingLevel.HIGH,
};

/**
 * Pick the `thinkingLevel` for a Gemini 3+ request.
 *
 * Returns undefined when no effort was requested, so the field is omitted and each
 * model's own default applies (MEDIUM on 3.7 Flash, HIGH on 3 Pro). An explicit
 * effort is clamped to what the model advertises: Gemini rejects a level outside a
 * model's range outright — 3.7 Flash fails the request on MINIMAL, for instance.
 */
export function resolveThinkingLevel(
  effort: ReasoningEffort | undefined,
  supportedEfforts: readonly ReasoningEffort[] | undefined
): ThinkingLevel | undefined {
  if (effort === undefined) return undefined;
  if (effort === 'none') return ThinkingLevel.THINKING_LEVEL_UNSPECIFIED;

  const clamped =
    supportedEfforts && supportedEfforts.length > 0
      ? mapReasoningEffort(effort, supportedEfforts)
      : effort;

  return (clamped && THINKING_LEVELS[clamped]) ?? ThinkingLevel.MEDIUM;
}

/** Gemini 2.5 Pro's smallest thinking budget; it can't go to 0. */
const GEMINI_MIN_THINKING_BUDGET = 128;

/**
 * Thinking config for a request with the reasoning toggle off. Most Gemini
 * models think when the config is omitted: 2.5 Flash switches off at budget 0,
 * while 2.5 Pro and every model from Gemini 3 on can't, so they get their smallest
 * budget or lowest level. Unknown and non-thinking models get nothing.
 */
export function resolveThinkingOff(
  modelId: string,
  meta: Pick<Model, 'reasoningMode' | 'supportedReasoningEfforts'>
): ThinkingConfig | undefined {
  if (!meta.reasoningMode || meta.reasoningMode === 'none') return undefined;
  if (usesThinkingLevel(modelId)) {
    const lowest = effortWhenOff(meta);
    const level = lowest && resolveThinkingLevel(lowest, meta.supportedReasoningEfforts);
    return level ? { thinkingLevel: level, includeThoughts: false } : undefined;
  }
  return {
    thinkingBudget: meta.reasoningMode === 'always' ? GEMINI_MIN_THINKING_BUDGET : 0,
    includeThoughts: false,
  };
}

export class GoogleClient implements APIClient {
  protected readonly deps: APIServiceDeps;

  constructor(deps: APIServiceDeps) {
    this.deps = deps;
  }

  async discoverModels(apiDefinition: APIDefinition): Promise<Model[]> {
    const proxy = getProxyConfig(apiDefinition);
    const ai = new GoogleGenAI({
      apiKey: apiDefinition.apiKey,
      httpOptions: proxy
        ? { baseUrl: proxy.baseURL, headers: proxy.headers }
        : apiDefinition.baseUrl
          ? { baseUrl: apiDefinition.baseUrl }
          : undefined,
    });

    const models: Model[] = [];
    const pager = await ai.models.list();

    // Drive pagination ourselves instead of `for await (const m of pager)`. The
    // SDK's Pager.hasNextPage() returns true whenever the response carried any
    // non-undefined nextPageToken — including an empty string. Endpoints (or CORS
    // proxies) that echo `nextPageToken: ""` on the final page make the built-in
    // iterator request the same page forever, tripping Google's per-minute model
    // listing quota (429). Guard with empty/duplicate-token checks + a page cap.
    const MAX_PAGES = 20; // ~1000 models at the default page size; real lists are 1-2 pages
    const seenTokens = new Set<string>();

    for (let pageCount = 1; ; pageCount++) {
      for (const m of pager.page) {
        // Filter for models that support generateContent
        if (!m.supportedActions?.includes('generateContent')) {
          continue;
        }

        // Model name comes as "models/gemini-2.5-flash" — extract the ID part
        const modelId = m.name?.replace(/^models\//, '') ?? '';
        if (!modelId) continue;

        models.push({
          ...getModelMetadataFor(apiDefinition, modelId),
          name: m.displayName || modelId,
        });
      }

      const nextToken = pager.params.config?.pageToken;
      if (!nextToken || seenTokens.has(nextToken)) break;
      if (pageCount >= MAX_PAGES) {
        console.warn(
          `[GoogleClient] model pagination hit the ${MAX_PAGES}-page cap for ${apiDefinition.name}; stopping (likely an empty/looping nextPageToken)`
        );
        break;
      }
      seenTokens.add(nextToken);
      await pager.nextPage();
    }

    console.debug(`[GoogleClient] Discovered ${models.length} models for ${apiDefinition.name}`);
    return models;
  }

  shouldPrependPrefill(_apiDefinition: APIDefinition): boolean {
    return false;
  }

  async *sendMessageStream(
    messages: Message<GoogleFullContent>[],
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
      systemPrompt?: string;
      preFillResponse?: string;
      webSearchEnabled?: boolean;
      enabledTools?: string[];
      toolOptions?: Record<string, ToolOptions>;
      disableStream?: boolean;
      signal: AbortSignal;
      checkpointMessageId?: string;
      tidyToolNames?: Set<string>;
      flexTierEnabled?: boolean;
    }
  ): AsyncGenerator<StreamChunk, StreamResult<GoogleFullContent>, unknown> {
    try {
      const proxy = getProxyConfig(apiDefinition);
      const ai = new GoogleGenAI({
        apiKey: apiDefinition.apiKey,
        httpOptions: proxy
          ? { baseUrl: proxy.baseURL, headers: proxy.headers }
          : apiDefinition.baseUrl
            ? { baseUrl: apiDefinition.baseUrl }
            : undefined,
      });

      // Tidy messages: checkpoint filtering, thinking pruning, empty text removal
      const tidiedMessages = tidyMessages(
        messages,
        options.checkpointMessageId,
        options.tidyToolNames,
        apiDefinition.advancedSettings?.pruneThinking ?? false,
        apiDefinition.advancedSettings?.pruneEmptyText ?? false,
        options.pruneThinkingKeepTurns
      ) as typeof messages;

      // Convert messages to Google Content[] format
      const contents = this.convertMessages(tidiedMessages);

      // Build config
      const config: GenerateContentConfig = {
        maxOutputTokens: options.maxTokens,
        abortSignal: options.signal,
        ...(options.flexTierEnabled ? { serviceTier: ServiceTier.FLEX } : null),
      };

      // Temperature (omit for reasoning models when reasoning is enabled)
      if (options.temperature !== undefined && !options.enableReasoning) {
        config.temperature = options.temperature;
      }

      // System instruction
      if (options.systemPrompt) {
        config.systemInstruction = options.systemPrompt;
      }

      // Thinking configuration
      if (options.enableReasoning) {
        if (usesThinkingLevel(modelId)) {
          const level = resolveThinkingLevel(
            options.reasoningEffort,
            getModelMetadataFor(apiDefinition, modelId).supportedReasoningEfforts
          );
          config.thinkingConfig = {
            ...(level ? { thinkingLevel: level } : null),
            includeThoughts: true,
          };
        } else {
          config.thinkingConfig = {
            thinkingBudget: options.reasoningBudgetTokens,
            includeThoughts: true,
          };
        }
      } else {
        const offConfig = resolveThinkingOff(modelId, getModelMetadataFor(apiDefinition, modelId));
        if (offConfig) config.thinkingConfig = offConfig;
      }

      // Tools — function declarations and Google Search
      const tools: GenerateContentConfig['tools'] = [];

      // Client-side tool definitions
      const enabledTools = options.enabledTools ?? [];
      const toolOpts = options.toolOptions ?? {};
      const standardDefs = this.deps.toolRegistry.getToolDefinitions(enabledTools, toolOpts);

      if (standardDefs.length > 0) {
        const functionDeclarations = standardDefs.map(def => {
          // Check for provider-specific override
          const override = this.deps.toolRegistry.getToolOverride(
            def.name,
            'google',
            toolOpts[def.name] ?? {}
          );
          if (override) {
            return override as {
              name: string;
              description: string;
              parametersJsonSchema?: unknown;
            };
          }
          return {
            name: def.name,
            description: def.description,
            parametersJsonSchema: def.input_schema,
          };
        });
        tools.push({ functionDeclarations });
      }

      // Google Search grounding
      if (options.webSearchEnabled) {
        tools.push({ googleSearch: {} });
      }

      if (tools.length > 0) {
        config.tools = tools;
      }

      // Call the API
      const streamResponse = await ai.models.generateContentStream({
        model: modelId,
        contents,
        config,
      });

      // Process stream
      let mapperState = createMapperState();
      const allParts: Part[] = [];
      let lastFinishReason: string | undefined;
      let blockReason: string | undefined;
      let servedModel: string | undefined;

      for await (const chunk of streamResponse) {
        if (chunk.modelVersion) {
          servedModel = chunk.modelVersion;
        }
        const result = mapGoogleChunkToStreamChunks(chunk, mapperState);
        mapperState = result.state;

        for (const streamChunk of result.chunks) {
          yield streamChunk;
        }

        // Accumulate parts for fullContent
        const candidateParts = chunk.candidates?.[0]?.content?.parts;
        if (candidateParts) {
          allParts.push(...candidateParts.filter(p => Object.keys(p).length > 0));
        }

        // Track finish reason
        const fr = chunk.candidates?.[0]?.finishReason;
        if (fr && fr !== 'FINISH_REASON_UNSPECIFIED') {
          lastFinishReason = fr;
        }
        if (chunk.promptFeedback?.blockReason) {
          blockReason = chunk.promptFeedback.blockReason;
        }
      }

      const textContent = extractTextFromParts(allParts);
      const thinkingContent = extractThinkingFromParts(allParts);

      // A blocked prompt gets no candidates, so no finish reason either.
      // Calls from a cut-off stream never ran; replaying them without
      // responses would 400.
      if (blockReason || !lastFinishReason) {
        return {
          textContent,
          thinkingContent,
          hasCoT: !!thinkingContent,
          fullContent: allParts.filter(p => !p.functionCall),
          error: {
            message: blockReason
              ? `Prompt blocked: ${blockReason}`
              : 'Stream ended before a finishReason arrived',
          },
          servedModel,
          inputTokens: mapperState.inputTokens,
          outputTokens: mapperState.outputTokens,
          reasoningTokens: mapperState.thoughtsTokens || undefined,
          cacheReadTokens: mapperState.cacheReadTokens || undefined,
        };
      }

      // Gemini returns STOP for function calls (no distinct finish reason),
      // so detect function call parts and override to 'tool_use' for the agentic
      // loop. Any other reason (MAX_TOKENS, SAFETY, ...) wins over the calls.
      const hasFunctionCalls = allParts.some(p => p.functionCall?.name);

      return {
        textContent,
        thinkingContent,
        hasCoT: !!thinkingContent,
        fullContent: allParts,
        stopReason:
          hasFunctionCalls && lastFinishReason === 'STOP'
            ? 'tool_use'
            : mapGoogleFinishReason(lastFinishReason),
        servedModel,
        inputTokens: mapperState.inputTokens,
        outputTokens: mapperState.outputTokens,
        reasoningTokens: mapperState.thoughtsTokens || undefined,
        cacheReadTokens: mapperState.cacheReadTokens || undefined,
      };
    } catch (error: unknown) {
      let errorMessage = 'Unknown error';
      let errorStatus: number | undefined;
      let errorStack: string | undefined;

      if (error && typeof error === 'object') {
        if ('status' in error) {
          errorStatus = Number(error.status);
        }
        if ('message' in error) {
          errorMessage = String(error.message);
        }
        if (error instanceof Error) {
          errorStack = error.stack;
        }

        if (errorStatus === 401 || errorStatus === 403) {
          errorMessage = 'Invalid API key. Please check your Google API key in settings.';
        } else if (errorStatus === 429) {
          errorMessage = 'Rate limit exceeded. Please try again later.';
        } else if (errorStatus === 500 || errorStatus === 502 || errorStatus === 503) {
          errorMessage = 'Google API is currently unavailable. Please try again later.';
        }
      }

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

  extractToolUseBlocks(fullContent: unknown): ToolUseBlock[] {
    if (!Array.isArray(fullContent)) return [];

    const blocks: ToolUseBlock[] = [];
    for (const part of fullContent as Part[]) {
      if (part.functionCall?.name) {
        blocks.push({
          type: 'tool_use',
          id: part.functionCall.id!,
          name: part.functionCall.name,
          input: (part.functionCall.args as Record<string, unknown>) ?? {},
        });
      }
    }
    return blocks;
  }

  /**
   * Convert internal messages to Google Content[] format.
   */
  private convertMessages(messages: Message<GoogleFullContent>[]): Content[] {
    return messages.map(msg => {
      // Use fullContent if available and from Google
      if (msg.content.modelFamily === 'google' && msg.content.fullContent) {
        return {
          role: msg.role === 'user' ? 'user' : 'model',
          parts: (msg.content.fullContent as Part[]).filter(p => Object.keys(p).length > 0),
        };
      }

      // Cross-model reconstruction: assistant with tool calls
      if (msg.role === 'assistant' && msg.content.toolCalls?.length) {
        const parts: Part[] = [];
        if (msg.content.content.trim()) {
          parts.push({ text: msg.content.content });
        }
        for (const tc of msg.content.toolCalls) {
          parts.push({
            functionCall: { name: tc.name, args: tc.input },
          } as Part);
        }
        return { role: 'model' as const, parts };
      }

      // Cross-model reconstruction: user with tool results
      if (msg.role === 'user' && msg.content.toolResults?.length) {
        const parts: Part[] = msg.content.toolResults.map(
          tr =>
            ({
              functionResponse: {
                id: tr.tool_use_id,
                name: tr.name ?? 'unknown',
                response: { content: tr.content },
              },
            }) as Part
        );
        return { role: 'user' as const, parts };
      }

      // Fall back to text + attachments
      const parts: Part[] = [];

      // Add image attachments for user messages
      if (msg.role === 'user' && msg.attachments?.length) {
        for (const attachment of msg.attachments) {
          parts.push({
            inlineData: {
              mimeType: attachment.mimeType,
              data: attachment.data,
            },
          });
        }
      }

      // Add injected file blocks (Google falls back as-file → separate-block).
      // `injectedFiles` goes before the text part, `injectedFilesAfter` after it.
      const pushInjectedFiles = (files: InjectedFile[] | undefined, trailing: boolean) => {
        if (!files?.length || !msg.content.injectionMode) return;
        const mode = effectiveInjectionMode(msg.content.injectionMode, 'google');
        if (mode === 'separate-block') {
          for (const file of files) {
            parts.push({ text: buildSeparateBlockText(file) });
          }
        } else if (mode === 'inline') {
          // Inline fallback: files as one text part on the message's own side
          parts.push({ text: trailing ? buildInlineSuffix(files) : buildInlinePrefix(files) });
        }
      };
      pushInjectedFiles(msg.content.injectedFiles, false);

      // Add text content
      if (msg.content.content.trim()) {
        parts.push({ text: msg.content.content });
      }

      pushInjectedFiles(msg.content.injectedFilesAfter, true);

      return {
        role: msg.role === 'user' ? 'user' : 'model',
        parts,
      };
    });
  }
}
