import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  CompletionFullContentAccumulator,
  createFullContentFromMessage,
} from '../completionFullContentAccumulator';
import type { CompletionChunk } from '../completionStreamMapper';

describe('completionFullContentAccumulator', () => {
  describe('CompletionFullContentAccumulator', () => {
    describe('content accumulation', () => {
      it('accumulates text content from deltas', () => {
        const acc = new CompletionFullContentAccumulator();

        acc.pushChunk({
          choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: null }],
        });
        acc.pushChunk({
          choices: [{ index: 0, delta: { content: ' world' }, finish_reason: null }],
        });

        const result = acc.finalize();
        expect(result.content).toBe('Hello world');
      });

      it('ignores reasoning content (not part of fullContent)', () => {
        const acc = new CompletionFullContentAccumulator();

        acc.pushChunk({
          choices: [{ index: 0, delta: { reasoning: 'Let me think...' }, finish_reason: null }],
        });
        acc.pushChunk({
          choices: [{ index: 0, delta: { content: 'Here is my answer' }, finish_reason: null }],
        });

        const result = acc.finalize();
        // Reasoning should NOT be in fullContent
        expect(result.content).toBe('Here is my answer');
      });
    });

    describe('tool call accumulation', () => {
      it('accumulates tool calls by index', () => {
        const acc = new CompletionFullContentAccumulator();

        // First chunk - tool call start with id and name
        acc.pushChunk({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  { index: 0, id: 'call_123', function: { name: 'ping', arguments: '{' } },
                ],
              },
              finish_reason: null,
            },
          ],
        });

        // Second chunk - arguments continued
        acc.pushChunk({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [{ index: 0, function: { arguments: '}' } }],
              },
              finish_reason: null,
            },
          ],
        });

        const result = acc.finalize();
        expect(result.tool_calls).toHaveLength(1);
        expect(result.tool_calls![0]).toEqual({
          id: 'call_123',
          type: 'function',
          function: { name: 'ping', arguments: '{}' },
        });
      });

      it('accumulates multiple tool calls', () => {
        const acc = new CompletionFullContentAccumulator();

        acc.pushChunk({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  { index: 0, id: 'call_1', function: { name: 'tool1', arguments: '{}' } },
                  { index: 1, id: 'call_2', function: { name: 'tool2', arguments: '{}' } },
                ],
              },
              finish_reason: null,
            },
          ],
        });

        const result = acc.finalize();
        expect(result.tool_calls).toHaveLength(2);
        expect(result.tool_calls![0].id).toBe('call_1');
        expect(result.tool_calls![1].id).toBe('call_2');
      });
    });

    describe('finalize', () => {
      it('returns complete message object structure', () => {
        const acc = new CompletionFullContentAccumulator();
        acc.pushChunk({
          choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: null }],
        });

        const result = acc.finalize();
        expect(result).toEqual({
          role: 'assistant',
          content: 'Hello',
          refusal: null,
        });
      });

      it('returns null content when no content accumulated', () => {
        const acc = new CompletionFullContentAccumulator();
        acc.pushChunk({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  { index: 0, id: 'call_1', function: { name: 'test', arguments: '{}' } },
                ],
              },
              finish_reason: null,
            },
          ],
        });

        const result = acc.finalize();
        expect(result.content).toBeNull();
        expect(result.tool_calls).toBeDefined();
      });

      it('handles chunks with empty choices', () => {
        const acc = new CompletionFullContentAccumulator();
        acc.pushChunk({
          choices: [],
          usage: { prompt_tokens: 100, completion_tokens: 50 },
        });

        const result = acc.finalize();
        expect(result.content).toBeNull();
      });
    });

    describe('getContent', () => {
      it('returns accumulated content', () => {
        const acc = new CompletionFullContentAccumulator();
        acc.pushChunk({
          choices: [{ index: 0, delta: { content: 'Test' }, finish_reason: null }],
        });

        expect(acc.getContent()).toBe('Test');
      });
    });

    describe('full stream accumulation', () => {
      it('produces correct fullContent from text + tool call stream', () => {
        const sseText = fs.readFileSync(
          path.join(__dirname, 'completion-text-toolcall-stream.txt'),
          'utf8'
        );
        const expectedFullContent = JSON.parse(
          fs.readFileSync(path.join(__dirname, 'completion-text-toolcall-fullContent.json'), 'utf8')
        );

        const acc = new CompletionFullContentAccumulator();

        // Parse SSE and push each chunk
        for (const line of sseText.split('\n')) {
          if (line.startsWith('data: ') && !line.includes('[DONE]')) {
            try {
              const chunk = JSON.parse(line.slice(6)) as CompletionChunk;
              acc.pushChunk(chunk);
            } catch {
              // Skip malformed lines
            }
          }
        }

        const result = acc.finalize();
        expect(result).toEqual(expectedFullContent);
      });

      it('produces correct fullContent from reasoning + tool call stream (no reasoning in output)', () => {
        const sseText = fs.readFileSync(
          path.join(__dirname, 'completion-reason-toolcall-stream.txt'),
          'utf8'
        );
        const expectedFullContent = JSON.parse(
          fs.readFileSync(
            path.join(__dirname, 'completion-reason-toolcall-fullContent.json'),
            'utf8'
          )
        );

        const acc = new CompletionFullContentAccumulator();

        // Parse SSE and push each chunk
        for (const line of sseText.split('\n')) {
          if (line.startsWith('data: ') && !line.includes('[DONE]')) {
            try {
              const chunk = JSON.parse(line.slice(6)) as CompletionChunk;
              acc.pushChunk(chunk);
            } catch {
              // Skip malformed lines
            }
          }
        }

        const result = acc.finalize();
        // Key assertion: reasoning is NOT in fullContent
        expect(result).toEqual(expectedFullContent);
      });
    });
  });

  describe('createFullContentFromMessage', () => {
    it('creates fullContent from non-streaming message', () => {
      const message = {
        role: 'assistant',
        content: 'Hello world',
        tool_calls: undefined,
        refusal: null,
      };

      const result = createFullContentFromMessage(message);
      expect(result).toEqual({
        role: 'assistant',
        content: 'Hello world',
        tool_calls: undefined,
        refusal: null,
      });
    });

    it('preserves tool_calls from message', () => {
      const message = {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_123',
            type: 'function' as const,
            function: { name: 'ping', arguments: '{}' },
          },
        ],
        refusal: null,
      };

      const result = createFullContentFromMessage(message);
      expect(result.tool_calls).toEqual(message.tool_calls);
    });

    it('handles missing optional fields', () => {
      const result = createFullContentFromMessage({
        content: 'Hello',
      });

      expect(result).toEqual({
        role: 'assistant',
        content: 'Hello',
        tool_calls: undefined,
        refusal: null,
      });
    });
  });
});
