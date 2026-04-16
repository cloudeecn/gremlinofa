/**
 * Bedrock Converse API Stream Mapper
 *
 * Extracts stream event → StreamChunk mapping logic from BedrockClient
 * for easier testing and reuse.
 *
 * Handles both streaming (ConverseStreamCommand) and non-streaming (ConverseCommand) responses.
 */

import type {
  ContentBlock,
  ConverseStreamOutput,
  ConverseResponse,
} from '@aws-sdk/client-bedrock-runtime';
import type { DocumentType } from '@smithy/types';
import type { StreamChunk } from './baseClient';

/**
 * State tracker for mapping Bedrock stream events to StreamChunks
 */
export interface BedrockMapperState {
  // Pending tool use for JSON accumulation during streaming
  pendingToolUse: {
    id: string;
    name: string;
    input: string;
  } | null;
  // Current block type being processed (text, reasoning, toolUse, or null)
  currentBlockType: 'text' | 'reasoning' | 'toolUse' | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

/**
 * Create initial mapper state
 */
export function createMapperState(): BedrockMapperState {
  return {
    pendingToolUse: null,
    currentBlockType: null,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };
}

/**
 * Result from mapping a single stream event
 */
export interface MapEventResult {
  chunks: StreamChunk[];
  contentBlock?: ContentBlock;
  stopReason?: string;
  newState: BedrockMapperState;
}

/**
 * Map a single Bedrock stream event to StreamChunks.
 * Returns chunks, any completed content block, stop reason, and updated state.
 */
export function mapBedrockStreamEvent(
  event: ConverseStreamOutput,
  state: BedrockMapperState
): MapEventResult {
  const chunks: StreamChunk[] = [];
  let contentBlock: ContentBlock | undefined;
  let stopReason: string | undefined;
  const newState: BedrockMapperState = { ...state };

  if (event.messageStart) {
    // Message started - no chunks needed
  } else if (event.contentBlockStart) {
    const start = event.contentBlockStart.start;
    if (start?.toolUse) {
      // Start accumulating tool use
      newState.pendingToolUse = {
        id: start.toolUse.toolUseId!,
        name: start.toolUse.name!,
        input: '',
      };
      newState.currentBlockType = 'toolUse';
    } else {
      // Default to text block - actual type may be determined by first delta
      // Don't emit content.start yet - wait for first delta to determine block type
      newState.currentBlockType = null;
    }
  } else if (event.contentBlockDelta) {
    const delta = event.contentBlockDelta.delta;
    if (delta?.text) {
      // Text content - ensure we're in a text block
      if (state.currentBlockType === 'reasoning') {
        // Transition from reasoning to text
        chunks.push({ type: 'thinking.end' });
        chunks.push({ type: 'content.start' });
        newState.currentBlockType = 'text';
      } else if (state.currentBlockType !== 'text') {
        // Start text block
        chunks.push({ type: 'content.start' });
        newState.currentBlockType = 'text';
      }
      chunks.push({ type: 'content', content: delta.text });
    } else if (delta?.reasoningContent) {
      const reasoning = delta.reasoningContent;
      if ('text' in reasoning && reasoning.text) {
        // Reasoning content - ensure we're in a reasoning block
        if (state.currentBlockType !== 'reasoning') {
          // Close text block if open
          if (state.currentBlockType === 'text') {
            chunks.push({ type: 'content.end' });
          }
          // Start reasoning block
          chunks.push({ type: 'thinking.start' });
          newState.currentBlockType = 'reasoning';
        }
        chunks.push({ type: 'thinking', content: reasoning.text });
      }
    } else if (delta?.toolUse && state.pendingToolUse) {
      // Accumulate tool use input JSON
      const inputDelta = delta.toolUse.input;
      if (typeof inputDelta === 'string') {
        newState.pendingToolUse = {
          ...state.pendingToolUse,
          input: state.pendingToolUse.input + inputDelta,
        };
      }
    }
  } else if (event.contentBlockStop) {
    // Emit appropriate end event based on block type
    if (state.currentBlockType === 'reasoning') {
      chunks.push({ type: 'thinking.end' });
    } else if (state.currentBlockType === 'text') {
      chunks.push({ type: 'content.end' });
    }
    newState.currentBlockType = null;

    // If we have a pending tool use, emit it now
    if (state.pendingToolUse) {
      try {
        const input = state.pendingToolUse.input
          ? (JSON.parse(state.pendingToolUse.input) as Record<string, unknown>)
          : {};
        chunks.push({
          type: 'tool_use',
          id: state.pendingToolUse.id,
          name: state.pendingToolUse.name,
          input,
        });
        contentBlock = {
          toolUse: {
            toolUseId: state.pendingToolUse.id,
            name: state.pendingToolUse.name,
            input: input as unknown as DocumentType,
          },
        };
      } catch {
        // Failed to parse tool use input
        chunks.push({
          type: 'tool_use',
          id: state.pendingToolUse.id,
          name: state.pendingToolUse.name,
          input: {},
        });
      }
      newState.pendingToolUse = null;
    }
  } else if (event.messageStop) {
    stopReason = event.messageStop.stopReason;
  } else if (event.metadata) {
    const usage = event.metadata.usage;
    if (usage) {
      newState.inputTokens = usage.inputTokens ?? 0;
      newState.outputTokens = usage.outputTokens ?? 0;
      newState.cacheReadTokens = usage.cacheReadInputTokens ?? 0;
      newState.cacheCreationTokens = usage.cacheWriteInputTokens ?? 0;

      chunks.push({
        type: 'token_usage',
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadInputTokens,
        cacheCreationTokens: usage.cacheWriteInputTokens,
      });
    }
  }

  return {
    chunks,
    contentBlock,
    stopReason,
    newState,
  };
}

// ============================================================================
// Non-streaming response conversion
// ============================================================================

/**
 * Convert non-streaming ConverseResponse output to StreamChunks.
 * This allows the same StreamingContentAssembler to handle both paths.
 */
export function convertConverseResponseToStreamChunks(response: ConverseResponse): StreamChunk[] {
  const chunks: StreamChunk[] = [];
  const outputContent = response.output?.message?.content || [];

  for (const block of outputContent) {
    if ('text' in block && block.text) {
      chunks.push({ type: 'content.start' });
      chunks.push({ type: 'content', content: block.text });
      chunks.push({ type: 'content.end' });
    } else if ('reasoningContent' in block && block.reasoningContent) {
      const reasoning = block.reasoningContent;
      if ('reasoningText' in reasoning && reasoning.reasoningText?.text) {
        chunks.push({ type: 'thinking.start' });
        chunks.push({ type: 'thinking', content: reasoning.reasoningText.text });
        chunks.push({ type: 'thinking.end' });
      }
    } else if ('toolUse' in block && block.toolUse) {
      chunks.push({
        type: 'tool_use',
        id: block.toolUse.toolUseId!,
        name: block.toolUse.name!,
        input: (block.toolUse.input as Record<string, unknown>) || {},
      });
    }
  }

  // Add token usage
  const usage = response.usage;
  if (usage) {
    chunks.push({
      type: 'token_usage',
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadInputTokens,
      cacheCreationTokens: usage.cacheWriteInputTokens,
    });
  }

  return chunks;
}

/**
 * Extract text and thinking content from non-streaming response.
 */
export function extractContentFromResponse(response: ConverseResponse): {
  textContent: string;
  thinkingContent: string | undefined;
} {
  const outputContent = response.output?.message?.content || [];
  let textContent = '';
  let thinkingContent = '';

  for (const block of outputContent) {
    if ('text' in block && block.text) {
      textContent += block.text;
    } else if ('reasoningContent' in block && block.reasoningContent) {
      const reasoning = block.reasoningContent;
      if ('reasoningText' in reasoning && reasoning.reasoningText?.text) {
        thinkingContent += reasoning.reasoningText.text;
      }
    }
  }

  return {
    textContent,
    thinkingContent: thinkingContent || undefined,
  };
}
