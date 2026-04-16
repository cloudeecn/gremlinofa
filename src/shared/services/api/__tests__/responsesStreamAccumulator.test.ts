import { describe, it, expect } from 'vitest';
import {
  ResponsesStreamAccumulator,
  buildStreamResultFromAccumulator,
} from '../responsesStreamAccumulator';
import type { ResponsesSSEEvent } from '../responsesStreamMapper';

/**
 * Test helper: build a synthetic ResponsesSSEEvent from a type and payload.
 * `data.type` is set so the shape matches what `parseResponsesStreamEvent`
 * produces from real SDK events.
 */
function ev(type: string, data: Record<string, unknown>): ResponsesSSEEvent {
  return { type, data: { type, ...data } };
}

describe('ResponsesStreamAccumulator', () => {
  it('accumulates text from output_text deltas', () => {
    const acc = new ResponsesStreamAccumulator();

    acc.pushEvent(
      ev('response.output_item.added', {
        output_index: 0,
        item: { type: 'message', id: 'msg_1', role: 'assistant', content: [] },
      })
    );
    acc.pushEvent(
      ev('response.content_part.added', {
        output_index: 0,
        content_index: 0,
        part: { type: 'output_text', text: '' },
      })
    );
    acc.pushEvent(
      ev('response.output_text.delta', {
        output_index: 0,
        content_index: 0,
        delta: 'Hello',
      })
    );
    acc.pushEvent(
      ev('response.output_text.delta', {
        output_index: 0,
        content_index: 0,
        delta: ' world',
      })
    );
    acc.pushEvent(
      ev('response.output_item.done', {
        output_index: 0,
        item: {
          type: 'message',
          id: 'msg_1',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Hello world' }],
        },
      })
    );

    const state = acc.finalize();
    expect(state.textContent).toBe('Hello world');
    expect(state.fullContent).toHaveLength(1);
    expect(state.fullContent[0]).toMatchObject({ type: 'message' });
    expect(state.hasFunctionCall).toBe(false);
    expect(state.hasCoT).toBe(false);
  });

  it('captures function_call from output_item.done with complete arguments', () => {
    const acc = new ResponsesStreamAccumulator();

    acc.pushEvent(
      ev('response.output_item.added', {
        output_index: 0,
        item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'ping', arguments: '' },
      })
    );
    acc.pushEvent(
      ev('response.function_call_arguments.delta', {
        output_index: 0,
        delta: '{"host":"example.com"}',
      })
    );
    acc.pushEvent(
      ev('response.output_item.done', {
        output_index: 0,
        item: {
          type: 'function_call',
          id: 'fc_1',
          call_id: 'call_1',
          name: 'ping',
          arguments: '{"host":"example.com"}',
        },
      })
    );

    const state = acc.finalize();
    expect(state.hasFunctionCall).toBe(true);
    expect(state.fullContent).toHaveLength(1);
    expect(state.fullContent[0]).toMatchObject({
      type: 'function_call',
      call_id: 'call_1',
      name: 'ping',
      arguments: '{"host":"example.com"}',
    });
  });

  it('handles mixed text + function_call', () => {
    const acc = new ResponsesStreamAccumulator();

    // index 0: message
    acc.pushEvent(
      ev('response.output_item.added', {
        output_index: 0,
        item: { type: 'message', id: 'msg_1', role: 'assistant', content: [] },
      })
    );
    acc.pushEvent(
      ev('response.output_text.delta', {
        output_index: 0,
        content_index: 0,
        delta: 'Calling tool now',
      })
    );
    acc.pushEvent(
      ev('response.output_item.done', {
        output_index: 0,
        item: {
          type: 'message',
          id: 'msg_1',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Calling tool now' }],
        },
      })
    );

    // index 1: function_call
    acc.pushEvent(
      ev('response.output_item.added', {
        output_index: 1,
        item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'ping', arguments: '' },
      })
    );
    acc.pushEvent(
      ev('response.output_item.done', {
        output_index: 1,
        item: {
          type: 'function_call',
          id: 'fc_1',
          call_id: 'call_1',
          name: 'ping',
          arguments: '{}',
        },
      })
    );

    const state = acc.finalize();
    expect(state.textContent).toBe('Calling tool now');
    expect(state.fullContent).toHaveLength(2);
    expect(state.fullContent[0]).toMatchObject({ type: 'message' });
    expect(state.fullContent[1]).toMatchObject({ type: 'function_call', call_id: 'call_1' });
    expect(state.hasFunctionCall).toBe(true);
  });

  it('handles reasoning + message + function_call sequence', () => {
    const acc = new ResponsesStreamAccumulator();

    // index 0: reasoning
    acc.pushEvent(
      ev('response.output_item.added', {
        output_index: 0,
        item: { type: 'reasoning', id: 'r_1', summary: [], content: [] },
      })
    );
    acc.pushEvent(
      ev('response.reasoning_text.delta', {
        output_index: 0,
        content_index: 0,
        delta: 'Thinking about it...',
      })
    );
    acc.pushEvent(
      ev('response.output_item.done', {
        output_index: 0,
        item: {
          type: 'reasoning',
          id: 'r_1',
          summary: [],
          content: [{ type: 'reasoning_text', text: 'Thinking about it...' }],
        },
      })
    );

    // index 1: message
    acc.pushEvent(
      ev('response.output_item.added', {
        output_index: 1,
        item: { type: 'message', id: 'm_1', role: 'assistant', content: [] },
      })
    );
    acc.pushEvent(
      ev('response.output_text.delta', {
        output_index: 1,
        content_index: 0,
        delta: 'Result:',
      })
    );
    acc.pushEvent(
      ev('response.output_item.done', {
        output_index: 1,
        item: {
          type: 'message',
          id: 'm_1',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Result:' }],
        },
      })
    );

    // index 2: function_call
    acc.pushEvent(
      ev('response.output_item.added', {
        output_index: 2,
        item: { type: 'function_call', id: 'fc_1', call_id: 'call_2', name: 'tool', arguments: '' },
      })
    );
    acc.pushEvent(
      ev('response.output_item.done', {
        output_index: 2,
        item: {
          type: 'function_call',
          id: 'fc_1',
          call_id: 'call_2',
          name: 'tool',
          arguments: '{"x":1}',
        },
      })
    );

    const state = acc.finalize();
    expect(state.fullContent).toHaveLength(3);
    expect(state.fullContent[0]).toMatchObject({ type: 'reasoning' });
    expect(state.fullContent[1]).toMatchObject({ type: 'message' });
    expect(state.fullContent[2]).toMatchObject({ type: 'function_call' });
    expect(state.hasCoT).toBe(true);
    expect(state.hasFunctionCall).toBe(true);
    expect(state.thinkingContent).toBe('Thinking about it...');
    expect(state.textContent).toBe('Result:');
  });

  it('silently drops deltas referencing unknown output_index', () => {
    const acc = new ResponsesStreamAccumulator();

    // No output_item.added — delta arrives for an index we have nothing at
    expect(() =>
      acc.pushEvent(
        ev('response.output_text.delta', {
          output_index: 5,
          content_index: 0,
          delta: 'orphan',
        })
      )
    ).not.toThrow();
    expect(() =>
      acc.pushEvent(
        ev('response.function_call_arguments.delta', {
          output_index: 7,
          delta: '{}',
        })
      )
    ).not.toThrow();

    const state = acc.finalize();
    // Text accumulator still picks up the delta (it's pushed unconditionally),
    // but the items map stays empty.
    expect(state.fullContent).toHaveLength(0);
    expect(state.textContent).toBe('orphan');
  });

  it('seeds output array from response.created pre-populated output', () => {
    const acc = new ResponsesStreamAccumulator();

    acc.pushEvent(
      ev('response.created', {
        response: {
          output: [
            {
              type: 'message',
              id: 'msg_1',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'preseeded' }],
            },
          ],
        },
      })
    );

    const state = acc.finalize();
    expect(state.fullContent).toHaveLength(1);
    expect(state.fullContent[0]).toMatchObject({ type: 'message' });
  });

  it('extracts token usage from response.completed', () => {
    const acc = new ResponsesStreamAccumulator();

    acc.pushEvent(
      ev('response.completed', {
        response: {
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            input_tokens_details: { cached_tokens: 30 },
            output_tokens_details: { reasoning_tokens: 10 },
          },
        },
      })
    );

    const state = acc.finalize();
    expect(state.tokens).toEqual({
      input: 100,
      output: 50,
      cachedInput: 30,
      reasoning: 10,
    });
  });
});

