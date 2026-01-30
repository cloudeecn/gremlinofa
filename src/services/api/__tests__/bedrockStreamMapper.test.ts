import { describe, it, expect } from 'vitest';
import {
  createMapperState,
  mapBedrockStreamEvent,
  convertConverseResponseToStreamChunks,
  extractContentFromResponse,
  type BedrockMapperState,
} from '../bedrockStreamMapper';
import { BedrockFullContentAccumulator } from '../bedrockFullContentAccumulator';
import type { ConverseStreamOutput, ConverseResponse } from '@aws-sdk/client-bedrock-runtime';

// Helper to create a minimal ConverseResponse object for testing
function createConverseResponse(
  content: Array<Record<string, unknown>>,
  options: {
    stopReason?: string;
    inputTokens?: number;
    outputTokens?: number;
    cacheReadInputTokens?: number;
    cacheWriteInputTokens?: number;
  } = {}
): ConverseResponse {
  return {
    output: {
      message: {
        role: 'assistant',
        content,
      },
    },
    stopReason: options.stopReason ?? 'end_turn',
    usage: {
      inputTokens: options.inputTokens ?? 10,
      outputTokens: options.outputTokens ?? 5,
      totalTokens: (options.inputTokens ?? 10) + (options.outputTokens ?? 5),
      cacheReadInputTokens: options.cacheReadInputTokens,
      cacheWriteInputTokens: options.cacheWriteInputTokens,
    },
    metrics: { latencyMs: 100 },
    $metadata: {},
  } as unknown as ConverseResponse;
}

