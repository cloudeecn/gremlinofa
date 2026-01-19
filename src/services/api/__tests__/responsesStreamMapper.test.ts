import type OpenAI from 'openai';
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  createMapperState,
  parseResponsesSSEText,
  mapResponsesEventToStreamChunks,
  parseSSEToStreamChunks,
  convertOutputToStreamChunks,
  createTokenUsageChunk,
  parseResponsesStreamEvent,
} from '../responsesStreamMapper';

describe('responsesStreamMapper', () => {
  describe('createMapperState', () => {
    it('creates initial state with correct defaults', () => {
      const state = createMapperState();
      expect(state.inReasoningBlock).toBe(false);
      expect(state.inContentBlock).toBe(false);
      expect(state.currentReasoningItemId).toBeNull();
      expect(state.pendingWebSearches.size).toBe(0);
      expect(state.inputTokens).toBe(0);
      expect(state.outputTokens).toBe(0);
    });
  });

  describe('parseResponsesSSEText', () => {
    it('parses single SSE event', () => {
      const text = `event: response.created
data: {"type":"response.created","response":{"id":"1"}}

`;
      const events = parseResponsesSSEText(text);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('response.created');
      expect(events[0].data.type).toBe('response.created');
    });

    it('parses multiple SSE events', () => {
      const text = `event: response.created
data: {"type":"response.created"}

event: response.in_progress
data: {"type":"response.in_progress"}

`;
      const events = parseResponsesSSEText(text);
      expect(events).toHaveLength(2);
      expect(events[0].type).toBe('response.created');
      expect(events[1].type).toBe('response.in_progress');
    });

    it('skips malformed JSON', () => {
      const text = `event: bad_event
data: {invalid json}

event: good_event
data: {"valid":true}

`;
      const events = parseResponsesSSEText(text);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('good_event');
    });
  });

  describe('parseResponsesStreamEvent', () => {
    it('extracts type from chunk data', () => {
      // Partial mock - cast through unknown since SDK type requires additional fields
      const chunk = {
        type: 'response.output_text.delta' as const,
        delta: 'Hello',
        item_id: '123',
        output_index: 0,
        sequence_number: 0,
      } as OpenAI.Responses.ResponseStreamEvent;
      const event = parseResponsesStreamEvent(chunk);
      expect(event.type).toBe('response.output_text.delta');
      expect(event.data).toBe(chunk);
    });
  });

  describe('mapResponsesEventToStreamChunks', () => {
    describe('reasoning events', () => {
      it('emits thinking.start on reasoning output_item.added', () => {
        const state = createMapperState();
        const { chunks, state: newState } = mapResponsesEventToStreamChunks(
          {
            type: 'response.output_item.added',
            data: { item: { type: 'reasoning', id: 'rs_1' } },
          },
          state
        );
        expect(chunks).toContainEqual({ type: 'thinking.start' });
        expect(newState.inReasoningBlock).toBe(true);
        expect(newState.currentReasoningItemId).toBe('rs_1');
      });

      it('emits thinking content on reasoning_summary_text.delta', () => {
        const state = createMapperState();
        state.inReasoningBlock = true;
        const { chunks } = mapResponsesEventToStreamChunks(
          {
            type: 'response.reasoning_summary_text.delta',
            data: { delta: 'First,' },
          },
          state
        );
        expect(chunks).toContainEqual({ type: 'thinking', content: 'First,' });
      });

      it('emits thinking content on reasoning_text.delta', () => {
        const state = createMapperState();
        state.inReasoningBlock = true;
        const { chunks } = mapResponsesEventToStreamChunks(
          {
            type: 'response.reasoning_text.delta',
            data: { delta: 'The user has just' },
          },
          state
        );
        expect(chunks).toContainEqual({ type: 'thinking', content: 'The user has just' });
      });

      it('emits thinking.start on reasoning_text.delta if not in block', () => {
        const state = createMapperState();
        const { chunks, state: newState } = mapResponsesEventToStreamChunks(
          {
            type: 'response.reasoning_text.delta',
            data: { delta: 'Analyzing' },
          },
          state
        );
        expect(chunks).toContainEqual({ type: 'thinking.start' });
        expect(chunks).toContainEqual({ type: 'thinking', content: 'Analyzing' });
        expect(newState.inReasoningBlock).toBe(true);
      });

      it('emits thinking.end on reasoning output_item.done', () => {
        const state = createMapperState();
        state.inReasoningBlock = true;
        const { chunks, state: newState } = mapResponsesEventToStreamChunks(
          {
            type: 'response.output_item.done',
            data: { item: { type: 'reasoning', id: 'rs_1' } },
          },
          state
        );
        expect(chunks).toContainEqual({ type: 'thinking.end' });
        expect(newState.inReasoningBlock).toBe(false);
      });
    });

    describe('content events', () => {
      it('emits content.start on content_part.added with output_text', () => {
        const state = createMapperState();
        const { chunks, state: newState } = mapResponsesEventToStreamChunks(
          {
            type: 'response.content_part.added',
            data: { part: { type: 'output_text' } },
          },
          state
        );
        expect(chunks).toContainEqual({ type: 'content.start' });
        expect(newState.inContentBlock).toBe(true);
      });

      it('emits content on output_text.delta', () => {
        const state = createMapperState();
        state.inContentBlock = true;
        const { chunks } = mapResponsesEventToStreamChunks(
          {
            type: 'response.output_text.delta',
            data: { delta: 'Hello' },
          },
          state
        );
        expect(chunks).toContainEqual({ type: 'content', content: 'Hello' });
      });

      it('emits content.start if not in block on delta', () => {
        const state = createMapperState();
        const { chunks, state: newState } = mapResponsesEventToStreamChunks(
          {
            type: 'response.output_text.delta',
            data: { delta: 'Hello' },
          },
          state
        );
        expect(chunks).toContainEqual({ type: 'content.start' });
        expect(chunks).toContainEqual({ type: 'content', content: 'Hello' });
        expect(newState.inContentBlock).toBe(true);
      });

      it('emits content.end on content_part.done', () => {
        const state = createMapperState();
        state.inContentBlock = true;
        const { chunks, state: newState } = mapResponsesEventToStreamChunks(
          {
            type: 'response.content_part.done',
            data: { part: { type: 'output_text' } },
          },
          state
        );
        expect(chunks).toContainEqual({ type: 'content.end' });
        expect(newState.inContentBlock).toBe(false);
      });
    });

    describe('web search events', () => {
      it('emits web_search.start on web_search_call added', () => {
        const state = createMapperState();
        const { chunks, state: newState } = mapResponsesEventToStreamChunks(
          {
            type: 'response.output_item.added',
            data: { item: { type: 'web_search_call', id: 'ws_1' } },
          },
          state
        );
        expect(chunks).toContainEqual({ type: 'web_search.start', id: 'ws_1' });
        expect(newState.pendingWebSearches.has('ws_1')).toBe(true);
      });

      it('emits web_search on search action done', () => {
        const state = createMapperState();
        state.pendingWebSearches.set('ws_1', { query: '' });
        const { chunks, state: newState } = mapResponsesEventToStreamChunks(
          {
            type: 'response.output_item.done',
            data: {
              item: {
                type: 'web_search_call',
                id: 'ws_1',
                action: { type: 'search', query: 'weather today' },
              },
            },
          },
          state
        );
        expect(chunks).toContainEqual({
          type: 'web_search',
          id: 'ws_1',
          query: 'weather today',
        });
        expect(newState.pendingWebSearches.has('ws_1')).toBe(false);
      });

      it('emits web_search with URL for open_page action', () => {
        const state = createMapperState();
        const { chunks } = mapResponsesEventToStreamChunks(
          {
            type: 'response.output_item.done',
            data: {
              item: {
                type: 'web_search_call',
                id: 'ws_2',
                action: { type: 'open_page', url: 'https://example.com' },
              },
            },
          },
          state
        );
        expect(chunks).toContainEqual({
          type: 'web_search',
          id: 'ws_2',
          query: 'Opening: https://example.com',
        });
      });
    });

    describe('function call events', () => {
      it('emits tool_use on function_call done', () => {
        const state = createMapperState();
        const { chunks } = mapResponsesEventToStreamChunks(
          {
            type: 'response.output_item.done',
            data: {
              item: {
                type: 'function_call',
                id: 'fc_1',
                call_id: 'call_123',
                name: 'ping',
                arguments: '{}',
              },
            },
          },
          state
        );
        expect(chunks).toContainEqual({
          type: 'tool_use',
          id: 'call_123',
          name: 'ping',
          input: {},
        });
      });

      it('handles function_call with complex arguments', () => {
        const state = createMapperState();
        const { chunks } = mapResponsesEventToStreamChunks(
          {
            type: 'response.output_item.done',
            data: {
              item: {
                type: 'function_call',
                id: 'fc_2',
                call_id: 'call_456',
                name: 'memory',
                arguments: '{"command":"create","path":"/test.txt"}',
              },
            },
          },
          state
        );
        expect(chunks).toContainEqual({
          type: 'tool_use',
          id: 'call_456',
          name: 'memory',
          input: { command: 'create', path: '/test.txt' },
        });
      });
    });

    describe('token usage events', () => {
      it('emits token_usage on response.completed', () => {
        const state = createMapperState();
        const { chunks, state: newState } = mapResponsesEventToStreamChunks(
          {
            type: 'response.completed',
            data: {
              response: {
                usage: {
                  input_tokens: 100,
                  output_tokens: 50,
                  input_tokens_details: { cached_tokens: 20 },
                  output_tokens_details: { reasoning_tokens: 10 },
                },
              },
            },
          },
          state
        );
        expect(chunks).toContainEqual({
          type: 'token_usage',
          inputTokens: 80, // 100 - 20 cached
          outputTokens: 50,
          cacheReadTokens: 20,
          reasoningTokens: 10,
        });
        expect(newState.inputTokens).toBe(80);
        expect(newState.outputTokens).toBe(50);
      });

      it('closes open blocks on response.completed', () => {
        const state = createMapperState();
        state.inContentBlock = true;
        state.inReasoningBlock = true;
        const { chunks } = mapResponsesEventToStreamChunks(
          {
            type: 'response.completed',
            data: { response: { usage: { input_tokens: 10, output_tokens: 5 } } },
          },
          state
        );
        expect(chunks).toContainEqual({ type: 'content.end' });
        expect(chunks).toContainEqual({ type: 'thinking.end' });
      });
    });
  });

  describe('parseSSEToStreamChunks (full stream parsing)', () => {
    it('parses reasoning + function call stream', () => {
      const sseText = fs.readFileSync(
        path.join(__dirname, 'responses-reason-memory-stream.txt'),
        'utf8'
      );
      const chunks = parseSSEToStreamChunks(sseText);

      // Should have thinking chunks
      const thinkingStart = chunks.find(c => c.type === 'thinking.start');
      const thinkingEnd = chunks.find(c => c.type === 'thinking.end');
      const thinkingContent = chunks.filter(c => c.type === 'thinking');
      expect(thinkingStart).toBeDefined();
      expect(thinkingEnd).toBeDefined();
      expect(thinkingContent.length).toBeGreaterThan(0);

      // Should have tool_use chunk
      const toolUse = chunks.find(c => c.type === 'tool_use');
      expect(toolUse).toBeDefined();
      if (toolUse && toolUse.type === 'tool_use') {
        expect(toolUse.name).toBe('ping');
        expect(toolUse.id).toBe('call_1');
      }

      // Should have token_usage chunk
      const tokenUsage = chunks.find(c => c.type === 'token_usage');
      expect(tokenUsage).toBeDefined();
    });

    it('parses web search + function call stream', () => {
      const sseText = fs.readFileSync(
        path.join(__dirname, 'responses-search-memory-stream.txt'),
        'utf8'
      );
      const chunks = parseSSEToStreamChunks(sseText);

      // Should have web_search chunks
      const webSearchStart = chunks.filter(c => c.type === 'web_search.start');
      const webSearchQuery = chunks.filter(c => c.type === 'web_search');
      expect(webSearchStart.length).toBeGreaterThan(0);
      expect(webSearchQuery.length).toBeGreaterThan(0);

      // Check for search query
      const searchChunk = webSearchQuery.find(
        c => c.type === 'web_search' && c.query === 'Vancouver weather tomorrow'
      );
      expect(searchChunk).toBeDefined();

      // Should have tool_use chunk for memory
      const toolUse = chunks.find(c => c.type === 'tool_use');
      expect(toolUse).toBeDefined();
      if (toolUse && toolUse.type === 'tool_use') {
        expect(toolUse.name).toBe('memory');
      }
    });

    it('parses reasoning_text stream (OpenRouter format)', () => {
      const sseText = fs.readFileSync(
        path.join(__dirname, 'responses-reasoning-text-stream.txt'),
        'utf8'
      );
      const expectedChunks = JSON.parse(
        fs.readFileSync(path.join(__dirname, 'responses-reasoning-text-streamChunks.json'), 'utf8')
      );
      const chunks = parseSSEToStreamChunks(sseText);

      expect(chunks).toEqual(expectedChunks);
    });
  });

  describe('convertOutputToStreamChunks (Phase 2)', () => {
    it('converts reasoning output to thinking chunks', () => {
      const output = [
        {
          type: 'reasoning' as const,
          id: 'rs_1',
          summary: [{ type: 'summary_text' as const, text: 'First, the user wants...' }],
        },
      ];
      const chunks = convertOutputToStreamChunks(output);

      expect(chunks).toContainEqual({ type: 'thinking.start' });
      expect(chunks).toContainEqual({ type: 'thinking', content: 'First, the user wants...' });
      expect(chunks).toContainEqual({ type: 'thinking.end' });
    });

    it('converts function_call output to tool_use chunk', () => {
      const output = [
        {
          type: 'function_call' as const,
          id: 'fc_1',
          call_id: 'call_123',
          name: 'ping',
          arguments: '{}',
        },
      ];
      const chunks = convertOutputToStreamChunks(output);

      expect(chunks).toContainEqual({
        type: 'tool_use',
        id: 'call_123',
        name: 'ping',
        input: {},
      });
    });

    it('converts web_search_call output to web_search chunks', () => {
      // Test mock with action property - cast through unknown since SDK type doesn't expose action
      const output = [
        {
          type: 'web_search_call' as const,
          id: 'ws_1',
          status: 'completed' as const,
          action: {
            type: 'search' as const,
            query: 'weather today',
            sources: [{ url: 'https://example.com', title: 'Example' }],
          },
        },
      ] as unknown as OpenAI.Responses.ResponseOutputItem[];
      const chunks = convertOutputToStreamChunks(output);

      expect(chunks).toContainEqual({ type: 'web_search.start', id: 'ws_1' });
      expect(chunks).toContainEqual({ type: 'web_search', id: 'ws_1', query: 'weather today' });
      expect(chunks).toContainEqual({
        type: 'web_search.result',
        tool_use_id: 'ws_1',
        url: 'https://example.com',
        title: 'Example',
      });
    });

    it('converts message output to content chunks', () => {
      // Test mock - cast through unknown since SDK type requires additional fields
      const output = [
        {
          type: 'message' as const,
          id: 'msg_1',
          role: 'assistant' as const,
          status: 'completed' as const,
          content: [{ type: 'output_text' as const, text: 'Hello world' }],
        },
      ] as unknown as OpenAI.Responses.ResponseOutputItem[];
      const chunks = convertOutputToStreamChunks(output);

      expect(chunks).toContainEqual({ type: 'content.start' });
      expect(chunks).toContainEqual({ type: 'content', content: 'Hello world' });
      expect(chunks).toContainEqual({ type: 'content.end' });
    });

    it('converts full message output from test data', () => {
      const messageJson = fs.readFileSync(
        path.join(__dirname, 'responses-reason-memory-message.json'),
        'utf8'
      );
      const output = JSON.parse(messageJson);
      const chunks = convertOutputToStreamChunks(output);

      // Should have thinking chunks
      expect(chunks.filter(c => c.type === 'thinking.start').length).toBe(1);
      expect(chunks.filter(c => c.type === 'thinking.end').length).toBe(1);

      // Should have tool_use chunk
      const toolUse = chunks.find(c => c.type === 'tool_use');
      expect(toolUse).toBeDefined();
      if (toolUse && toolUse.type === 'tool_use') {
        expect(toolUse.name).toBe('ping');
      }
    });

    it('converts search message output from test data', () => {
      const messageJson = fs.readFileSync(
        path.join(__dirname, 'responses-search-memory-message.json'),
        'utf8'
      );
      const output = JSON.parse(messageJson);
      const chunks = convertOutputToStreamChunks(output);

      // Should have web_search chunks
      const webSearchStart = chunks.filter(c => c.type === 'web_search.start');
      expect(webSearchStart.length).toBe(5); // 5 web search calls in the test data

      // Should have tool_use chunk for memory
      const toolUse = chunks.find(c => c.type === 'tool_use');
      expect(toolUse).toBeDefined();
      if (toolUse && toolUse.type === 'tool_use') {
        expect(toolUse.name).toBe('memory');
      }
    });

    it('skips non-assistant messages', () => {
      // Test mock - cast through unknown since SDK type requires additional fields
      const output = [
        {
          type: 'message' as const,
          id: 'msg_1',
          role: 'user' as const,
          status: 'completed' as const,
          content: [{ type: 'output_text' as const, text: 'User message' }],
        },
      ] as unknown as OpenAI.Responses.ResponseOutputItem[];
      const chunks = convertOutputToStreamChunks(output);

      // Should not have content chunks for user messages
      expect(chunks.filter(c => c.type === 'content')).toHaveLength(0);
    });

    it('converts reasoning_text content to thinking chunks (OpenRouter format)', () => {
      const messageJson = fs.readFileSync(
        path.join(__dirname, 'responses-reasoning-text-message.json'),
        'utf8'
      );
      const output = JSON.parse(messageJson);
      const chunks = convertOutputToStreamChunks(output);

      // Should have thinking chunks from reasoning_text content
      expect(chunks.filter(c => c.type === 'thinking.start').length).toBe(1);
      expect(chunks.filter(c => c.type === 'thinking.end').length).toBe(1);

      // Should have the reasoning content
      const thinkingChunk = chunks.find(c => c.type === 'thinking');
      expect(thinkingChunk).toBeDefined();
      if (thinkingChunk && thinkingChunk.type === 'thinking') {
        expect(thinkingChunk.content).toContain('user has just sent a greeting');
      }

      // Should have content chunks
      expect(chunks.filter(c => c.type === 'content.start').length).toBe(1);
      expect(chunks.filter(c => c.type === 'content.end').length).toBe(1);
    });
  });

  describe('full pipeline: streaming (stream.txt � chunks � rendering)', () => {
    it('generates correct rendering from reason+memory stream', async () => {
      const { StreamingContentAssembler } =
        await import('../../streaming/StreamingContentAssembler');

      const sseText = fs.readFileSync(
        path.join(__dirname, 'responses-reason-memory-stream.txt'),
        'utf8'
      );
      const expectedRendering = JSON.parse(
        fs.readFileSync(
          path.join(__dirname, 'responses-reason-memory-renderingContent.json'),
          'utf8'
        )
      );

      const chunks = parseSSEToStreamChunks(sseText);
      const assembler = new StreamingContentAssembler();
      for (const chunk of chunks) {
        assembler.pushChunk(chunk);
      }
      const rendering = assembler.finalize();

      expect(rendering).toEqual(expectedRendering);
    });

    it('generates correct rendering from search+memory stream', async () => {
      const { StreamingContentAssembler } =
        await import('../../streaming/StreamingContentAssembler');

      const sseText = fs.readFileSync(
        path.join(__dirname, 'responses-search-memory-stream.txt'),
        'utf8'
      );
      const expectedRendering = JSON.parse(
        fs.readFileSync(
          path.join(__dirname, 'responses-search-memory-renderingContent.json'),
          'utf8'
        )
      );

      const chunks = parseSSEToStreamChunks(sseText);
      const assembler = new StreamingContentAssembler();
      for (const chunk of chunks) {
        assembler.pushChunk(chunk);
      }
      const rendering = assembler.finalize();

      expect(rendering).toEqual(expectedRendering);
    });

    it('generates correct rendering from reasoning_text stream (OpenRouter format)', async () => {
      const { StreamingContentAssembler } =
        await import('../../streaming/StreamingContentAssembler');

      const sseText = fs.readFileSync(
        path.join(__dirname, 'responses-reasoning-text-stream.txt'),
        'utf8'
      );
      const expectedRendering = JSON.parse(
        fs.readFileSync(
          path.join(__dirname, 'responses-reasoning-text-renderingContent.json'),
          'utf8'
        )
      );

      const chunks = parseSSEToStreamChunks(sseText);
      const assembler = new StreamingContentAssembler();
      for (const chunk of chunks) {
        assembler.pushChunk(chunk);
      }
      const rendering = assembler.finalize();

      expect(rendering).toEqual(expectedRendering);
    });
  });

  describe('full pipeline: non-streaming (message.json � chunks � rendering)', () => {
    it('generates correct rendering from reason+memory message', async () => {
      const { StreamingContentAssembler } =
        await import('../../streaming/StreamingContentAssembler');

      const output = JSON.parse(
        fs.readFileSync(path.join(__dirname, 'responses-reason-memory-message.json'), 'utf8')
      );
      const expectedRendering = JSON.parse(
        fs.readFileSync(
          path.join(__dirname, 'responses-reason-memory-renderingContent.json'),
          'utf8'
        )
      );

      const chunks = convertOutputToStreamChunks(output);
      const assembler = new StreamingContentAssembler();
      for (const chunk of chunks) {
        assembler.pushChunk(chunk);
      }
      const rendering = assembler.finalize();

      expect(rendering).toEqual(expectedRendering);
    });

    it('generates correct rendering from search+memory message', async () => {
      const { StreamingContentAssembler } =
        await import('../../streaming/StreamingContentAssembler');

      const output = JSON.parse(
        fs.readFileSync(path.join(__dirname, 'responses-search-memory-message.json'), 'utf8')
      );
      const expectedRendering = JSON.parse(
        fs.readFileSync(
          path.join(__dirname, 'responses-search-memory-renderingContent.json'),
          'utf8'
        )
      );

      const chunks = convertOutputToStreamChunks(output);
      const assembler = new StreamingContentAssembler();
      for (const chunk of chunks) {
        assembler.pushChunk(chunk);
      }
      const rendering = assembler.finalize();

      expect(rendering).toEqual(expectedRendering);
    });

    it('generates correct rendering from reasoning_text message (OpenRouter format)', async () => {
      const { StreamingContentAssembler } =
        await import('../../streaming/StreamingContentAssembler');

      const output = JSON.parse(
        fs.readFileSync(path.join(__dirname, 'responses-reasoning-text-message.json'), 'utf8')
      );
      const expectedRendering = JSON.parse(
        fs.readFileSync(
          path.join(__dirname, 'responses-reasoning-text-renderingContent.json'),
          'utf8'
        )
      );

      const chunks = convertOutputToStreamChunks(output);
      const assembler = new StreamingContentAssembler();
      for (const chunk of chunks) {
        assembler.pushChunk(chunk);
      }
      const rendering = assembler.finalize();

      expect(rendering).toEqual(expectedRendering);
    });
  });

  describe('createTokenUsageChunk', () => {
    it('creates token usage chunk with all fields', () => {
      const chunk = createTokenUsageChunk({
        input_tokens: 100,
        output_tokens: 50,
        input_tokens_details: { cached_tokens: 20 },
        output_tokens_details: { reasoning_tokens: 10 },
      });

      expect(chunk.type).toBe('token_usage');
      if (chunk.type === 'token_usage') {
        expect(chunk.inputTokens).toBe(80);
        expect(chunk.outputTokens).toBe(50);
        expect(chunk.cacheReadTokens).toBe(20);
        expect(chunk.reasoningTokens).toBe(10);
      }
    });

    it('handles missing optional fields', () => {
      const chunk = createTokenUsageChunk({
        input_tokens: 100,
        output_tokens: 50,
      });

      expect(chunk.type).toBe('token_usage');
      if (chunk.type === 'token_usage') {
        expect(chunk.inputTokens).toBe(100);
        expect(chunk.outputTokens).toBe(50);
        expect(chunk.cacheReadTokens).toBe(0);
        expect(chunk.reasoningTokens).toBeUndefined();
      }
    });
  });
});
