/**
 * Bedrock Converse API Client
 *
 * Implements the APIClient interface for AWS Bedrock using the Converse API.
 * Supports both streaming (ConverseStreamCommand) and non-streaming (ConverseCommand) modes.
 */

import {
  BedrockRuntimeClient,
  ConverseCommand,
  ConverseStreamCommand,
  type ContentBlock,
  type Message as BedrockMessage,
  type Tool,
  type SystemContentBlock,
  type ToolConfiguration,
} from '@aws-sdk/client-bedrock-runtime';
import type { DocumentType } from '@smithy/types';
import {
  BedrockClient as BedrockControlPlaneClient,
  ListFoundationModelsCommand,
  ListInferenceProfilesCommand,
  ListImportedModelsCommand,
  ListCustomModelsCommand,
  type FoundationModelSummary,
} from '@aws-sdk/client-bedrock';

import type {
  APIDefinition,
  Message,
  Model,
  ReasoningEffort,
  ToolUseBlock,
  ToolOptions,
} from '../../protocol/types';
import type { APIClient, StreamChunk, StreamResult } from './baseClient';
import { effectiveInjectionMode } from './fileInjectionHelper';
import { findCheckpointIndex, findThinkingBoundary, tidyAgnosticMessage } from './contextTidy';
import { getModelMetadataFor } from '../../engine/lib/api/modelMetadata';
import type { APIServiceDeps } from './apiService';
import {
  createMapperState,
  mapBedrockStreamEvent,
  convertConverseResponseToStreamChunks,
  extractContentFromResponse,
} from './bedrockStreamMapper';
import { BedrockFullContentAccumulator } from './bedrockFullContentAccumulator';

// Default region for Bedrock - can be overridden via baseUrl
const DEFAULT_REGION = 'us-east-1';

/**
 * Parse baseUrl to extract region and determine endpoint URLs.
 * Supports shorthand formats for convenience:
 * - "us-west-2" - Just the region
 * - "bedrock:us-west-2" - Explicit bedrock prefix
 * - "https://bedrock-runtime.us-west-2.amazonaws.com" - Full URL
 */
function parseBedrockEndpoint(baseUrl: string | undefined): {
  region: string;
  runtimeUrl: string | undefined;
  controlPlaneUrl: string | undefined;
} {
  if (!baseUrl) {
    return { region: DEFAULT_REGION, runtimeUrl: undefined, controlPlaneUrl: undefined };
  }

  // Shorthand format: "bedrock:us-east-2"
  const shorthandMatch = baseUrl.match(/^bedrock:([a-z0-9-]+)$/i);
  if (shorthandMatch) {
    return {
      region: shorthandMatch[1],
      runtimeUrl: undefined, // Let SDK generate URL
      controlPlaneUrl: undefined,
    };
  }

  // Region-only format: "us-west-2" (AWS region pattern)
  const regionOnlyMatch = baseUrl.match(/^([a-z]{2}-[a-z]+-\d+)$/i);
  if (regionOnlyMatch) {
    return {
      region: regionOnlyMatch[1],
      runtimeUrl: undefined, // Let SDK generate URL
      controlPlaneUrl: undefined,
    };
  }

  // Full URL format: "https://bedrock-runtime.us-east-2.amazonaws.com"
  const urlMatch = baseUrl.match(/bedrock-runtime\.([a-z0-9-]+)\.amazonaws\.com/i);
  if (urlMatch) {
    return {
      region: urlMatch[1],
      runtimeUrl: baseUrl,
      controlPlaneUrl: baseUrl.replace('bedrock-runtime', 'bedrock'),
    };
  }

  // Fallback: treat as custom endpoint, use default region
  return { region: DEFAULT_REGION, runtimeUrl: baseUrl, controlPlaneUrl: undefined };
}

/**
 * Bedrock model types for reasoning configuration.
 * Different model families require different reasoning config formats.
 */
type BedrockModelReasoningType =
  | 'claude-3'
  | 'claude-4'
  | 'nova2'
  | 'deepseek'
  | 'generic-reasoning'
  | 'none';