describe('bedrockStreamMapper', () => {
  describe('createMapperState', () => {
    it('creates initial state with correct defaults', () => {
      const state = createMapperState();
      expect(state.pendingToolUse).toBeNull();
      expect(state.inputTokens).toBe(0);
      expect(state.outputTokens).toBe(0);
      expect(state.cacheReadTokens).toBe(0);
      expect(state.cacheCreationTokens).toBe(0);
    });
  });

  describe('mapBedrockStreamEvent', () => {
    describe('text content handling', () => {
      it('emits content.start on first text delta', () => {
        const state = createMapperState();
        const event: ConverseStreamOutput = {
          contentBlockDelta: {
            contentBlockIndex: 0,
            delta: { text: 'Hello' },
          },
        };

        const result = mapBedrockStreamEvent(event, state);
        expect(result.chunks).toContainEqual({ type: 'content.start' });
        expect(result.chunks).toContainEqual({ type: 'content', content: 'Hello' });
        expect(result.newState.currentBlockType).toBe('text');
      });

      it('emits content on text delta without re-emitting content.start', () => {
        const state: BedrockMapperState = {
          ...createMapperState(),
          currentBlockType: 'text',
        };
        const event: ConverseStreamOutput = {
          contentBlockDelta: {
            contentBlockIndex: 0,
            delta: { text: 'Hello world' },
          },
        };

        const result = mapBedrockStreamEvent(event, state);
        expect(result.chunks).toEqual([{ type: 'content', content: 'Hello world' }]);
      });

      it('emits content.end on contentBlockStop when in text block', () => {
        const state: BedrockMapperState = {
          ...createMapperState(),
          currentBlockType: 'text',
        };
        const event: ConverseStreamOutput = {
          contentBlockStop: { contentBlockIndex: 0 },
        };

        const result = mapBedrockStreamEvent(event, state);
        expect(result.chunks).toContainEqual({ type: 'content.end' });
        expect(result.newState.currentBlockType).toBeNull();
      });
    });

    describe('reasoning content handling', () => {
      it('emits thinking.start on first reasoning delta', () => {
        const state = createMapperState();
        const event: ConverseStreamOutput = {
          contentBlockDelta: {
            contentBlockIndex: 0,
            delta: {
              reasoningContent: { text: 'Let me think...' },
            },
          },
        };

        const result = mapBedrockStreamEvent(event, state);
        expect(result.chunks).toContainEqual({ type: 'thinking.start' });
        expect(result.chunks).toContainEqual({ type: 'thinking', content: 'Let me think...' });
        expect(result.newState.currentBlockType).toBe('reasoning');
      });

      it('emits thinking on subsequent reasoning deltas without re-emitting thinking.start', () => {
        const state: BedrockMapperState = {
          ...createMapperState(),
          currentBlockType: 'reasoning',
        };
        const event: ConverseStreamOutput = {
          contentBlockDelta: {
            contentBlockIndex: 0,
            delta: {
              reasoningContent: { text: 'more thinking...' },
            },
          },
        };

        const result = mapBedrockStreamEvent(event, state);
        expect(result.chunks).toEqual([{ type: 'thinking', content: 'more thinking...' }]);
      });

      it('emits thinking.end on contentBlockStop when in reasoning block', () => {
        const state: BedrockMapperState = {
          ...createMapperState(),
          currentBlockType: 'reasoning',
        };
        const event: ConverseStreamOutput = {
          contentBlockStop: { contentBlockIndex: 0 },
        };

        const result = mapBedrockStreamEvent(event, state);
        expect(result.chunks).toContainEqual({ type: 'thinking.end' });
        expect(result.newState.currentBlockType).toBeNull();
      });
    });

    describe('tool use handling', () => {
      it('starts accumulating tool use on toolUse start', () => {
        const state = createMapperState();
        const event: ConverseStreamOutput = {
          contentBlockStart: {
            contentBlockIndex: 0,
            start: {
              toolUse: { toolUseId: 'tool_123', name: 'javascript' },
            },
          },
        };

        const result = mapBedrockStreamEvent(event, state);
        expect(result.newState.pendingToolUse).toEqual({
          id: 'tool_123',
          name: 'javascript',
          input: '',
        });
      });

      it('accumulates tool use input JSON across deltas', () => {
        const state: BedrockMapperState = {
          ...createMapperState(),
          pendingToolUse: { id: 'tool_123', name: 'javascript', input: '{"co' },
        };

        const event: ConverseStreamOutput = {
          contentBlockDelta: {
            contentBlockIndex: 0,
            delta: { toolUse: { input: 'de":"1+1"}' } },
          },
        };

        const result = mapBedrockStreamEvent(event, state);
        expect(result.newState.pendingToolUse).toEqual({
          id: 'tool_123',
          name: 'javascript',
          input: '{"code":"1+1"}',
        });
      });

      it('emits tool_use on contentBlockStop with pending tool', () => {
        const state: BedrockMapperState = {
          ...createMapperState(),
          pendingToolUse: { id: 'tool_123', name: 'javascript', input: '{"code":"1+1"}' },
        };

        const event: ConverseStreamOutput = {
          contentBlockStop: { contentBlockIndex: 0 },
        };

        const result = mapBedrockStreamEvent(event, state);
        expect(result.chunks).toContainEqual({
          type: 'tool_use',
          id: 'tool_123',
          name: 'javascript',
          input: { code: '1+1' },
        });
        expect(result.newState.pendingToolUse).toBeNull();
      });

      it('emits tool_use with empty input on invalid JSON', () => {
        const state: BedrockMapperState = {
          ...createMapperState(),
          pendingToolUse: { id: 'tool_123', name: 'test', input: 'invalid json' },
        };

        const event: ConverseStreamOutput = {
          contentBlockStop: { contentBlockIndex: 0 },
        };

        const result = mapBedrockStreamEvent(event, state);
        expect(result.chunks).toContainEqual({
          type: 'tool_use',
          id: 'tool_123',
          name: 'test',
          input: {},
        });
      });
    });

    describe('message stop handling', () => {
      it('captures stop reason from messageStop event', () => {
        const state = createMapperState();
        const event: ConverseStreamOutput = {
          messageStop: { stopReason: 'end_turn' },
        };

        const result = mapBedrockStreamEvent(event, state);
        expect(result.stopReason).toBe('end_turn');
      });

      it('captures tool_use stop reason', () => {
        const state = createMapperState();
        const event: ConverseStreamOutput = {
          messageStop: { stopReason: 'tool_use' },
        };

        const result = mapBedrockStreamEvent(event, state);
        expect(result.stopReason).toBe('tool_use');
      });
    });

    describe('token usage handling', () => {
      it('emits token_usage from metadata event', () => {
        const state = createMapperState();
        const event = {
          metadata: {
            usage: {
              inputTokens: 100,
              outputTokens: 50,
              totalTokens: 150,
              cacheReadInputTokens: 20,
              cacheWriteInputTokens: 10,
            },
          },
        } as ConverseStreamOutput;

        const result = mapBedrockStreamEvent(event, state);
        expect(result.chunks).toContainEqual({
          type: 'token_usage',
          inputTokens: 100,
          outputTokens: 50,
          cacheReadTokens: 20,
          cacheCreationTokens: 10,
        });
        expect(result.newState.inputTokens).toBe(100);
        expect(result.newState.outputTokens).toBe(50);
        expect(result.newState.cacheReadTokens).toBe(20);
        expect(result.newState.cacheCreationTokens).toBe(10);
      });
    });
  });

  describe('convertConverseResponseToStreamChunks', () => {
    it('converts text content to stream chunks', () => {
      const response = createConverseResponse([{ text: 'Hello world' }]);

      const chunks = convertConverseResponseToStreamChunks(response);
      expect(chunks).toContainEqual({ type: 'content.start' });
      expect(chunks).toContainEqual({ type: 'content', content: 'Hello world' });
      expect(chunks).toContainEqual({ type: 'content.end' });
    });

    it('converts reasoning content to stream chunks', () => {
      const response = createConverseResponse([
        { reasoningContent: { reasoningText: { text: 'Let me analyze...' } } },
      ]);

      const chunks = convertConverseResponseToStreamChunks(response);
      expect(chunks).toContainEqual({ type: 'thinking.start' });
      expect(chunks).toContainEqual({ type: 'thinking', content: 'Let me analyze...' });
      expect(chunks).toContainEqual({ type: 'thinking.end' });
    });

    it('converts tool use to stream chunks', () => {
      const response = createConverseResponse(
        [
          {
            toolUse: {
              toolUseId: 'tool_123',
              name: 'javascript',
              input: { code: '1+1' },
            },
          },
        ],
        { stopReason: 'tool_use' }
      );

      const chunks = convertConverseResponseToStreamChunks(response);
      expect(chunks).toContainEqual({
        type: 'tool_use',
        id: 'tool_123',
        name: 'javascript',
        input: { code: '1+1' },
      });
    });

    it('includes token usage', () => {
      const response = createConverseResponse([{ text: 'test' }], {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadInputTokens: 25,
        cacheWriteInputTokens: 10,
      });

      const chunks = convertConverseResponseToStreamChunks(response);
      expect(chunks).toContainEqual({
        type: 'token_usage',
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 25,
        cacheCreationTokens: 10,
      });
    });
  });

  describe('extractContentFromResponse', () => {
    it('extracts text content', () => {
      const response = createConverseResponse([{ text: 'Hello ' }, { text: 'world' }]);

      const result = extractContentFromResponse(response);
      expect(result.textContent).toBe('Hello world');
      expect(result.thinkingContent).toBeUndefined();
    });

    it('extracts thinking content', () => {
      const response = createConverseResponse([
        { reasoningContent: { reasoningText: { text: 'Analyzing...' } } },
        { text: 'Here is my answer' },
      ]);

      const result = extractContentFromResponse(response);
      expect(result.textContent).toBe('Here is my answer');
      expect(result.thinkingContent).toBe('Analyzing...');
    });

    it('handles empty response', () => {
      const response = createConverseResponse([], { inputTokens: 0, outputTokens: 0 });

      const result = extractContentFromResponse(response);
      expect(result.textContent).toBe('');
      expect(result.thinkingContent).toBeUndefined();
    });
  });
});

