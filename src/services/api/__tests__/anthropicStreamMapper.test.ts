import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  parseSSEText,
  parseSSEToStreamChunks,
  mapAnthropicEventToStreamChunks,
  createMapperState,
} from '../anthropicStreamMapper';

describe('anthropicStreamMapper', () => {
  describe('parseSSEText', () => {
    it('parses simple SSE event', () => {
      const sseText = 'event: message_start\ndata: {"type":"message_start"}\n\n';
      const events = parseSSEText(sseText);

      expect(events).toHaveLength(1);
      expect(events[0].event).toBe('message_start');
      expect(events[0].data).toEqual({ type: 'message_start' });
    });

    it('parses multiple SSE events', () => {
      const sseText = `event: message_start
data: {"type":"message_start"}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

`;
      const events = parseSSEText(sseText);

      expect(events).toHaveLength(2);
      expect(events[0].event).toBe('message_start');
      expect(events[1].event).toBe('content_block_start');
    });

    it('handles ping events', () => {
      const sseText = 'event: ping\ndata: {"type": "ping"}\n\n';
      const events = parseSSEText(sseText);

      expect(events).toHaveLength(1);
      expect(events[0].event).toBe('ping');
    });
  });

  describe('mapAnthropicEventToStreamChunks', () => {
    it('maps content_block_start (text) to content.start', () => {
      const sseEvent = {
        event: 'content_block_start',
        data: { content_block: { type: 'text', text: '' } },
      };
      const state = createMapperState();

      const result = mapAnthropicEventToStreamChunks(sseEvent, state);

      expect(result.chunks).toContainEqual({ type: 'content.start' });
      expect(result.state.currentBlockType).toBe('text');
    });

    it('maps content_block_start (thinking) to thinking.start', () => {
      const sseEvent = {
        event: 'content_block_start',
        data: { content_block: { type: 'thinking', thinking: '', signature: '' } },
      };
      const state = createMapperState();

      const result = mapAnthropicEventToStreamChunks(sseEvent, state);

      expect(result.chunks).toContainEqual({ type: 'thinking.start' });
      expect(result.state.currentBlockType).toBe('thinking');
    });

    it('maps content_block_delta (text_delta) to content', () => {
      const sseEvent = {
        event: 'content_block_delta',
        data: { delta: { type: 'text_delta', text: 'Hello' } },
      };
      const state = createMapperState();

      const result = mapAnthropicEventToStreamChunks(sseEvent, state);

      expect(result.chunks).toContainEqual({ type: 'content', content: 'Hello' });
    });

    it('maps content_block_delta (thinking_delta) to thinking', () => {
      const sseEvent = {
        event: 'content_block_delta',
        data: { delta: { type: 'thinking_delta', thinking: 'reasoning...' } },
      };
      const state = createMapperState();

      const result = mapAnthropicEventToStreamChunks(sseEvent, state);

      expect(result.chunks).toContainEqual({ type: 'thinking', content: 'reasoning...' });
    });

    it('maps content_block_stop (text) to content.end', () => {
      const sseEvent = { event: 'content_block_stop', data: {} };
      const state = { ...createMapperState(), currentBlockType: 'text' };

      const result = mapAnthropicEventToStreamChunks(sseEvent, state);

      expect(result.chunks).toContainEqual({ type: 'content.end' });
      expect(result.state.currentBlockType).toBe(null);
    });

    it('maps content_block_stop (thinking) to thinking.end', () => {
      const sseEvent = { event: 'content_block_stop', data: {} };
      const state = { ...createMapperState(), currentBlockType: 'thinking' };

      const result = mapAnthropicEventToStreamChunks(sseEvent, state);

      expect(result.chunks).toContainEqual({ type: 'thinking.end' });
      expect(result.state.currentBlockType).toBe(null);
    });

    it('maps server_tool_use (web_search) to web_search', () => {
      const sseEvent = {
        event: 'content_block_start',
        data: {
          content_block: {
            type: 'server_tool_use',
            id: 'srvtoolu_test123',
            name: 'web_search',
            input: { query: 'capital of Canada' },
          },
        },
      };
      const state = createMapperState();

      const result = mapAnthropicEventToStreamChunks(sseEvent, state);

      expect(result.chunks).toContainEqual({
        type: 'web_search',
        id: 'srvtoolu_test123',
        query: 'capital of Canada',
      });
    });

    it('maps web_search_tool_result to web_search.result entries', () => {
      const sseEvent = {
        event: 'content_block_start',
        data: {
          content_block: {
            type: 'web_search_tool_result',
            tool_use_id: 'srvtoolu_test123',
            content: [
              {
                type: 'web_search_result',
                title: 'Ottawa - Wikipedia',
                url: 'https://en.wikipedia.org/wiki/Ottawa',
              },
              { type: 'web_search_result', title: 'Canada.ca', url: 'https://www.canada.ca/' },
            ],
          },
        },
      };
      const state = createMapperState();

      const result = mapAnthropicEventToStreamChunks(sseEvent, state);

      expect(result.chunks).toContainEqual({
        type: 'web_search.result',
        tool_use_id: 'srvtoolu_test123',
        title: 'Ottawa - Wikipedia',
        url: 'https://en.wikipedia.org/wiki/Ottawa',
      });
      expect(result.chunks).toContainEqual({
        type: 'web_search.result',
        tool_use_id: 'srvtoolu_test123',
        title: 'Canada.ca',
        url: 'https://www.canada.ca/',
      });
    });

    it('handles web_search_tool_result with non-array content gracefully', () => {
      // Edge case: content is not an array (e.g., empty object or other format)
      const sseEvent = {
        event: 'content_block_start',
        data: {
          content_block: {
            type: 'web_search_tool_result',
            tool_use_id: 'srvtoolu_test123',
            content: {}, // Non-array content should not crash
          },
        },
      };
      const state = createMapperState();

      // Should not throw
      const result = mapAnthropicEventToStreamChunks(sseEvent, state);

      // Should only have the event chunk, no web_search.result chunks
      expect(result.chunks).toHaveLength(1);
      expect(result.chunks[0]).toEqual({ type: 'event', content: 'content_block_start' });
    });

    it('maps server_tool_use (web_fetch) to web_fetch', () => {
      const sseEvent = {
        event: 'content_block_start',
        data: {
          content_block: {
            type: 'server_tool_use',
            id: 'srvtoolu_test456',
            name: 'web_fetch',
            input: {
              url: 'https://raw.githubusercontent.com/cline/cline/refs/heads/main/README.md',
            },
          },
        },
      };
      const state = createMapperState();

      const result = mapAnthropicEventToStreamChunks(sseEvent, state);

      expect(result.chunks).toContainEqual({
        type: 'web_fetch',
        id: 'srvtoolu_test456',
        url: 'https://raw.githubusercontent.com/cline/cline/refs/heads/main/README.md',
      });
    });

    it('maps web_fetch_tool_result to web_fetch.result', () => {
      const sseEvent = {
        event: 'content_block_start',
        data: {
          content_block: {
            type: 'web_fetch_tool_result',
            tool_use_id: 'srvtoolu_test456',
            content: {
              type: 'web_fetch_result',
              url: 'https://raw.githubusercontent.com/cline/cline/refs/heads/main/README.md',
              retrieved_at: '2025-11-27T10:23:02.942000+00:00',
              title: null,
            },
          },
        },
      };
      const state = createMapperState();

      const result = mapAnthropicEventToStreamChunks(sseEvent, state);

      expect(result.chunks).toContainEqual({
        type: 'web_fetch.result',
        tool_use_id: 'srvtoolu_test456',
        url: 'https://raw.githubusercontent.com/cline/cline/refs/heads/main/README.md',
        title: null,
      });
    });

    it('maps web_fetch.start for pending tool use', () => {
      const sseEvent = {
        event: 'content_block_start',
        data: {
          content_block: {
            type: 'server_tool_use',
            id: 'srvtoolu_pending',
            name: 'web_fetch',
            input: {},
          },
        },
      };
      const state = createMapperState();

      const result = mapAnthropicEventToStreamChunks(sseEvent, state);

      expect(result.chunks).toContainEqual({
        type: 'web_fetch.start',
        id: 'srvtoolu_pending',
      });
      expect(result.state.pendingToolUse).toEqual({
        id: 'srvtoolu_pending',
        name: 'web_fetch',
        inputJson: '',
      });
    });

    it('maps message_stop with token_usage', () => {
      const sseEvent = { event: 'message_stop', data: {} };
      const state = {
        ...createMapperState(),
        inputTokens: 100,
        outputTokens: 50,
        cacheCreationTokens: 20,
        cacheReadTokens: 10,
      };

      const result = mapAnthropicEventToStreamChunks(sseEvent, state);

      expect(result.chunks).toContainEqual({
        type: 'token_usage',
        inputTokens: 100,
        outputTokens: 50,
        cacheCreationTokens: 20,
        cacheReadTokens: 10,
      });
    });
  });

  describe('real-world data snapshot', () => {
    it('parses multiple-step-thinking-stream.txt and generates StreamChunks', () => {
      // Load the real SSE data
      const sseFilePath = join(__dirname, 'anthropic-multiple-step-thinking-stream.txt');
      const sseText = readFileSync(sseFilePath, 'utf-8');

      // Parse to StreamChunks
      const chunks = parseSSEToStreamChunks(sseText);

      // Basic validation
      expect(chunks.length).toBeGreaterThan(0);

      // Verify we have expected chunk types
      const chunkTypes = new Set(chunks.map(c => c.type));
      expect(chunkTypes).toContain('event');
      expect(chunkTypes).toContain('thinking.start');
      expect(chunkTypes).toContain('thinking');
      expect(chunkTypes).toContain('thinking.end');
      expect(chunkTypes).toContain('content.start');
      expect(chunkTypes).toContain('content');
      expect(chunkTypes).toContain('content.end');
      expect(chunkTypes).toContain('web_search.result');
      expect(chunkTypes).toContain('token_usage');

      // Count thinking blocks (should be 3)
      const thinkingStarts = chunks.filter(c => c.type === 'thinking.start');
      expect(thinkingStarts.length).toBe(3);

      // Snapshot test the chunks
      expect(chunks).toMatchSnapshot();

      // Also write out the JSON for use by StreamingContentAssembler tests
      const outputPath = join(__dirname, 'anthropic-multiple-step-thinking-streamChunks.json');
      writeFileSync(outputPath, JSON.stringify(chunks, null, 2) + '\n', 'utf-8');
    });

    it('parses webfetch-stream.txt and generates web_fetch StreamChunks', () => {
      // Load the real webfetch SSE data
      const sseFilePath = join(__dirname, 'anthropic-webfetch-stream.txt');
      const sseText = readFileSync(sseFilePath, 'utf-8');

      // Parse to StreamChunks
      const chunks = parseSSEToStreamChunks(sseText);

      // Basic validation
      expect(chunks.length).toBeGreaterThan(0);

      // Verify we have expected chunk types for web_fetch
      const chunkTypes = new Set(chunks.map(c => c.type));
      expect(chunkTypes).toContain('event');
      expect(chunkTypes).toContain('thinking.start');
      expect(chunkTypes).toContain('thinking');
      expect(chunkTypes).toContain('thinking.end');
      expect(chunkTypes).toContain('web_fetch');
      expect(chunkTypes).toContain('content.start');
      expect(chunkTypes).toContain('content');
      expect(chunkTypes).toContain('content.end');
      expect(chunkTypes).toContain('token_usage');

      // Count thinking blocks (should be 2)
      const thinkingStarts = chunks.filter(c => c.type === 'thinking.start');
      expect(thinkingStarts.length).toBe(2);

      // Count web_fetch chunks (should be 1)
      const webFetchChunks = chunks.filter(c => c.type === 'web_fetch');
      expect(webFetchChunks.length).toBe(1);

      // Verify web_fetch chunk content
      const webFetchChunk = webFetchChunks[0] as { type: 'web_fetch'; id: string; url: string };
      expect(webFetchChunk.id).toBe('srvtoolu_id1');
      expect(webFetchChunk.url).toBe(
        'https://raw.githubusercontent.com/cline/cline/refs/heads/main/README.md'
      );

      // Verify token_usage is present
      const tokenUsageChunks = chunks.filter(c => c.type === 'token_usage');
      expect(tokenUsageChunks.length).toBe(1);

      // Also write out the JSON for use by StreamingContentAssembler tests
      const outputPath = join(__dirname, 'anthropic-webfetch-streamChunks.json');
      writeFileSync(outputPath, JSON.stringify(chunks, null, 2) + '\n', 'utf-8');
    });
  });
});
