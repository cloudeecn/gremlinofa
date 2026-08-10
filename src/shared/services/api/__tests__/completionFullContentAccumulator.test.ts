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

      it('keeps reasoning separate from content, under the key it arrived on', () => {
        const acc = new CompletionFullContentAccumulator();

        acc.pushChunk({
          choices: [{ index: 0, delta: { reasoning: 'Let me think...' }, finish_reason: null }],
        });
        acc.pushChunk({
          choices: [{ index: 0, delta: { content: 'Here is my answer' }, finish_reason: null }],
        });

        const result = acc.finalize();
        expect(result.content).toBe('Here is my answer');
        expect(result.reasoning).toBe('Let me think...');
        expect(result.reasoning_content).toBeUndefined();
      });

      it('accumulates reasoning_content deltas (DeepSeek-style)', () => {
        const acc = new CompletionFullContentAccumulator();

        acc.pushChunk({
          choices: [{ index: 0, delta: { reasoning_content: 'First ' }, finish_reason: null }],
        });
        acc.pushChunk({
          choices: [{ index: 0, delta: { reasoning_content: 'then.' }, finish_reason: null }],
        });
        acc.pushChunk({
          choices: [{ index: 0, delta: { content: 'Answer' }, finish_reason: null }],
        });

        const result = acc.finalize();
        expect(result.reasoning_content).toBe('First then.');
        expect(result.reasoning).toBeUndefined();
      });

      it('omits both reasoning keys when the model never reasons', () => {
        const acc = new CompletionFullContentAccumulator();

        acc.pushChunk({
          choices: [{ index: 0, delta: { content: 'Plain' }, finish_reason: 'stop' }],
        });

        expect(acc.finalize()).toEqual({
          role: 'assistant',
          content: 'Plain',
          refusal: null,
        });
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

    describe('reasoning_details accumulation', () => {
      const push = (acc: CompletionFullContentAccumulator, details: unknown[]) =>
        acc.pushChunk({
          choices: [
            {
              index: 0,
              delta: { reasoning_details: details as never },
              finish_reason: null,
            },
          ],
        });

      it('concatenates text fragments and keeps the trailing signature', () => {
        const acc = new CompletionFullContentAccumulator();
        push(acc, [
          {
            type: 'reasoning.text',
            index: 0,
            id: 'r-1',
            format: 'anthropic-claude-v1',
            text: 'Let me ',
          },
        ]);
        push(acc, [{ type: 'reasoning.text', index: 0, id: null, text: 'think.' }]);
        push(acc, [{ type: 'reasoning.text', index: 0, signature: 'sig-abc' }]);

        expect(acc.finalize().reasoning_details).toEqual([
          {
            type: 'reasoning.text',
            index: 0,
            id: 'r-1',
            format: 'anthropic-claude-v1',
            text: 'Let me think.',
            signature: 'sig-abc',
          },
        ]);
      });

      it('does not let a null id on a continuation erase the established one', () => {
        const acc = new CompletionFullContentAccumulator();
        push(acc, [{ type: 'reasoning.text', index: 0, id: 'r-1', text: 'a' }]);
        push(acc, [{ type: 'reasoning.text', index: 0, id: null, text: 'b' }]);

        expect(acc.finalize().reasoning_details?.[0].id).toBe('r-1');
      });

      it('keeps a genuinely null id from the opening fragment', () => {
        const acc = new CompletionFullContentAccumulator();
        push(acc, [{ type: 'reasoning.text', index: 0, id: null, text: 'a' }]);

        expect(acc.finalize().reasoning_details?.[0].id).toBeNull();
      });

      it('merges by array position when index is absent', () => {
        const acc = new CompletionFullContentAccumulator();
        push(acc, [{ type: 'reasoning.text', text: 'one ' }]);
        push(acc, [{ type: 'reasoning.text', text: 'block' }]);

        const details = acc.finalize().reasoning_details;
        expect(details).toHaveLength(1);
        expect(details?.[0].text).toBe('one block');
      });

      it('opens a second block when an index is reused under a different type', () => {
        const acc = new CompletionFullContentAccumulator();
        push(acc, [{ type: 'reasoning.text', index: 0, text: 'visible' }]);
        push(acc, [{ type: 'reasoning.encrypted', index: 0, data: 'AAAA' }]);

        expect(acc.finalize().reasoning_details).toEqual([
          { type: 'reasoning.text', index: 0, text: 'visible' },
          { type: 'reasoning.encrypted', index: 0, data: 'AAAA' },
        ]);
      });

      it('emits blocks in arrival order, not index order', () => {
        const acc = new CompletionFullContentAccumulator();
        push(acc, [{ type: 'reasoning.text', index: 2, text: 'second' }]);
        push(acc, [{ type: 'reasoning.text', index: 1, text: 'first' }]);

        expect(acc.finalize().reasoning_details?.map(d => d.text)).toEqual(['second', 'first']);
      });

      it('carries an unrecognized field through verbatim', () => {
        const acc = new CompletionFullContentAccumulator();
        push(acc, [{ type: 'reasoning.text', index: 0, text: 'a', future_field: { nested: 1 } }]);
        push(acc, [{ type: 'reasoning.text', index: 0, text: 'b' }]);

        expect(acc.finalize().reasoning_details?.[0].future_field).toEqual({ nested: 1 });
      });

      it('omits the key entirely when no details arrived', () => {
        const acc = new CompletionFullContentAccumulator();
        acc.pushChunk({
          choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }],
        });

        expect(acc.finalize().reasoning_details).toBeUndefined();
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

      it('rebuilds a signed reasoning_details block from an OpenRouter stream', () => {
        const sseText = fs.readFileSync(
          path.join(__dirname, 'completion-openrouter-reasoning-stream.txt'),
          'utf8'
        );
        const expectedFullContent = JSON.parse(
          fs.readFileSync(
            path.join(__dirname, 'completion-openrouter-reasoning-fullContent.json'),
            'utf8'
          )
        );

        const acc = new CompletionFullContentAccumulator();
        for (const line of sseText.split('\n')) {
          if (line.startsWith('data: ') && !line.includes('[DONE]')) {
            try {
              acc.pushChunk(JSON.parse(line.slice(6)) as CompletionChunk);
            } catch {
              // Skip malformed lines
            }
          }
        }

        expect(acc.finalize()).toEqual(expectedFullContent);
      });

      it('produces correct fullContent from reasoning + tool call stream', () => {
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
        expect(result).toEqual(expectedFullContent);
        expect(result.reasoning).toContain('Math.random()');
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

    it('passes reasoning_details through by reference, unnormalized', () => {
      const reasoning_details = [
        { type: 'reasoning.text', index: 0, text: 'thought', signature: 'sig' },
      ];
      const result = createFullContentFromMessage({
        role: 'assistant',
        content: 'answer',
        reasoning_details,
        refusal: null,
      });

      expect(result.reasoning_details).toBe(reasoning_details);
    });

    it('omits reasoning_details when the message carried an empty array', () => {
      const result = createFullContentFromMessage({
        role: 'assistant',
        content: 'answer',
        reasoning_details: [],
        refusal: null,
      });

      expect(result.reasoning_details).toBeUndefined();
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

    it('carries reasoning_content through from a non-streaming response', () => {
      const result = createFullContentFromMessage({
        role: 'assistant',
        content: 'Answer',
        reasoning_content: 'Because of X',
        refusal: null,
      });

      expect(result.reasoning_content).toBe('Because of X');
      expect(result.reasoning).toBeUndefined();
    });

    it('carries reasoning through from a non-streaming response', () => {
      const result = createFullContentFromMessage({
        role: 'assistant',
        content: 'Answer',
        reasoning: 'Because of Y',
        refusal: null,
      });

      expect(result.reasoning).toBe('Because of Y');
      expect(result.reasoning_content).toBeUndefined();
    });
  });
});