describe('BedrockFullContentAccumulator', () => {
  describe('pushRawEvent - text content', () => {
    it('accumulates text content', () => {
      const accumulator = new BedrockFullContentAccumulator();

      accumulator.pushRawEvent({
        contentBlockStart: { contentBlockIndex: 0 },
      } as ConverseStreamOutput);
      accumulator.pushRawEvent({
        contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'Hello ' } },
      } as ConverseStreamOutput);
      accumulator.pushRawEvent({
        contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'world' } },
      } as ConverseStreamOutput);
      accumulator.pushRawEvent({
        contentBlockStop: { contentBlockIndex: 0 },
      } as ConverseStreamOutput);

      const result = accumulator.finalize();
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({ text: 'Hello world' });
    });

    it('handles implicit text block start (delta without start event)', () => {
      const accumulator = new BedrockFullContentAccumulator();

      accumulator.pushRawEvent({
        contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'Hello' } },
      } as ConverseStreamOutput);
      accumulator.pushRawEvent({
        contentBlockStop: { contentBlockIndex: 0 },
      } as ConverseStreamOutput);

      const result = accumulator.finalize();
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({ text: 'Hello' });
    });
  });

  describe('pushRawEvent - reasoning content', () => {
    it('accumulates reasoning content', () => {
      const accumulator = new BedrockFullContentAccumulator();

      accumulator.pushRawEvent({
        contentBlockDelta: {
          contentBlockIndex: 0,
          delta: { reasoningContent: { text: 'Analyzing ' } },
        },
      } as ConverseStreamOutput);
      accumulator.pushRawEvent({
        contentBlockDelta: {
          contentBlockIndex: 0,
          delta: { reasoningContent: { text: 'the problem' } },
        },
      } as ConverseStreamOutput);
      accumulator.pushRawEvent({
        contentBlockStop: { contentBlockIndex: 0 },
      } as ConverseStreamOutput);

      const result = accumulator.finalize();
      expect(result).toHaveLength(1);
      expect(result[0]).toHaveProperty('reasoningContent');
      const rc = result[0] as { reasoningContent: { reasoningText: { text: string } } };
      expect(rc.reasoningContent.reasoningText.text).toBe('Analyzing the problem');
    });
  });

  describe('pushRawEvent - tool use', () => {
    it('accumulates tool_use from raw events', () => {
      const accumulator = new BedrockFullContentAccumulator();

      accumulator.pushRawEvent({
        contentBlockStart: {
          contentBlockIndex: 0,
          start: { toolUse: { toolUseId: 'tool_123', name: 'javascript' } },
        },
      } as ConverseStreamOutput);
      accumulator.pushRawEvent({
        contentBlockDelta: {
          contentBlockIndex: 0,
          delta: { toolUse: { input: '{"code":"1+1"}' } },
        },
      } as ConverseStreamOutput);
      accumulator.pushRawEvent({
        contentBlockStop: { contentBlockIndex: 0 },
      } as ConverseStreamOutput);

      const result = accumulator.finalize();
      expect(result).toHaveLength(1);
      expect(result[0]).toHaveProperty('toolUse');
      const tu = result[0] as {
        toolUse: { toolUseId: string; name: string; input: { code: string } };
      };
      expect(tu.toolUse.toolUseId).toBe('tool_123');
      expect(tu.toolUse.name).toBe('javascript');
      expect(tu.toolUse.input).toEqual({ code: '1+1' });
    });

    it('accumulates tool use from raw events', () => {
      const accumulator = new BedrockFullContentAccumulator();

      accumulator.pushRawEvent({
        contentBlockStart: {
          contentBlockIndex: 0,
          start: { toolUse: { toolUseId: 'tool_456', name: 'memory' } },
        },
      } as ConverseStreamOutput);
      accumulator.pushRawEvent({
        contentBlockDelta: {
          contentBlockIndex: 0,
          delta: { toolUse: { input: '{"command":"view"' } },
        },
      } as ConverseStreamOutput);
      accumulator.pushRawEvent({
        contentBlockDelta: {
          contentBlockIndex: 0,
          delta: { toolUse: { input: ',"path":"/"}' } },
        },
      } as ConverseStreamOutput);
      accumulator.pushRawEvent({
        contentBlockStop: { contentBlockIndex: 0 },
      } as ConverseStreamOutput);

      const result = accumulator.finalize();
      expect(result).toHaveLength(1);
      expect(result[0]).toHaveProperty('toolUse');
      const tu = result[0] as {
        toolUse: { toolUseId: string; name: string; input: { command: string; path: string } };
      };
      expect(tu.toolUse.toolUseId).toBe('tool_456');
      expect(tu.toolUse.name).toBe('memory');
      expect(tu.toolUse.input).toEqual({ command: 'view', path: '/' });
    });

    it('accumulates text from raw events', () => {
      const accumulator = new BedrockFullContentAccumulator();

      accumulator.pushRawEvent({
        contentBlockStart: { contentBlockIndex: 0 },
      } as ConverseStreamOutput);
      accumulator.pushRawEvent({
        contentBlockDelta: {
          contentBlockIndex: 0,
          delta: { text: 'Hello ' },
        },
      } as ConverseStreamOutput);
      accumulator.pushRawEvent({
        contentBlockDelta: {
          contentBlockIndex: 0,
          delta: { text: 'world' },
        },
      } as ConverseStreamOutput);
      accumulator.pushRawEvent({
        contentBlockStop: { contentBlockIndex: 0 },
      } as ConverseStreamOutput);

      const result = accumulator.finalize();
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({ text: 'Hello world' });
    });

    it('accumulates reasoning from raw events', () => {
      const accumulator = new BedrockFullContentAccumulator();

      accumulator.pushRawEvent({
        contentBlockDelta: {
          contentBlockIndex: 0,
          delta: { reasoningContent: { text: 'Let me ' } },
        },
      } as ConverseStreamOutput);
      accumulator.pushRawEvent({
        contentBlockDelta: {
          contentBlockIndex: 0,
          delta: { reasoningContent: { text: 'think' } },
        },
      } as ConverseStreamOutput);
      accumulator.pushRawEvent({
        contentBlockStop: { contentBlockIndex: 0 },
      } as ConverseStreamOutput);

      const result = accumulator.finalize();
      expect(result).toHaveLength(1);
      expect(result[0]).toHaveProperty('reasoningContent');
    });

    it('handles tool result from raw events', () => {
      const accumulator = new BedrockFullContentAccumulator();

      accumulator.pushRawEvent({
        contentBlockStart: {
          contentBlockIndex: 0,
          start: { toolResult: { toolUseId: 'tool_789', status: 'success' } },
        },
      } as ConverseStreamOutput);
      accumulator.pushRawEvent({
        contentBlockDelta: {
          contentBlockIndex: 0,
          delta: { toolResult: [{ text: 'Result: 2' }] },
        },
      } as ConverseStreamOutput);
      accumulator.pushRawEvent({
        contentBlockStop: { contentBlockIndex: 0 },
      } as ConverseStreamOutput);

      const result = accumulator.finalize();
      expect(result).toHaveLength(1);
      expect(result[0]).toHaveProperty('toolResult');
      const tr = result[0] as {
        toolResult: { toolUseId: string; status: string; content: Array<{ text: string }> };
      };
      expect(tr.toolResult.toolUseId).toBe('tool_789');
      expect(tr.toolResult.status).toBe('success');
      expect(tr.toolResult.content).toEqual([{ text: 'Result: 2' }]);
    });
  });

  describe('getTextContent', () => {
    it('returns accumulated text', () => {
      const accumulator = new BedrockFullContentAccumulator();

      accumulator.pushRawEvent({
        contentBlockStart: { contentBlockIndex: 0 },
      } as ConverseStreamOutput);
      accumulator.pushRawEvent({
        contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'Hello' } },
      } as ConverseStreamOutput);
      accumulator.pushRawEvent({
        contentBlockStop: { contentBlockIndex: 0 },
      } as ConverseStreamOutput);

      expect(accumulator.getTextContent()).toBe('Hello');
    });

    it('returns empty string when no text', () => {
      const accumulator = new BedrockFullContentAccumulator();
      expect(accumulator.getTextContent()).toBe('');
    });

    it('includes pending text block', () => {
      const accumulator = new BedrockFullContentAccumulator();

      accumulator.pushRawEvent({
        contentBlockStart: { contentBlockIndex: 0 },
      } as ConverseStreamOutput);
      accumulator.pushRawEvent({
        contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'Partial' } },
      } as ConverseStreamOutput);
      // No contentBlockStop yet

      expect(accumulator.getTextContent()).toBe('Partial');
    });
  });

  describe('getThinkingContent', () => {
    it('returns accumulated thinking', () => {
      const accumulator = new BedrockFullContentAccumulator();

      accumulator.pushRawEvent({
        contentBlockDelta: {
          contentBlockIndex: 0,
          delta: { reasoningContent: { text: 'Analyzing' } },
        },
      } as ConverseStreamOutput);
      accumulator.pushRawEvent({
        contentBlockStop: { contentBlockIndex: 0 },
      } as ConverseStreamOutput);

      expect(accumulator.getThinkingContent()).toBe('Analyzing');
    });

    it('returns undefined when no thinking', () => {
      const accumulator = new BedrockFullContentAccumulator();
      expect(accumulator.getThinkingContent()).toBeUndefined();
    });
  });

  describe('full pipeline: streaming events → fullContent', () => {
    it('handles mixed content types', () => {
      const accumulator = new BedrockFullContentAccumulator();

      // Simulate a stream with reasoning + text + tool_use
      accumulator.pushRawEvent({
        contentBlockDelta: {
          contentBlockIndex: 0,
          delta: { reasoningContent: { text: 'I need to calculate' } },
        },
      } as ConverseStreamOutput);
      accumulator.pushRawEvent({
        contentBlockStop: { contentBlockIndex: 0 },
      } as ConverseStreamOutput);

      accumulator.pushRawEvent({
        contentBlockStart: { contentBlockIndex: 1 },
      } as ConverseStreamOutput);
      accumulator.pushRawEvent({
        contentBlockDelta: {
          contentBlockIndex: 1,
          delta: { text: 'I will calculate for you.' },
        },
      } as ConverseStreamOutput);
      accumulator.pushRawEvent({
        contentBlockStop: { contentBlockIndex: 1 },
      } as ConverseStreamOutput);

      accumulator.pushRawEvent({
        contentBlockStart: {
          contentBlockIndex: 2,
          start: { toolUse: { toolUseId: 'call_1', name: 'javascript' } },
        },
      } as ConverseStreamOutput);
      accumulator.pushRawEvent({
        contentBlockDelta: {
          contentBlockIndex: 2,
          delta: { toolUse: { input: '{"code":"1+1"}' } },
        },
      } as ConverseStreamOutput);
      accumulator.pushRawEvent({
        contentBlockStop: { contentBlockIndex: 2 },
      } as ConverseStreamOutput);

      const result = accumulator.finalize();
      expect(result).toHaveLength(3);

      // First block is reasoning
      expect(result[0]).toHaveProperty('reasoningContent');

      // Second block is text
      expect(result[1]).toEqual({ text: 'I will calculate for you.' });

      // Third block is tool_use
      expect(result[2]).toHaveProperty('toolUse');
      const tu = result[2] as { toolUse: { name: string } };
      expect(tu.toolUse.name).toBe('javascript');
    });

    it('preserves block ordering', () => {
      const accumulator = new BedrockFullContentAccumulator();

      // Text first
      accumulator.pushRawEvent({
        contentBlockStart: { contentBlockIndex: 0 },
      } as ConverseStreamOutput);
      accumulator.pushRawEvent({
        contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'First' } },
      } as ConverseStreamOutput);
      accumulator.pushRawEvent({
        contentBlockStop: { contentBlockIndex: 0 },
      } as ConverseStreamOutput);

      // Tool use second
      accumulator.pushRawEvent({
        contentBlockStart: {
          contentBlockIndex: 1,
          start: { toolUse: { toolUseId: 'tool_1', name: 'test' } },
        },
      } as ConverseStreamOutput);
      accumulator.pushRawEvent({
        contentBlockDelta: { contentBlockIndex: 1, delta: { toolUse: { input: '{}' } } },
      } as ConverseStreamOutput);
      accumulator.pushRawEvent({
        contentBlockStop: { contentBlockIndex: 1 },
      } as ConverseStreamOutput);

      // Text third
      accumulator.pushRawEvent({
        contentBlockStart: { contentBlockIndex: 2 },
      } as ConverseStreamOutput);
      accumulator.pushRawEvent({
        contentBlockDelta: { contentBlockIndex: 2, delta: { text: 'Third' } },
      } as ConverseStreamOutput);
      accumulator.pushRawEvent({
        contentBlockStop: { contentBlockIndex: 2 },
      } as ConverseStreamOutput);

      const result = accumulator.finalize();
      expect(result).toHaveLength(3);
      expect(result[0]).toEqual({ text: 'First' });
      expect(result[1]).toHaveProperty('toolUse');
      expect(result[2]).toEqual({ text: 'Third' });
    });
  });
});
