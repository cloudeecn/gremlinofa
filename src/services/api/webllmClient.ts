/**
 * WebLLM Client - Local LLM inference via WebGPU
 *
 * Runs models locally in the browser without API costs.
 * Requires WebGPU support (Chrome 113+, Edge 113+, Safari 18+).
 */

import type { MLCEngine, InitProgressReport, ChatCompletionMessageParam } from '@mlc-ai/web-llm';
import { CreateMLCEngine, prebuiltAppConfig } from '@mlc-ai/web-llm';

import type {
  APIDefinition,
  Message,
  MessageStopReason,
  Model,
  RenderingBlockGroup,
  ToolResultBlock,
  ToolUseBlock,
} from '../../types';
import { groupAndConsolidateBlocks } from '../../types';
import type { APIClient, StreamChunk, StreamResult } from './baseClient';
import type { ModelInfo } from './modelInfo';
import {
  formatModelInfoForDisplay as formatInfo,
  getModelInfo,
  isReasoningModel as checkReasoningModel,
  type WebLLMModelInfo,
} from './webllmModelInfo';

/**
 * Progress callback for model loading.
 * Reports download and initialization progress.
 */
export type WebLLMProgressCallback = (report: InitProgressReport) => void;

/**
 * Observable loading state for WebLLM models.
 * Used by UI components to show loading progress.
 */
export interface WebLLMLoadingState {
  /** Whether a model is currently loading */
  isLoading: boolean;
  /** Model ID being loaded */
  modelId: string | null;
  /** Progress percentage (0-100), -1 if unknown */
  progress: number;
  /** Status text from WebLLM */
  statusText: string;
  /** Whether model is fully loaded and ready */
  isReady: boolean;
}

/**
 * Singleton engine state for WebLLM.
 * One engine per session, switches models as needed.
 */
let engine: MLCEngine | null = null;
let currentModelId: string | null = null;
let progressCallback: WebLLMProgressCallback | null = null;

/**
 * Observable loading state (for UI components to subscribe)
 */
let loadingState: WebLLMLoadingState = {
  isLoading: false,
  modelId: null,
  progress: -1,
  statusText: '',
  isReady: false,
};
let loadingStateListeners: Array<(state: WebLLMLoadingState) => void> = [];

/**
 * Update loading state and notify all listeners.
 */
function updateLoadingState(update: Partial<WebLLMLoadingState>): void {
  loadingState = { ...loadingState, ...update };
  for (const listener of loadingStateListeners) {
    listener(loadingState);
  }
}

/**
 * Subscribe to loading state changes.
 * Returns unsubscribe function.
 */
export function subscribeToLoadingState(listener: (state: WebLLMLoadingState) => void): () => void {
  loadingStateListeners.push(listener);
  // Immediately call with current state
  listener(loadingState);
  return () => {
    loadingStateListeners = loadingStateListeners.filter(l => l !== listener);
  };
}

/**
 * Get current loading state (snapshot).
 */
export function getLoadingState(): WebLLMLoadingState {
  return { ...loadingState };
}

/**
 * Set a global progress callback for model loading.
 * Called during model download and initialization.
 */
export function setProgressCallback(callback: WebLLMProgressCallback | null): void {
  progressCallback = callback;
}

/**
 * Get the current engine state (for UI status display).
 */
export function getEngineState(): {
  isLoaded: boolean;
  currentModelId: string | null;
} {
  return {
    isLoaded: engine !== null,
    currentModelId,
  };
}

/**
 * Dispose of the current engine and free resources.
 * Call this when switching away from WebLLM or on app cleanup.
 */
export async function disposeEngine(): Promise<void> {
  if (engine) {
    await engine.unload();
    engine = null;
    currentModelId = null;
  }
}

/**
 * Get or create the WebLLM engine for the specified model.
 * Switches models if needed (unloads current, loads new).
 */
async function getEngine(modelId: string): Promise<MLCEngine> {
  // If we have an engine with a different model, unload first
  if (engine && currentModelId !== modelId) {
    console.debug('WebLLM: Switching from', currentModelId, 'to', modelId);
    updateLoadingState({ isReady: false });
    await engine.unload();
    engine = null;
    currentModelId = null;
  }

  // Create new engine if needed
  if (!engine) {
    console.debug('WebLLM: Loading model', modelId);
    updateLoadingState({
      isLoading: true,
      modelId,
      progress: -1,
      statusText: 'Initializing...',
      isReady: false,
    });

    try {
      engine = await CreateMLCEngine(modelId, {
        initProgressCallback: (report: InitProgressReport) => {
          console.debug('WebLLM progress:', report.text);

          // Parse progress from report if available
          // WebLLM reports progress as 0-1 float in some cases
          const progress =
            typeof report.progress === 'number' ? Math.round(report.progress * 100) : -1;

          updateLoadingState({
            progress,
            statusText: report.text,
          });

          if (progressCallback) {
            progressCallback(report);
          }
        },
      });
      currentModelId = modelId;
      updateLoadingState({
        isLoading: false,
        progress: 100,
        statusText: 'Model ready',
        isReady: true,
      });
      console.debug('WebLLM: Model loaded', modelId);
    } catch (error) {
      updateLoadingState({
        isLoading: false,
        progress: -1,
        statusText: (error as Error).message,
        isReady: false,
      });

      throw error;
    }
  }

  return engine!;
}

