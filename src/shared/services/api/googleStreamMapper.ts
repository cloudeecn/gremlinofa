/**
 * Google Gemini Stream Mapper
 *
 * Maps GenerateContentResponse chunks from the Google Gen AI SDK
 * to the app's StreamChunk format for consistent rendering.
 */

import type { GenerateContentResponse, Part } from '@google/genai';
import type { StreamChunk } from './baseClient';

/**
 * State tracker for mapping Google stream chunks to StreamChunks
 */
export interface GoogleMapperState {
  currentPartType: 'text' | 'thinking' | null;
  pendingFunctionCall: {
    name: string;
    args: Record<string, unknown>;
  } | null;
  inputTokens: number;
  outputTokens: number;
  thoughtsTokens: number;
  cacheReadTokens: number;
}

/**
 * Create initial mapper state
 */
export function createMapperState(): GoogleMapperState {
  return {
    currentPartType: null,
    pendingFunctionCall: null,
    inputTokens: 0,
    outputTokens: 0,
    thoughtsTokens: 0,
    cacheReadTokens: 0,
  };
}

/**
 * Map a single Google GenerateContentResponse chunk to StreamChunk(s).
 * Returns chunks and updated state.
 */
export function mapGoogleChunkToStreamChunks(
  chunk: GenerateContentResponse,
  state: GoogleMapperState
): { chunks: StreamChunk[]; state: GoogleMapperState } {
  const chunks: StreamChunk[] = [];
  const newState = { ...state };

  const candidate = chunk.candidates?.[0];
  const parts = candidate?.content?.parts;

  if (parts) {
    for (const part of parts) {
      if (part.thought && part.text) {
        // Thinking part
        if (state.currentPartType !== 'thinking') {
          if (state.currentPartType === 'text') {
            chunks.push({ type: 'content.end' });
          }
          chunks.push({ type: 'thinking.start' });
          newState.currentPartType = 'thinking';
        }
        chunks.push({ type: 'thinking', content: part.text });
      } else if (part.text !== undefined && part.text !== null && !part.thought) {
        // Text part
        if (state.currentPartType !== 'text') {
          if (state.currentPartType === 'thinking') {
            chunks.push({ type: 'thinking.end' });
          }
          chunks.push({ type: 'content.start' });
          newState.currentPartType = 'text';
        }
        chunks.push({ type: 'content', content: part.text });
      } else if (part.functionCall) {
        // Close any open block
        if (state.currentPartType === 'text') {
          chunks.push({ type: 'content.end' });
        } else if (state.currentPartType === 'thinking') {
          chunks.push({ type: 'thinking.end' });
        }
        newState.currentPartType = null;

        const name = part.functionCall.name ?? 'unknown';
        chunks.push({
          type: 'tool_use',
          id: part.functionCall.id!,
          name,
          input: (part.functionCall.args as Record<string, unknown>) ?? {},
        });
      }
    }
  }

  // Handle grounding metadata from the candidate
  const grounding = candidate?.groundingMetadata;
  if (grounding) {
    // Web search queries
    if (grounding.webSearchQueries?.length) {
      for (const query of grounding.webSearchQueries) {
        const searchId = `gs_${Date.now()}`;
        chunks.push({ type: 'web_search.start', id: searchId });
        chunks.push({ type: 'web_search', id: searchId, query });
      }
    }
    // Grounding chunks (search results)
    if (grounding.groundingChunks?.length) {
      for (const gc of grounding.groundingChunks) {
        if (gc.web) {
          chunks.push({
            type: 'web_search.result',
            tool_use_id: `gs_grounding`,
            title: gc.web.title,
            url: gc.web.uri,
          });
        }
      }
    }
  }

  // Handle finish reason — close any open blocks
  const finishReason = candidate?.finishReason;
  if (finishReason && finishReason !== 'FINISH_REASON_UNSPECIFIED') {
    if (newState.currentPartType === 'text') {
      chunks.push({ type: 'content.end' });
      newState.currentPartType = null;
    } else if (newState.currentPartType === 'thinking') {
      chunks.push({ type: 'thinking.end' });
      newState.currentPartType = null;
    }
  }

  // Handle usage metadata
  const usage = chunk.usageMetadata;
  if (usage) {
    const cachedTokens = usage.cachedContentTokenCount ?? 0;
    newState.inputTokens = (usage.promptTokenCount ?? 0) - cachedTokens;
    newState.outputTokens = usage.candidatesTokenCount ?? 0;
    newState.thoughtsTokens = usage.thoughtsTokenCount ?? 0;
    newState.cacheReadTokens = cachedTokens;

    chunks.push({
      type: 'token_usage',
      inputTokens: (usage.promptTokenCount ?? 0) - cachedTokens,
      outputTokens: usage.candidatesTokenCount,
      cacheReadTokens: cachedTokens > 0 ? cachedTokens : undefined,
      reasoningTokens: usage.thoughtsTokenCount,
    });
  }

  return { chunks, state: newState };
}

/**
 * Map Google finish reason to our stop reason string.
 */
export function mapGoogleFinishReason(finishReason: string | undefined): string {
  if (finishReason === 'STOP') return 'end_turn';
  if (finishReason === 'MAX_TOKENS') return 'max_tokens';
  if (finishReason === 'SAFETY') return 'safety';
  if (finishReason === 'RECITATION') return 'recitation';
  return finishReason ?? 'end_turn';
}

/**
 * Extract text content from Google Part[].
 * Excludes thought parts.
 */
export function extractTextFromParts(parts: Part[]): string {
  return parts
    .filter(p => p.text && !p.thought)
    .map(p => p.text!)
    .join('');
}

/**
 * Extract thinking content from Google Part[].
 */
export function extractThinkingFromParts(parts: Part[]): string | undefined {
  const thinking = parts
    .filter(p => p.text && p.thought)
    .map(p => p.text!)
    .join('');
  return thinking || undefined;
}