/**
 * Detect the reasoning type of a Bedrock model from its modelId.
 * Handles both raw modelId and inference profile formats.
 */
export function detectBedrockReasoningType(modelId: string): BedrockModelReasoningType {
  const normalizedId = modelId.toLowerCase();

  // Claude detection - check for anthropic. prefix (handles both raw modelId and inference profiles)
  if (normalizedId.includes('anthropic.')) {
    if (normalizedId.includes('claude-3-')) {
      return 'claude-3';
    }
    return 'claude-4';
  }

  // Nova detection - matches amazon.nova-* variants
  if (normalizedId.includes('amazon.nova-2')) {
    return 'nova2';
  }

  // DeepSeek detection
  if (normalizedId.includes('deepseek.r1')) {
    return 'deepseek';
  }

  // Kimi
  if (
    normalizedId.includes('kimi') ||
    normalizedId.includes('nvidia') ||
    normalizedId.includes('qwen') ||
    normalizedId.includes('glm') ||
    normalizedId.includes('deepseek')
  ) {
    return 'generic-reasoning';
  }

  return 'none';
}

/**
 * Map our ReasoningEffort type to Nova's maxReasoningEffort.
 * Nova only supports 'low', 'medium', 'high'.
 */
function mapEffortToNova(effort: ReasoningEffort | undefined): 'low' | 'medium' | 'high' {
  switch (effort) {
    case 'none':
    case 'minimal':
    case 'low':
      return 'low';
    case 'medium':
    case undefined:
      return 'medium';
    case 'high':
    case 'xhigh':
      return 'high';
  }
}

function mapEffort(effort: ReasoningEffort | undefined): 'low' | 'medium' | 'high' {
  switch (effort) {
    case 'none':
    case 'minimal':
    case 'low':
      return 'low';
    case 'medium':
    case undefined:
      return 'medium';
    case 'high':
    case 'xhigh':
      return 'high';
  }
}

/**
 * Build the appropriate reasoning configuration for a Bedrock model.
 * Returns undefined if reasoning should not be enabled.
 *
 * @param modelType - The detected model reasoning type
 * @param options - Stream options containing reasoning settings
 * @returns DocumentType for additionalModelRequestFields, or undefined
 */
export function buildReasoningConfig(
  modelType: BedrockModelReasoningType,
  options: {
    enableReasoning: boolean;
    reasoningBudgetTokens: number;
    reasoningEffort?: ReasoningEffort;
    thinkingKeepTurns?: number; // undefined = model default, -1 = all, 0+ = thinking_turns
  }
): DocumentType | undefined {
  if (!options.enableReasoning || modelType === 'none') {
    return undefined;
  }

  switch (modelType) {
    case 'claude-3':
      // Claude 3.x uses thinking config
      return {
        thinking: {
          type: 'enabled',
          budget_tokens: options.reasoningBudgetTokens,
        },
      } as DocumentType;

    case 'claude-4': {
      // Claude 4+ uses reasoning_config
      // Calculate keep value from thinkingKeepTurns:
      // undefined = model default (all), -1 = all, 0+ = thinking_turns
      const keepValue =
        options.thinkingKeepTurns === undefined || options.thinkingKeepTurns === -1
          ? { type: 'all' }
          : { type: 'thinking_turns', value: options.thinkingKeepTurns };
      return {
        reasoning_config: {
          type: 'enabled',
          budget_tokens: options.reasoningBudgetTokens,
        },
        anthropic_beta: ['interleaved-thinking-2025-05-14', 'context-management-2025-06-27'],
        context_management: {
          edits: [
            {
              type: 'clear_thinking_20251015',
              keep: keepValue,
            },
          ],
        },
      } as DocumentType;
    }

    case 'nova2':
      // Nova uses reasoningConfig with maxReasoningEffort
      return {
        reasoningConfig: {
          type: 'enabled',
          maxReasoningEffort: mapEffortToNova(options.reasoningEffort),
        },
      } as DocumentType;

    case 'generic-reasoning':
      // Nova uses reasoningConfig with maxReasoningEffort
      return {
        reasoning_config: mapEffort(options.reasoningEffort),
      } as DocumentType;

    case 'deepseek':
      // DeepSeek uses showThinking boolean
      return {
        reasoning_config: mapEffort(options.reasoningEffort),
        showThinking: true,
      } as DocumentType;
    default:
      return undefined;
  }
}

