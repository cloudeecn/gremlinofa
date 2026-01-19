import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  createMapperState,
  mapCompletionChunkToStreamChunks,
  convertMessageToStreamChunks,
  parseSSEToStreamChunks,
} from '../completionStreamMapper';

describe('completionStreamMapper', () => {
  describe('createMapperState', () => {
    it('creates initial state with correct defaults', () => {
      const state = createMapperState();
      expect(state.inReasoningBlock).toBe(false);
      expect(state.inContentBlock).toBe(false);
      expect(state.toolCalls.size).toBe(0);
    });
  });

  describe('mapCompletionChunkToStreamChunks', () => {
    describe('content handling', () => {
      it('emits content.start and content on first content delta', () => {
        const state = createMapperState();
        const { chunks, state: newState } = mapCompletionChunkToStreamChunks(
          {
            choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: null }],
          },
          state
        );
        expect(chunks).toContainEqual({ type: 'content.start' });
        expect(chunks).toContainEqual({ type: 'content', content: 'Hello' });
        expect(newState.inContentBlock).toBe(true);
      });

      it('emits only content on subsequent content deltas', () => {
        let state = createMapperState();
        state.inContentBlock = true;
        const { chunks } = mapCompletionChunkToStreamChunks(
          {
            choices: [{ index: 0, delta: { content: ' world' }, finish_reason: null }],
          },
          state
        );
        expect(chunks).toEqual([{ type: 'content', content: ' world' }]);
      });

      it('emits content.end on stop finish_reason', () => {
        let state = createMapperState();
        state.inContentBlock = true;
        const { chunks, state: newState } = mapCompletionChunkToStreamChunks(
          {
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          },
          state
        );
        expect(chunks).toContainEqual({ type: 'content.end' });
        expect(newState.inContentBlock).toBe(false);
      });
    });

    describe('reasoning handling', () => {
      it('emits thinking.start and thinking on first reasoning delta', () => {
        const state = createMapperState();
        const { chunks, state: newState } = mapCompletionChunkToStreamChunks(
          {
            choices: [{ index: 0, delta: { reasoning: 'Let me think...' }, finish_reason: null }],
          },
          state
        );
        expect(chunks).toContainEqual({ type: 'thinking.start' });
        expect(chunks).toContainEqual({ type: 'thinking', content: 'Let me think...' });
        expect(newState.inReasoningBlock).toBe(true);
      });

      it('emits thinking.end when transitioning to content', () => {
        let state = createMapperState();
        state.inReasoningBlock = true;
        const { chunks, state: newState } = mapCompletionChunkToStreamChunks(
          {
            choices: [{ index: 0, delta: { content: 'Here is my answer' }, finish_reason: null }],
          },
          state
        );
        expect(chunks).toContainEqual({ type: 'thinking.end' });
        expect(chunks).toContainEqual({ type: 'content.start' });
        expect(chunks).toContainEqual({ type: 'content', content: 'Here is my answer' });
        expect(newState.inReasoningBlock).toBe(false);
        expect(newState.inContentBlock).toBe(true);
      });
    });

    describe('tool call handling', () => {
      it('accumulates tool call arguments across chunks', () => {
        let state = createMapperState();

        // First chunk - tool call start
        const result1 = mapCompletionChunkToStreamChunks(
          {
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_123',
                      type: 'function',
                      function: { name: 'ping', arguments: '{}' },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          },
          state
        );
        state = result1.state;
        expect(state.toolCalls.get(0)).toEqual({
          id: 'call_123',
          name: 'ping',
          arguments: '{}',
        });

        // No tool_use emitted yet (waiting for finish_reason)
        expect(result1.chunks.filter(c => c.type === 'tool_use')).toHaveLength(0);
      });

      it('emits tool_use on tool_calls finish_reason', () => {
        let state = createMapperState();
        state.toolCalls.set(0, { id: 'call_123', name: 'ping', arguments: '{}' });

        const { chunks } = mapCompletionChunkToStreamChunks(
          {
            choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
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

      it('closes content block when tool calls start', () => {
        let state = createMapperState();
        state.inContentBlock = true;

        const { chunks, state: newState } = mapCompletionChunkToStreamChunks(
          {
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    { index: 0, id: 'call_1', function: { name: 'test', arguments: '' } },
                  ],
                },
                finish_reason: null,
              },
            ],
          },
          state
        );

        expect(chunks).toContainEqual({ type: 'content.end' });
        expect(newState.inContentBlock).toBe(false);
      });
    });

    describe('token usage handling', () => {
      it('emits token_usage from usage object', () => {
        const state = createMapperState();
        const { chunks } = mapCompletionChunkToStreamChunks(
          {
            choices: [],
            usage: {
              prompt_tokens: 100,
              completion_tokens: 50,
              prompt_tokens_details: { cached_tokens: 20 },
              completion_tokens_details: { reasoning_tokens: 10 },
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
      });
    });
  });

  describe('convertMessageToStreamChunks', () => {
    it('converts text content to content chunks', () => {
      const chunks = convertMessageToStreamChunks({
        role: 'assistant',
        content: 'Hello world',
        refusal: null,
      });

      expect(chunks).toEqual([
        { type: 'content.start' },
        { type: 'content', content: 'Hello world' },
        { type: 'content.end' },
      ]);
    });

    it('converts tool calls to tool_use chunks', () => {
      const chunks = convertMessageToStreamChunks({
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_123',
            type: 'function',
            function: { name: 'ping', arguments: '{}' },
          },
        ],
        refusal: null,
      });

      expect(chunks).toContainEqual({
        type: 'tool_use',
        id: 'call_123',
        name: 'ping',
        input: {},
      });
    });

    it('handles content + tool_calls together', () => {
      const chunks = convertMessageToStreamChunks({
        role: 'assistant',
        content: 'I will use a tool',
        tool_calls: [
          {
            id: 'call_456',
            type: 'function',
            function: { name: 'javascript', arguments: '{"code":"1+1"}' },
          },
        ],
        refusal: null,
      });

      expect(chunks).toContainEqual({ type: 'content.start' });
      expect(chunks).toContainEqual({ type: 'content', content: 'I will use a tool' });
      expect(chunks).toContainEqual({ type: 'content.end' });
      expect(chunks).toContainEqual({
        type: 'tool_use',
        id: 'call_456',
        name: 'javascript',
        input: { code: '1+1' },
      });
    });
  });

  describe('parseSSEToStreamChunks (full stream parsing)', () => {
    it('parses text + tool call stream', () => {
      const sseText = fs.readFileSync(
        path.join(__dirname, 'completion-text-toolcall-stream.txt'),
        'utf8'
      );
      const expectedChunks = JSON.parse(
        fs.readFileSync(path.join(__dirname, 'completion-text-toolcall-streamChunks.json'), 'utf8')
      );

      const chunks = parseSSEToStreamChunks(sseText);
      expect(chunks).toEqual(expectedChunks);
    });

    it('parses reasoning + tool call stream', () => {
      const sseText = fs.readFileSync(
        path.join(__dirname, 'completion-reason-toolcall-stream.txt'),
        'utf8'
      );
      const expectedChunks = JSON.parse(
        fs.readFileSync(
          path.join(__dirname, 'completion-reason-toolcall-streamChunks.json'),
          'utf8'
        )
      );

      const chunks = parseSSEToStreamChunks(sseText);
      expect(chunks).toEqual(expectedChunks);
    });
  });

  describe('full pipeline: streaming → chunks → rendering', () => {
    it('generates correct rendering from text + tool call stream', async () => {
      const { StreamingContentAssembler } =
        await import('../../streaming/StreamingContentAssembler');

      const sseText = fs.readFileSync(
        path.join(__dirname, 'completion-text-toolcall-stream.txt'),
        'utf8'
      );

      const chunks = parseSSEToStreamChunks(sseText);
      const assembler = new StreamingContentAssembler();
      for (const chunk of chunks) {
        assembler.pushChunk(chunk);
      }
      const rendering = assembler.finalize();

      // Should have text group
      const textGroups = rendering.filter(g => g.category === 'text');
      expect(textGroups.length).toBe(1);
      expect(textGroups[0].blocks[0]).toMatchObject({
        type: 'text',
        text: "I'll generate 2 random numbers, multiply them, and store the result using the filesystem tool.",
      });

      // Should have backstage group with tool_use
      const backstageGroups = rendering.filter(g => g.category === 'backstage');
      expect(backstageGroups.length).toBe(1);
      expect(backstageGroups[0].blocks[0]).toMatchObject({
        type: 'tool_use',
        name: 'javascript',
      });
    });

    it('generates correct rendering from reasoning + tool call stream', async () => {
      const { StreamingContentAssembler } =
        await import('../../streaming/StreamingContentAssembler');

      const sseText = fs.readFileSync(
        path.join(__dirname, 'completion-reason-toolcall-stream.txt'),
        'utf8'
      );

      const chunks = parseSSEToStreamChunks(sseText);
      const assembler = new StreamingContentAssembler();
      for (const chunk of chunks) {
        assembler.pushChunk(chunk);
      }
      const rendering = assembler.finalize();

      // Should have backstage group with thinking
      const backstageGroups = rendering.filter(g => g.category === 'backstage');
      expect(backstageGroups.length).toBe(1);
      expect(backstageGroups[0].blocks.length).toBe(2); // thinking + tool_use

      const thinkingBlock = backstageGroups[0].blocks.find(b => b.type === 'thinking');
      expect(thinkingBlock).toBeDefined();
      if (thinkingBlock && thinkingBlock.type === 'thinking') {
        expect(thinkingBlock.thinking).toContain('use javascript to generate 2 random numbers');
      }

      const toolUseBlock = backstageGroups[0].blocks.find(b => b.type === 'tool_use');
      expect(toolUseBlock).toBeDefined();
      if (toolUseBlock && toolUseBlock.type === 'tool_use') {
        expect(toolUseBlock.name).toBe('javascript');
      }
    });
  });
});
