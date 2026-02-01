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
  type ToolResultBlock as BedrockToolResultBlock,
  type Tool,
  type SystemContentBlock,
  type ToolConfiguration,
} from '@aws-sdk/client-bedrock-runtime';
import type { DocumentType } from '@smithy/types';
import {
  BedrockClient as BedrockControlPlaneClient,
  ListFoundationModelsCommand,
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
} from '../../types';

import { groupAndConsolidateBlocks } from '../../types';
import { generateUniqueId } from '../../utils/idGenerator';
import type { APIClient, StreamChunk, StreamResult } from './baseClient';
import { getModelMetadataFor } from './modelMetadata';
import { toolRegistry } from '../tools/clientSideTools';
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
 * Extract region from Bedrock endpoint URL or return default
 * Expected format: https://bedrock-runtime.{region}.amazonaws.com
 */
function extractRegionFromUrl(baseUrl: string): string {
  if (!baseUrl) return DEFAULT_REGION;
  const match = baseUrl.match(/bedrock(?:-runtime)?\.([a-z0-9-]+)\.amazonaws\.com/);
  return match ? match[1] : DEFAULT_REGION;
}

/**
 * Bedrock fullContent type - array of ContentBlock
 */
export type BedrockFullContent = ContentBlock[];

export class BedrockClient implements APIClient {
  /**
   * Discover available models from Bedrock using ListFoundationModels
   */
  async discoverModels(apiDefinition: APIDefinition): Promise<Model[]> {
    const region = extractRegionFromUrl(apiDefinition.baseUrl);

    // Create control plane client for model discovery
    const controlPlaneClient = new BedrockControlPlaneClient({
      region,
      ...(apiDefinition.apiKey && {
        token: { token: apiDefinition.apiKey },
        authSchemePreference: ['httpBearerAuth'],
      }),
      ...(apiDefinition.baseUrl && {
        endpoint: apiDefinition.baseUrl.replace('bedrock-runtime', 'bedrock'),
      }),
    });

    try {
      const response = await controlPlaneClient.send(new ListFoundationModelsCommand({}));
      console.debug(`[BedrockClient] Models for ${apiDefinition.name}:`, response);

      if (!response.modelSummaries) {
        return [];
      }

      // Filter for active models with text output and convert to our Model format
      const models: Model[] = response.modelSummaries
        .filter(
          m =>
            m.modelId &&
            m.outputModalities?.includes('TEXT') &&
            m.modelLifecycle?.status !== 'LEGACY'
        )
        .sort((a, b) => (a?.modelId ?? '').localeCompare(b?.modelId ?? ''))
        .map(m => ({
          ...getModelMetadataFor(apiDefinition, m.modelId!),
          name: m.modelName || m.modelId!,
        }));

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
      toolOptions?: Record<string, Record<string, boolean>>;
      disableStream?: boolean;
    }
  ): AsyncGenerator<StreamChunk, StreamResult<BedrockFullContent>, unknown> {
    try {
      const region = extractRegionFromUrl(apiDefinition.baseUrl);

      // Create runtime client for inference
      const runtimeClient = new BedrockRuntimeClient({
        region,
        ...(apiDefinition.apiKey && {
          token: { token: apiDefinition.apiKey },
          authSchemePreference: ['httpBearerAuth'],
        }),
        ...(apiDefinition.baseUrl && {
          endpoint: apiDefinition.baseUrl,
        }),
      });

      // Convert messages to Bedrock format
      const bedrockMessages = this.convertMessages(messages);

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

      // Check if model supports reasoning (Claude models on Bedrock)
      const supportsReasoning = modelId.startsWith('anthropic.claude');

      // Build additional model request fields for reasoning (cast to DocumentType for SDK compatibility)
      const additionalModelRequestFields: DocumentType | undefined =
        supportsReasoning && options.enableReasoning
          ? ({
              thinking: {
                type: 'enabled',
                budget_tokens: options.reasoningBudgetTokens,
              },
            } as DocumentType)
          : undefined;

      // Use non-streaming if requested
      if (options.disableStream) {
        return yield* this.sendMessageNonStreaming(
          runtimeClient,
          modelId,
          bedrockMessages,
          systemPrompt,
          toolConfig,
          inferenceConfig,
          additionalModelRequestFields
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

      const response = await runtimeClient.send(command);

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
    additionalModelRequestFields: DocumentType | undefined
  ): AsyncGenerator<StreamChunk, StreamResult<BedrockFullContent>, unknown> {
    const command = new ConverseCommand({
      modelId,
      messages,
      system,
      ...(toolConfig && { toolConfig }),
      inferenceConfig,
      ...(additionalModelRequestFields && { additionalModelRequestFields }),
    });

    const response = await client.send(command);

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
    toolOptions?: Record<string, Record<string, boolean>>
  ): ToolConfiguration | undefined {
    if (!enabledTools?.length) return undefined;

    const toolOpts = toolOptions || {};
    const standardDefs = toolRegistry.getToolDefinitions(enabledTools, toolOpts);

    const tools: Tool[] = standardDefs.map(def => {
      // Check for Bedrock-specific override
      const override = toolRegistry.getToolOverride(def.name, 'bedrock', toolOpts[def.name] ?? {});
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
   * Migrate old messages to renderingContent format
   */
  migrateMessageRendering(
    fullContent: unknown,
    stopReason: string | null
  ): {
    renderingContent: RenderingBlockGroup[];
    stopReason: MessageStopReason;
  } {
    const blocks: RenderingContentBlock[] = [];

    if (!Array.isArray(fullContent)) {
      if (typeof fullContent === 'string' && fullContent.trim()) {
        blocks.push({ type: 'text', text: fullContent });
      }
      return {
        renderingContent: groupAndConsolidateBlocks(blocks),
        stopReason: this.mapStopReason(stopReason),
      };
    }

    for (const block of fullContent as ContentBlock[]) {
      if ('text' in block && block.text) {
        blocks.push({ type: 'text', text: block.text });
      } else if ('reasoningContent' in block && block.reasoningContent) {
        const reasoning = block.reasoningContent;
        if ('reasoningText' in reasoning && reasoning.reasoningText?.text) {
          blocks.push({ type: 'thinking', thinking: reasoning.reasoningText.text });
        }
      }
      // tool_use blocks are handled separately via extractToolUseBlocks
    }

    return {
      renderingContent: groupAndConsolidateBlocks(blocks),
      stopReason: this.mapStopReason(stopReason),
    };
  }

  /**
   * Map Bedrock stop reason to MessageStopReason
   */
  private mapStopReason(stopReason: string | null): MessageStopReason {
    if (!stopReason) return 'end_turn';

    switch (stopReason) {
      case 'end_turn':
      case 'max_tokens':
      case 'stop_sequence':
        return stopReason;
      case 'tool_use':
        return 'end_turn';
      default:
        return stopReason;
    }
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

  /**
   * Build tool result message in Bedrock format
   */
  buildToolResultMessage(toolResults: ToolResultBlock[]): Message<BedrockFullContent> {
    const bedrockToolResults: BedrockToolResultBlock[] = toolResults.map(result => ({
      toolUseId: result.tool_use_id,
      content: [{ text: result.content }],
      status: result.is_error ? 'error' : 'success',
    }));

    return {
      id: generateUniqueId('msg_user'),
      role: 'user',
      content: {
        type: 'text',
        content: '',
        modelFamily: 'bedrock',
        fullContent: bedrockToolResults.map(tr => ({ toolResult: tr })),
      },
      timestamp: new Date(),
    };
  }
}