/**
 * Convert base64 string back to Uint8Array for SDK
 */
function base64ToUint8Array(base64: string): Uint8Array {
  const binaryStr = atob(base64);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    bytes[i] = binaryStr.charCodeAt(i);
  }
  return bytes;
}

/**
 * Bedrock fullContent type - array of ContentBlock
 */
export type BedrockFullContent = ContentBlock[];

/**
 * Combined message tidy: checkpoint filtering, thinking pruning, empty text removal.
 * Single forward pass with direct access to Bedrock Converse block types.
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

    if (msg.content.modelFamily !== 'bedrock' || msg.content.fullContent == null) {
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

    let blocks = msg.content.fullContent as {
      reasoningContent?: unknown;
      text?: string;
      toolUse?: { name?: string; toolUseId?: string };
      toolResult?: { toolUseId?: string };
    }[];

    if (inCheckpoint) {
      const filtered: typeof blocks = [];
      for (const b of blocks) {
        if (b.reasoningContent) continue;
        if (isCheckpoint) {
          filtered.push(b);
          continue;
        }
        if (b.toolUse?.name && toolNames.has(b.toolUse.name)) {
          if (b.toolUse.toolUseId) removedToolUseIds.add(b.toolUse.toolUseId);
          continue;
        }
        if (b.toolResult?.toolUseId && removedToolUseIds.has(b.toolResult.toolUseId)) {
          continue;
        }
        filtered.push(b);
      }
      blocks = filtered;
    }

    if (inThinking && !inCheckpoint && pruneThinking) {
      blocks = blocks.filter(b => !b.reasoningContent);
    }

    if (inThinking && pruneEmptyText) {
      blocks = blocks.filter(b => {
        if (typeof b.text !== 'string') return true;
        if (b.toolUse || b.reasoningContent) return true;
        return b.text.trim().length > 0;
      });
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

export class BedrockClient implements APIClient {
  protected readonly deps: APIServiceDeps;

  constructor(deps: APIServiceDeps) {
    this.deps = deps;
  }

  /**
   * Discover available models from Bedrock.
   *
   * Fetches from multiple sources:
   * 1. Foundation models (on-demand) in the primary region
   * 2. Inference profiles (cross-region capable)
   * 3. Imported models (user-imported custom weights)
   * 4. Custom models (fine-tuned/distilled models)
   *
   * For cross-region inference profiles, fetches foundation models from
   * referenced regions to get accurate modality information.
   */
  async discoverModels(apiDefinition: APIDefinition): Promise<Model[]> {
    const { region: primaryRegion, controlPlaneUrl } = parseBedrockEndpoint(apiDefinition.baseUrl);

    // Create control plane client for model discovery
    const createClient = (region: string) =>
      new BedrockControlPlaneClient({
        region,
        ...(apiDefinition.apiKey && {
          token: { token: apiDefinition.apiKey },
          authSchemePreference: ['httpBearerAuth'],
        }),
        // Only set custom endpoint for primary region (other regions use default AWS endpoints)
        ...(region === primaryRegion && controlPlaneUrl && { endpoint: controlPlaneUrl }),
      });

    const primaryClient = createClient(primaryRegion);

    try {
      // Phase 1: Fetch foundation models, inference profiles, imported and custom models in parallel
      const [modelsResponse, profilesResponse, importedResponse, customResponse] =
        await Promise.all([
          primaryClient.send(new ListFoundationModelsCommand({})),
          primaryClient.send(new ListInferenceProfilesCommand({})),
          primaryClient.send(new ListImportedModelsCommand({})).catch(err => {
            console.debug('[BedrockClient] ListImportedModels failed (may not be supported):', err);
            return { modelSummaries: [] };
          }),
          primaryClient.send(new ListCustomModelsCommand({ modelStatus: 'Active' })).catch(err => {
            console.debug('[BedrockClient] ListCustomModels failed (may not be supported):', err);
            return { modelSummaries: [] };
          }),
        ]);

      console.debug(`[BedrockClient] Foundation models for ${apiDefinition.name}:`, modelsResponse);
      console.debug(
        `[BedrockClient] Inference profiles for ${apiDefinition.name}:`,
        profilesResponse
      );
      console.debug(`[BedrockClient] Imported models for ${apiDefinition.name}:`, importedResponse);
      console.debug(`[BedrockClient] Custom models for ${apiDefinition.name}:`, customResponse);

      // Build modelArn → model map from primary region foundation models
      const arnToModel = new Map<string, FoundationModelSummary>();
      const arnCurrentRegion = new Set<string>();
      const models: Model[] = [];

      for (const m of modelsResponse.modelSummaries ?? []) {
        if (m.modelId && m.modelArn && m.modelLifecycle?.status !== 'LEGACY') {
          arnCurrentRegion.add(m.modelArn);
          if (m.outputModalities?.includes('TEXT')) {
            arnToModel.set(m.modelArn, m);
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
      }

      // Phase 2: Collect regions referenced by inference profiles that we don't have yet
      const regionsNeeded = new Set<string>();
      outer_p2: for (const profile of profilesResponse.inferenceProfileSummaries ?? []) {
        // If the profile contains a model in current region, skip the profile.
        for (const profileModel of profile.models ?? []) {
          if (profileModel.modelArn && arnCurrentRegion.has(profileModel.modelArn)) {
            continue outer_p2;
          }
        }

        for (const profileModel of profile.models ?? []) {
          const arn = profileModel.modelArn;
          // ARN format: arn:aws:bedrock:{region}::foundation-model/{modelId}
          const regionMatch = arn?.match(/^arn:aws:bedrock:([a-z0-9-]+):/);
          if (regionMatch && regionMatch[1] !== primaryRegion) {
            // Check if we already have this ARN
            if (!arnToModel.has(arn!)) {
              regionsNeeded.add(regionMatch[1]);
            }
          }
        }
      }

      // Phase 3: Fetch foundation models from other regions in parallel
      if (regionsNeeded.size > 0) {
        console.debug(
          `[BedrockClient] Fetching models from cross-region:`,
          Array.from(regionsNeeded)
        );

        const otherRegionResults = await Promise.allSettled(
          Array.from(regionsNeeded).map(async otherRegion => {
            const otherClient = createClient(otherRegion);
            const response = await otherClient.send(new ListFoundationModelsCommand({}));
            return { region: otherRegion, models: response.modelSummaries ?? [] };
          })
        );

        // Add successfully fetched models to the map
        for (const result of otherRegionResults) {
          if (result.status === 'fulfilled') {
            for (const m of result.value.models) {
              if (
                m.modelId &&
                m.modelArn &&
                m.outputModalities?.includes('TEXT') &&
                m.modelLifecycle?.status !== 'LEGACY'
              ) {
                arnToModel.set(m.modelArn, m);
              }
            }
          } else {
            console.debug('[BedrockClient] Failed to fetch from a region:', result.reason);
          }
        }
      }

      // Phase 4: Create Model entries from inference profiles (one entry per profile)
      outer_p4: for (const profile of profilesResponse.inferenceProfileSummaries ?? []) {
        if (!profile.inferenceProfileId || profile.status !== 'ACTIVE') continue;
        for (const profileModel of profile.models ?? []) {
          if (profileModel.modelArn && arnCurrentRegion.has(profileModel.modelArn)) {
            const foundModel = arnToModel.get(profileModel.modelArn ?? '');
            if (foundModel?.modelId) {
              models.push({
                ...getModelMetadataFor(apiDefinition, foundModel.modelId),
                id: profile.inferenceProfileId,
                name: profile.inferenceProfileName || profile.inferenceProfileId,
                baseModelId: foundModel.modelId,
              });
              continue outer_p4;
            }
          }
        }

        // Collect regions and find base model from inner loop
        const regions: string[] = [];
        let baseModel: FoundationModelSummary | undefined;
        for (const profileModel of profile.models ?? []) {
          const foundModel = arnToModel.get(profileModel.modelArn ?? '');
          if (foundModel?.modelId) {
            baseModel ??= foundModel; // Take first valid base model for metadata
            const regionMatch = profileModel.modelArn?.match(/^arn:aws:bedrock:([a-z0-9-]+):/);
            if (regionMatch?.[1]) regions.push(regionMatch[1]);
          }
        }

        if (baseModel?.modelId) {
          models.push({
            ...getModelMetadataFor(apiDefinition, baseModel.modelId),
            id: profile.inferenceProfileId,
            name: profile.inferenceProfileName || profile.inferenceProfileId,
            baseModelId: baseModel.modelId,
            region: regions,
          });
        }
      }

      // Phase 5: Add imported models (primary region only)
      for (const m of importedResponse.modelSummaries ?? []) {
        if (m.modelArn && m.modelName) {
          // Imported models use ARN as the ID for inference
          // instructSupported indicates if it's a text model (chat-capable)
          if (m.instructSupported !== false) {
            models.push({
              ...getModelMetadataFor(apiDefinition, m.modelName),
              id: m.modelArn,
              name: `[Imported] ${m.modelName}`,
              baseModelId: m.modelArchitecture || m.modelName,
            });
          }
        }
      }

      // Phase 6: Add custom models (primary region only)
      for (const m of customResponse.modelSummaries ?? []) {
        if (m.modelArn && m.modelName) {
          // Use baseModelArn to look up the base model for metadata
          const baseModel = arnToModel.get(m.baseModelArn ?? '');
          const baseModelId = baseModel?.modelId || m.baseModelName || m.modelName;

          models.push({
            ...getModelMetadataFor(apiDefinition, baseModelId),
            id: m.modelArn,
            name: `[Custom] ${m.modelName}`,
            baseModelId,
          });
        }
      }

      // Sort by base model ID first, then by full ID for consistent ordering
      models.sort((a, b) => {
        const baseA = a.baseModelId ?? a.id;
        const baseB = b.baseModelId ?? b.id;
        const baseCompare = baseA.localeCompare(baseB);
        if (baseCompare !== 0) return baseCompare;
        return a.id.localeCompare(b.id);
      });

      console.debug(`[BedrockClient] Discovered ${models.length} models for ${apiDefinition.name}`);
      return models;
    } catch (error) {
      console.warn('[BedrockClient] Failed to discover models, using fallback:', error);
      return [];
    }
  }

  shouldPrependPrefill(_apiDefinition: APIDefinition): boolean {
    // Bedrock doesn't use prefill in the same way as direct Anthropic API
    return false;
  }

  /**
   * Send message with streaming using ConverseStreamCommand
   */
  async *sendMessageStream(
    messages: Message<BedrockFullContent>[],
    modelId: string,
    apiDefinition: APIDefinition,
    options: {
      temperature?: number;
      maxTokens: number;
      enableReasoning: boolean;
      reasoningBudgetTokens: number;
      thinkingKeepTurns?: number;
      reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
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
    }
  ): AsyncGenerator<StreamChunk, StreamResult<BedrockFullContent>, unknown> {
    try {
      const { region, runtimeUrl } = parseBedrockEndpoint(apiDefinition.baseUrl);

      // Create runtime client for inference
      const runtimeClient = new BedrockRuntimeClient({
        region,
        ...(apiDefinition.apiKey && {
          token: { token: apiDefinition.apiKey },
          authSchemePreference: ['httpBearerAuth'],
        }),
        ...(runtimeUrl && { endpoint: runtimeUrl }),
      });

      // Tidy messages: checkpoint filtering, thinking pruning, empty text removal
      const tidiedMessages = tidyMessages(
        messages,
        options.checkpointMessageId,
        options.tidyToolNames,
        apiDefinition.advancedSettings?.pruneThinking ?? false,
        apiDefinition.advancedSettings?.pruneEmptyText ?? false
      ) as typeof messages;

      // Convert messages to Bedrock format
      const bedrockMessages = this.convertMessages(tidiedMessages);

      // Build tool config
      const toolConfig = this.buildToolConfig(options.enabledTools, options.toolOptions);

      // Build system prompt
      const systemPrompt: SystemContentBlock[] | undefined = options.systemPrompt
        ? [{ text: options.systemPrompt }]
        : undefined;

      // Build inference config
      const inferenceConfig = {
        maxTokens: options.maxTokens,
        ...(options.temperature !== undefined && { temperature: options.temperature }),
      };

      // Detect model reasoning type and build appropriate config
      const modelReasoningType = detectBedrockReasoningType(modelId);
      const additionalModelRequestFields = buildReasoningConfig(modelReasoningType, options);

      // Use non-streaming if requested
      if (options.disableStream) {
        return yield* this.sendMessageNonStreaming(
          runtimeClient,
          modelId,
          bedrockMessages,
          systemPrompt,
          toolConfig,
          inferenceConfig,
          additionalModelRequestFields,
          options.signal
        );
      }

      // Streaming path
      const command = new ConverseStreamCommand({
        modelId,
        messages: bedrockMessages,
        system: systemPrompt,
        ...(toolConfig && { toolConfig }),
        inferenceConfig,
        ...(additionalModelRequestFields && { additionalModelRequestFields }),
      });

      const response = await runtimeClient.send(command, { abortSignal: options.signal });

      if (!response.stream) {
        throw new Error('No stream in response');
      }

      // Track state during streaming using the mapper and accumulator
      const accumulator = new BedrockFullContentAccumulator();
      let inputTokens = 0;
      let outputTokens = 0;
      let cacheReadTokens: number | undefined;
      let cacheCreationTokens: number | undefined;
      let stopReason: string | undefined;
      let mapperState = createMapperState();

      for await (const event of response.stream) {
        console.log(JSON.stringify(event));
        // Feed raw event to accumulator for fullContent assembly
        accumulator.pushRawEvent(event);

        // Map event to StreamChunks for rendering
        const result = mapBedrockStreamEvent(event, mapperState);
        mapperState = result.newState;

        // Yield chunks for UI rendering
        for (const chunk of result.chunks) {
          yield chunk;

          if (chunk.type === 'token_usage') {
            inputTokens = chunk.inputTokens ?? inputTokens;
            outputTokens = chunk.outputTokens ?? outputTokens;
            cacheReadTokens = chunk.cacheReadTokens ?? cacheReadTokens;
            cacheCreationTokens = chunk.cacheCreationTokens ?? cacheCreationTokens;
          }
        }

        // Track stop reason
        if (result.stopReason) {
          stopReason = result.stopReason;
        }
      }

      // Finalize and return accumulated content
      const fullContent = accumulator.finalize();

      return {
        textContent: accumulator.getTextContent(),
        thinkingContent: accumulator.getThinkingContent(),
        hasCoT: accumulator.hasReasoning(),
        fullContent,
        stopReason,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheCreationTokens,
      };
    } catch (error: unknown) {
      return this.handleError(error);
    }
  }

  /**
   * Non-streaming path using ConverseCommand.
   * Uses mapper helpers for consistent chunk conversion.
   */
  private async *sendMessageNonStreaming(
    client: BedrockRuntimeClient,
    modelId: string,
    messages: BedrockMessage[],
    system: SystemContentBlock[] | undefined,
    toolConfig: ToolConfiguration | undefined,
    inferenceConfig: { maxTokens: number; temperature?: number },
    additionalModelRequestFields: DocumentType | undefined,
    signal: AbortSignal
  ): AsyncGenerator<StreamChunk, StreamResult<BedrockFullContent>, unknown> {
    const command = new ConverseCommand({
      modelId,
      messages,
      system,
      ...(toolConfig && { toolConfig }),
      inferenceConfig,
      ...(additionalModelRequestFields && { additionalModelRequestFields }),
    });

    const response = await client.send(command, { abortSignal: signal });

    // Convert response to stream chunks using the mapper helper
    const chunks = convertConverseResponseToStreamChunks(response);
    for (const chunk of chunks) {
      yield chunk;
    }

    // Extract content for the result
    const { textContent, thinkingContent } = extractContentFromResponse(response);
    const outputContent = response.output?.message?.content || [];
    const usage = response.usage;

    return {
      textContent,
      thinkingContent,
      hasCoT: outputContent.some(b => 'reasoningContent' in b && b.reasoningContent !== undefined),
      fullContent: outputContent,
      stopReason: response.stopReason,
      inputTokens: usage?.inputTokens ?? 0,
      outputTokens: usage?.outputTokens ?? 0,
      cacheReadTokens: usage?.cacheReadInputTokens,
      cacheCreationTokens: usage?.cacheWriteInputTokens,
    };
  }

  /**
   * Convert our message format to Bedrock format.
   * Handles base64�Uint8Array conversion for fields stored as base64 for JSON serialization.
   */
  private convertMessages(messages: Message<BedrockFullContent>[]): BedrockMessage[] {
    return messages.map(msg => {
      // Use fullContent if available and from Bedrock
      if (msg.content.modelFamily === 'bedrock' && msg.content.fullContent) {
        // Transform fullContent to convert base64 strings back to Uint8Array where needed
        const transformedContent = this.transformContentForApi(msg.content.fullContent);
        return {
          role: msg.role === 'user' ? ('user' as const) : ('assistant' as const),
          content: transformedContent,
        };
      }

      // Cross-model reconstruction: assistant with tool calls
      if (msg.role === 'assistant' && msg.content.toolCalls?.length) {
        const contentBlocks: ContentBlock[] = [];
        if (msg.content.content.trim()) {
          contentBlocks.push({ text: msg.content.content });
        }
        for (const tc of msg.content.toolCalls) {
          contentBlocks.push({
            toolUse: {
              toolUseId: tc.id,
              name: tc.name,
              input: tc.input as DocumentType,
            },
          });
        }
        return { role: 'assistant' as const, content: contentBlocks };
      }

      // Cross-model reconstruction: user with tool results
      if (msg.role === 'user' && msg.content.toolResults?.length) {
        const contentBlocks: ContentBlock[] = msg.content.toolResults.map(tr => ({
          toolResult: {
            toolUseId: tr.tool_use_id,
            content: [{ text: tr.content }],
            status: tr.is_error ? ('error' as const) : ('success' as const),
          },
        }));
        return { role: 'user' as const, content: contentBlocks };
      }

      // Fall back to text content
      const contentBlocks: ContentBlock[] = [];

      // Add image blocks if attachments present
      if (msg.role === 'user' && msg.attachments?.length) {
        for (const attachment of msg.attachments) {
          // Convert base64 to Uint8Array
          const binaryStr = atob(attachment.data);
          const bytes = new Uint8Array(binaryStr.length);
          for (let i = 0; i < binaryStr.length; i++) {
            bytes[i] = binaryStr.charCodeAt(i);
          }

          // Map MIME type to Bedrock format
          const formatMap: Record<string, 'jpeg' | 'png' | 'gif' | 'webp'> = {
            'image/jpeg': 'jpeg',
            'image/png': 'png',
            'image/gif': 'gif',
            'image/webp': 'webp',
          };

          contentBlocks.push({
            image: {
              format: formatMap[attachment.mimeType] || 'jpeg',
              source: { bytes },
            },
          });
        }
      }

      // Add injected file blocks based on injection mode
      if (msg.content.injectedFiles?.length && msg.content.injectionMode) {
        const mode = effectiveInjectionMode(msg.content.injectionMode, 'bedrock');
        if (mode === 'as-file') {
          for (const file of msg.content.injectedFiles) {
            // Bedrock document name: alphanumeric, whitespace, hyphens, parens, brackets only
            const sanitizedName = file.path.replace(/[^a-zA-Z0-9\s\-()[\]]/g, '-');
            const encoder = new TextEncoder();
            contentBlocks.push({
              document: {
                format: 'txt',
                name: sanitizedName,
                source: { bytes: encoder.encode(file.content) },
              },
            });
          }
        } else if (mode === 'separate-block') {
          for (const file of msg.content.injectedFiles) {
            contentBlocks.push({ text: `=== ${file.path} ===\n${file.content}` });
          }
        }
      }

      // Add text content
      if (msg.content.content.trim()) {
        contentBlocks.push({ text: msg.content.content });
      }

      return {
        role: msg.role === 'user' ? ('user' as const) : ('assistant' as const),
        content: contentBlocks,
      };
    });
  }

  /**
   * Transform fullContent blocks to convert base64-stored fields back to Uint8Array for API.
   * We store some binary fields as base64 strings for JSON serialization compatibility.
   */
  private transformContentForApi(content: ContentBlock[]): ContentBlock[] {
    return content.map(block => {
      // Handle reasoningContent with redactedContent stored as base64 string
      if ('reasoningContent' in block && block.reasoningContent) {
        // Cast to unknown first to bypass SDK's discriminated union type restrictions
        const rc = block.reasoningContent as unknown as { redactedContent?: unknown };
        if (rc.redactedContent && typeof rc.redactedContent === 'string') {
          return {
            reasoningContent: {
              redactedContent: base64ToUint8Array(rc.redactedContent),
            },
          } as ContentBlock;
        }
      }
      // Return block unchanged if no transformation needed
      return block;
    });
  }
  /**
   * Build tool configuration for Bedrock
   */
  private buildToolConfig(
    enabledTools?: string[],
    toolOptions?: Record<string, ToolOptions>
  ): ToolConfiguration | undefined {
    if (!enabledTools?.length) return undefined;

    const toolOpts = toolOptions || {};
    const standardDefs = this.deps.toolRegistry.getToolDefinitions(enabledTools, toolOpts);

    const tools: Tool[] = standardDefs.map(def => {
      // Check for Bedrock-specific override
      const override = this.deps.toolRegistry.getToolOverride(
        def.name,
        'bedrock',
        toolOpts[def.name] ?? {}
      );
      if (override) {
        return override as Tool;
      }

      // Convert standard definition to Bedrock format using toolSpec member
      return {
        toolSpec: {
          name: def.name,
          description: def.description,
          inputSchema: {
            json: def.input_schema as unknown as DocumentType,
          },
        },
      } as Tool;
    });

    return tools.length > 0 ? { tools } : undefined;
  }

  /**
   * Handle errors and return error result
   */
  private handleError(error: unknown): StreamResult<BedrockFullContent> {
    let errorMessage = 'Unknown error';
    let errorStatus: number | undefined;
    let errorStack: string | undefined;

    if (error && typeof error === 'object') {
      if ('$metadata' in error) {
        const metadata = error.$metadata as { httpStatusCode?: number };
        errorStatus = metadata.httpStatusCode;
      }

      if ('message' in error) {
        errorMessage = String(error.message);
      }

      if (error instanceof Error) {
        errorStack = error.stack;
      }

      // Specific error handling
      if (errorStatus === 401 || errorStatus === 403) {
        errorMessage = 'Invalid credentials. Please check your API key or AWS credentials.';
      } else if (errorStatus === 429) {
        errorMessage = 'Rate limit exceeded. Please try again later.';
      } else if (errorStatus === 500 || errorStatus === 502 || errorStatus === 503) {
        errorMessage = 'Bedrock service is currently unavailable. Please try again later.';
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

  /**
   * Extract tool_use blocks from Bedrock fullContent
   */
  extractToolUseBlocks(fullContent: unknown): ToolUseBlock[] {
    if (!Array.isArray(fullContent)) return [];

    const blocks: ToolUseBlock[] = [];
    for (const block of fullContent as ContentBlock[]) {
      if ('toolUse' in block && block.toolUse) {
        blocks.push({
          type: 'tool_use',
          id: block.toolUse.toolUseId!,
          name: block.toolUse.name!,
          input: (block.toolUse.input as Record<string, unknown>) || {},
        });
      }
    }
    return blocks;
  }
}