/**
 * WebLLM API Client implementation.
 * Provides local LLM inference via WebGPU.
 */
export class WebLLMClient implements APIClient {
  /**
   * Discover available models from WebLLM's prebuilt model list.
   * Returns models that can be downloaded and run locally.
   */
  async discoverModels(_apiDefinition: APIDefinition): Promise<Model[]> {
    // Get available models from prebuiltAppConfig
    const availableModels = prebuiltAppConfig.model_list;

    // Filter for instruction-tuned models (most useful for chat)
    const chatModels = availableModels.filter(
      (model: { model_id: string }) =>
        model.model_id.toLowerCase().includes('instruct') ||
        model.model_id.toLowerCase().includes('chat')
    );

    // Sort by resource usage: low_resource_required first, then by VRAM
    chatModels.sort((a: { model_id: string }, b: { model_id: string }) => {
      const infoA = getModelInfo(a.model_id);
      const infoB = getModelInfo(b.model_id);
      // Primary: low_resource_required true comes first
      if (infoA.lowResourceRequired !== infoB.lowResourceRequired) {
        return infoA.lowResourceRequired ? -1 : 1;
      }
      // Secondary: sort by VRAM required (smaller first)
      return infoA.vramRequired - infoB.vramRequired;
    });

    // Convert to our Model format
    const models: Model[] = chatModels.map((mlcModel: { model_id: string }) => {
      const info = getModelInfo(mlcModel.model_id);
      return {
        id: mlcModel.model_id,
        name: info.displayName,
        apiType: 'webllm',
        contextWindow: info.contextWindow,
      };
    });

    return models;
  }

  /**
   * WebLLM doesn't use pre-fill responses in the same way as API providers.
   */
  shouldPrependPrefill(_apiDefinition: APIDefinition): boolean {
    return false;
  }

  /**
   * Send a message and stream the response from the local model.
   */
  async *sendMessageStream(
    messages: Message<unknown>[],
    modelId: string,
    _apiDefinition: APIDefinition,
    options: {
      temperature?: number;
      maxTokens: number;
      enableReasoning: boolean;
      reasoningBudgetTokens: number;
      systemPrompt?: string;
      preFillResponse?: string;
      webSearchEnabled?: boolean;
    }
  ): AsyncGenerator<StreamChunk, StreamResult<Array<{ type: 'text'; text: string }>>, unknown> {
    try {
      // Get or create engine for this model
      const mlcEngine = await getEngine(modelId);

      // Convert messages to WebLLM format
      const webllmMessages: ChatCompletionMessageParam[] = [];

      // Add system prompt if provided
      if (options.systemPrompt) {
        webllmMessages.push({
          role: 'system',
          content: options.systemPrompt,
        });
      }

      // Add conversation messages
      for (const msg of messages) {
        if (msg.role === 'user') {
          // WebLLM doesn't support vision - just use text content
          // If message has attachments, note it in the message
          let content = msg.content.content;
          if (msg.attachments && msg.attachments.length > 0) {
            content = `[Note: ${msg.attachments.length} image(s) were attached but this local model doesn't support vision]\n\n${content}`;
          }
          webllmMessages.push({
            role: 'user',
            content,
          });
        } else if (msg.role === 'assistant') {
          webllmMessages.push({
            role: 'assistant',
            content: msg.content.content,
          });
        }
      }

      // Add pre-fill if provided (append as partial assistant message)
      if (options.preFillResponse) {
        webllmMessages.push({
          role: 'assistant',
          content: options.preFillResponse,
        });
      }

      // Track streamed content
      let streamedContent = '';

      // Create streaming completion
      const chunks = await mlcEngine.chat.completions.create({
        messages: webllmMessages,
        stream: true,
        temperature: options.temperature,
        max_tokens: options.maxTokens,
      });

      // Track whether we've started content block
      let inContentBlock = false;

      // Stream the response
      for await (const chunk of chunks) {
        const delta = chunk.choices[0]?.delta?.content;
        if (delta) {
          // Emit content.start on first content
          if (!inContentBlock) {
            inContentBlock = true;
            yield { type: 'content.start' };
          }
          streamedContent += delta;
          yield { type: 'content', content: delta };
        }

        // Check for finish reason
        const finishReason = chunk.choices[0]?.finish_reason;
        if (finishReason) {
          if (inContentBlock) {
            yield { type: 'content.end' };
            inContentBlock = false;
          }
        }
      }

      // Emit content.end if stream ended without finish_reason
      if (inContentBlock) {
        yield { type: 'content.end' };
      }

      // Prepend prefill if provided
      let textContent = streamedContent;
      if (options.preFillResponse) {
        textContent = options.preFillResponse + streamedContent;
      }

      // Wrap in content block format for consistency
      const fullContent = [{ type: 'text' as const, text: textContent }];

      // Get token usage from engine (if available)
      // Note: WebLLM may not always report accurate token counts
      const usage = await mlcEngine.runtimeStatsText();
      const inputTokens = this.extractTokenCount(usage, 'prefill') || 0;
      const outputTokens = this.extractTokenCount(usage, 'decode') || 0;

      // Return final result
      return {
        textContent,
        fullContent,
        stopReason: 'end_turn',
        inputTokens,
        outputTokens,
      };
    } catch (error: unknown) {
      // Handle errors
      let errorMessage = 'Unknown error occurred';
      let errorStack: string | undefined = undefined;

      if (error && typeof error === 'object') {
        if ('message' in error && typeof error.message === 'string') {
          errorMessage = error.message;
        }
        if (error instanceof Error) {
          errorStack = error.stack;
        }
      }

      // Return with error object
      return {
        textContent: '',
        fullContent: [],
        error: { message: errorMessage, stack: errorStack },
        inputTokens: 0,
        outputTokens: 0,
      };
    }
  }