describe('buildStreamResultFromAccumulator', () => {
  it('builds StreamResult with subtracted cached/reasoning tokens', () => {
    const acc = new ResponsesStreamAccumulator();

    acc.pushEvent(
      ev('response.output_item.added', {
        output_index: 0,
        item: { type: 'function_call', id: 'fc_1', call_id: 'c_1', name: 'tool', arguments: '' },
      })
    );
    acc.pushEvent(
      ev('response.output_item.done', {
        output_index: 0,
        item: {
          type: 'function_call',
          id: 'fc_1',
          call_id: 'c_1',
          name: 'tool',
          arguments: '{}',
        },
      })
    );
    acc.pushEvent(
      ev('response.completed', {
        response: {
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            input_tokens_details: { cached_tokens: 30 },
            output_tokens_details: { reasoning_tokens: 10 },
          },
        },
      })
    );

    const result = buildStreamResultFromAccumulator(acc);
    expect(result.inputTokens).toBe(70); // 100 - 30
    expect(result.outputTokens).toBe(40); // 50 - 10
    expect(result.cacheReadTokens).toBe(30);
    expect(result.reasoningTokens).toBe(10);
    expect(result.stopReason).toBe('tool_use');
    expect(result.fullContent).toHaveLength(1);
  });

  it('omits stopReason when no function_call present', () => {
    const acc = new ResponsesStreamAccumulator();

    acc.pushEvent(
      ev('response.output_item.added', {
        output_index: 0,
        item: { type: 'message', id: 'm_1', role: 'assistant', content: [] },
      })
    );
    acc.pushEvent(
      ev('response.output_text.delta', {
        output_index: 0,
        content_index: 0,
        delta: 'hi',
      })
    );

    const result = buildStreamResultFromAccumulator(acc);
    expect(result.stopReason).toBeUndefined();
    expect(result.textContent).toBe('hi');
  });
});
