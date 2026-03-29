import { describe, expect, it } from 'vitest';
import type { Part, GenerateContentResponse } from '@google/genai';
import { GoogleClient } from '../googleClient';
import {
  createMapperState,
  mapGoogleChunkToStreamChunks,
  mapGoogleFinishReason,
  extractTextFromParts,
  extractThinkingFromParts,
} from '../googleStreamMapper';

// === Stream Mapper Tests ===

describe('googleStreamMapper', () => {
  describe('mapGoogleChunkToStreamChunks', () => {
    it('maps a text-only chunk', () => {
      const chunk = {
        candidates: [
          {
            content: { parts: [{ text: 'Hello world' }] },
          },
        ],
      } as GenerateContentResponse;

      const { chunks, state } = mapGoogleChunkToStreamChunks(chunk, createMapperState());

      expect(chunks).toEqual([
        { type: 'content.start' },
        { type: 'content', content: 'Hello world' },
      ]);
      expect(state.currentPartType).toBe('text');
    });

    it('maps a thinking chunk', () => {
      const chunk = {
        candidates: [
          {
            content: { parts: [{ text: 'Let me think...', thought: true }] },
          },
        ],
      } as GenerateContentResponse;

      const { chunks, state } = mapGoogleChunkToStreamChunks(chunk, createMapperState());

      expect(chunks).toEqual([
        { type: 'thinking.start' },
        { type: 'thinking', content: 'Let me think...' },
      ]);
      expect(state.currentPartType).toBe('thinking');
    });

    it('transitions from thinking to text', () => {
      const thinkingState = { ...createMapperState(), currentPartType: 'thinking' as const };

      const chunk = {
        candidates: [
          {
            content: { parts: [{ text: 'The answer is 42' }] },
          },
        ],
      } as GenerateContentResponse;

      const { chunks } = mapGoogleChunkToStreamChunks(chunk, thinkingState);

      expect(chunks).toEqual([
        { type: 'thinking.end' },
        { type: 'content.start' },
        { type: 'content', content: 'The answer is 42' },
      ]);
    });

    it('transitions from text to thinking', () => {
      const textState = { ...createMapperState(), currentPartType: 'text' as const };

      const chunk = {
        candidates: [
          {
            content: { parts: [{ text: 'Hmm...', thought: true }] },
          },
        ],
      } as GenerateContentResponse;

      const { chunks } = mapGoogleChunkToStreamChunks(chunk, textState);

      expect(chunks).toEqual([
        { type: 'content.end' },
        { type: 'thinking.start' },
        { type: 'thinking', content: 'Hmm...' },
      ]);
    });

    it('maps a function call part with separate id and name', () => {
      const chunk = {
        candidates: [
          {
            content: {
              parts: [
                {
                  functionCall: {
                    name: 'get_weather',
                    id: 'fc_001',
                    args: { city: 'Tokyo' },
                  },
                },
              ],
            },
          },
        ],
      } as unknown as GenerateContentResponse;

      const { chunks } = mapGoogleChunkToStreamChunks(chunk, createMapperState());

      expect(chunks).toEqual([
        {
          type: 'tool_use',
          id: 'fc_001',
          name: 'get_weather',
          input: { city: 'Tokyo' },
        },
      ]);
    });

    it('closes text block before function call', () => {
      const textState = { ...createMapperState(), currentPartType: 'text' as const };

      const chunk = {
        candidates: [
          {
            content: {
              parts: [{ functionCall: { name: 'search', id: 'fc_002', args: { q: 'test' } } }],
            },
          },
        ],
      } as unknown as GenerateContentResponse;

      const { chunks } = mapGoogleChunkToStreamChunks(chunk, textState);

      expect(chunks[0]).toEqual({ type: 'content.end' });
      expect(chunks[1]).toMatchObject({ type: 'tool_use', name: 'search' });
    });

    it('maps usage metadata', () => {
      const chunk = {
        usageMetadata: {
          promptTokenCount: 100,
          candidatesTokenCount: 50,
          thoughtsTokenCount: 20,
        },
      } as GenerateContentResponse;

      const { chunks, state } = mapGoogleChunkToStreamChunks(chunk, createMapperState());

      expect(chunks).toEqual([
        {
          type: 'token_usage',
          inputTokens: 100,
          outputTokens: 50,
          reasoningTokens: 20,
        },
      ]);
      expect(state.inputTokens).toBe(100);
      expect(state.outputTokens).toBe(50);
      expect(state.thoughtsTokens).toBe(20);
    });

    it('maps grounding metadata with web search queries', () => {
      const chunk = {
        candidates: [
          {
            groundingMetadata: {
              webSearchQueries: ['weather in Tokyo'],
              groundingChunks: [{ web: { title: 'Weather.com', uri: 'https://weather.com' } }],
            },
          },
        ],
      } as unknown as GenerateContentResponse;

      const { chunks } = mapGoogleChunkToStreamChunks(chunk, createMapperState());

      // Should have web_search.start, web_search (query), and web_search.result
      const searchStart = chunks.find(c => c.type === 'web_search.start');
      const searchQuery = chunks.find(c => c.type === 'web_search');
      const searchResult = chunks.find(c => c.type === 'web_search.result');

      expect(searchStart).toBeDefined();
      expect(searchQuery).toMatchObject({ type: 'web_search', query: 'weather in Tokyo' });
      expect(searchResult).toMatchObject({
        type: 'web_search.result',
        title: 'Weather.com',
        url: 'https://weather.com',
      });
    });

    it('closes blocks on STOP finish reason', () => {
      const textState = { ...createMapperState(), currentPartType: 'text' as const };

      const chunk = {
        candidates: [
          {
            finishReason: 'STOP',
            content: { parts: [] },
          },
        ],
      } as unknown as GenerateContentResponse;

      const { chunks, state } = mapGoogleChunkToStreamChunks(chunk, textState);

      expect(chunks).toContainEqual({ type: 'content.end' });
      expect(state.currentPartType).toBeNull();
    });
  });

  describe('mapGoogleFinishReason', () => {
    it('maps STOP to end_turn', () => {
      expect(mapGoogleFinishReason('STOP')).toBe('end_turn');
    });

    it('maps MAX_TOKENS to max_tokens', () => {
      expect(mapGoogleFinishReason('MAX_TOKENS')).toBe('max_tokens');
    });

    it('maps SAFETY to safety', () => {
      expect(mapGoogleFinishReason('SAFETY')).toBe('safety');
    });

    it('maps undefined to end_turn', () => {
      expect(mapGoogleFinishReason(undefined)).toBe('end_turn');
    });

    it('passes through unknown reasons', () => {
      expect(mapGoogleFinishReason('BLOCKLIST')).toBe('BLOCKLIST');
    });
  });

  describe('extractTextFromParts', () => {
    it('extracts text, excludes thoughts', () => {
      const parts: Part[] = [
        { text: 'Thinking...', thought: true },
        { text: 'Hello ' },
        { text: 'world' },
      ];
      expect(extractTextFromParts(parts)).toBe('Hello world');
    });

    it('returns empty for thought-only parts', () => {
      const parts: Part[] = [{ text: 'Thinking...', thought: true }];
      expect(extractTextFromParts(parts)).toBe('');
    });
  });

  describe('extractThinkingFromParts', () => {
    it('extracts thought parts', () => {
      const parts: Part[] = [
        { text: 'Step 1...', thought: true },
        { text: 'Hello' },
        { text: 'Step 2...', thought: true },
      ];
      expect(extractThinkingFromParts(parts)).toBe('Step 1...Step 2...');
    });

    it('returns undefined for no thoughts', () => {
      const parts: Part[] = [{ text: 'Hello' }];
      expect(extractThinkingFromParts(parts)).toBeUndefined();
    });
  });
});

// === GoogleClient Tests ===

describe('GoogleClient', () => {
  const client = new GoogleClient();

  describe('extractToolUseBlocks', () => {
    it('extracts function calls with separate id and name', () => {
      const parts: Part[] = [
        { text: 'Let me search' },
        { functionCall: { name: 'memory', args: { key: 'test' }, id: 'call_456' } },
        { functionCall: { name: 'search', args: { q: 'hello' }, id: 'call_123' } },
      ];

      const blocks = client.extractToolUseBlocks(parts);

      expect(blocks).toHaveLength(2);
      expect(blocks[0]).toEqual({
        type: 'tool_use',
        id: 'call_456',
        name: 'memory',
        input: { key: 'test' },
      });
      expect(blocks[1]).toEqual({
        type: 'tool_use',
        id: 'call_123',
        name: 'search',
        input: { q: 'hello' },
      });
    });

    it('returns empty for no function calls', () => {
      const parts: Part[] = [{ text: 'Hello' }];
      expect(client.extractToolUseBlocks(parts)).toEqual([]);
    });

    it('returns empty for non-array input', () => {
      expect(client.extractToolUseBlocks('not an array')).toEqual([]);
    });
  });
});