  /**
   * Extract token count from runtime stats text.
   * WebLLM reports stats as text like "prefill: 123 tok, decode: 456 tok"
   */
  private extractTokenCount(statsText: string, type: 'prefill' | 'decode'): number | null {
    const regex = new RegExp(`${type}:\\s*(\\d+)\\s*tok`, 'i');
    const match = statsText.match(regex);
    return match ? parseInt(match[1], 10) : null;
  }

  /**
   * Calculate cost - always 0 for local models.
   */
  calculateCost(
    _modelId: string,
    _inputTokens: number,
    _outputTokens: number,
    _reasoningTokens?: number,
    _cacheCreationTokens?: number,
    _cacheReadTokens?: number
  ): number {
    // Local models are free!
    return 0;
  }

  /**
   * Get model information including context window and size.
   */
  getModelInfo(modelId: string): ModelInfo {
    return getModelInfo(modelId);
  }

  /**
   * Format model info for display in UI.
   */
  formatModelInfoForDisplay(info: ModelInfo): string {
    // Cast to WebLLMModelInfo to access extended properties
    return formatInfo(info as WebLLMModelInfo);
  }

  /**
   * Check if model supports reasoning (none currently do).
   */
  isReasoningModel(modelId: string): boolean {
    return checkReasoningModel(modelId);
  }

  /**
   * Migrate old messages to new rendering format.
   * WebLLM uses simple text-only content.
   */
  migrateMessageRendering(
    fullContent: unknown,
    stopReason: string | null
  ): {
    renderingContent: RenderingBlockGroup[];
    stopReason: MessageStopReason;
  } {
    // WebLLM has simple text-only content: [{ type: 'text', text: string }]
    let textContent = '';

    if (Array.isArray(fullContent)) {
      for (const block of fullContent as Array<Record<string, unknown>>) {
        if (block.type === 'text' && typeof block.text === 'string') {
          textContent += block.text;
        }
      }
    } else if (typeof fullContent === 'string') {
      textContent = fullContent;
    }

    const renderingContent = textContent.trim()
      ? groupAndConsolidateBlocks([{ type: 'text', text: textContent }])
      : [];

    return {
      renderingContent,
      stopReason: this.mapStopReason(stopReason),
    };
  }

  /**
   * Map WebLLM finish reasons to MessageStopReason.
   */
  private mapStopReason(stopReason: string | null): MessageStopReason {
    if (!stopReason) {
      return 'end_turn';
    }
    // WebLLM uses: stop, length
    switch (stopReason) {
      case 'stop':
        return 'end_turn';
      case 'length':
        return 'max_tokens';
      default:
        return stopReason;
    }
  }

  /**
   * Extract tool_use blocks - WebLLM doesn't support tools.
   */
  extractToolUseBlocks(_fullContent: unknown): ToolUseBlock[] {
    // WebLLM doesn't support tool calling
    return [];
  }

  /**
   * Build tool result message - WebLLM doesn't support tools.
   */
  buildToolResultMessage(_toolResults: ToolResultBlock[]): Message<unknown> {
    // WebLLM doesn't support tool calling - return empty message
    return {
      id: '',
      role: 'user',
      content: { type: 'text', content: '', modelFamily: 'webllm' },
      timestamp: new Date(),
    };
  }
}
