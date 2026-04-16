import { describe, it, expect, vi } from 'vitest';
import { LoopRegistry } from '../LoopRegistry';
import type { ActiveLoop, LoopEvent } from '../../protocol/protocol';
import type { Message, ToolResultBlock } from '../../protocol/types';

const mkLoop = (overrides: Partial<ActiveLoop> = {}): ActiveLoop => ({
  loopId: `loop_${Math.random().toString(36).slice(2, 8)}`,
  chatId: 'chat_1',
  startedAt: Date.now(),
  status: 'running',
  apiDefinitionId: 'api_1',
  modelId: 'model_1',
  ...overrides,
});

describe('LoopRegistry', () => {
  describe('register / list / get', () => {
    it('returns an empty list when no loops are registered', () => {
      const reg = new LoopRegistry();
      expect(reg.list()).toEqual([]);
    });

    it('lists registered loops and looks them up by id', () => {
      const reg = new LoopRegistry();
      const loop = mkLoop({ loopId: 'loop_a' });
      reg.register(loop, new AbortController());
      expect(reg.list()).toHaveLength(1);
      expect(reg.get('loop_a')?.loopId).toBe('loop_a');
    });

    it('throws on duplicate loopId', () => {
      const reg = new LoopRegistry();
      const loop = mkLoop({ loopId: 'loop_dup' });
      reg.register(loop, new AbortController());
      expect(() => reg.register(loop, new AbortController())).toThrow(/duplicate loopId/);
    });
  });

  describe('hasRunningLoopForChat', () => {
    it('reports per-chat running state', () => {
      const reg = new LoopRegistry();
      reg.register(mkLoop({ loopId: 'l1', chatId: 'chat_1' }), new AbortController());
      reg.register(mkLoop({ loopId: 'l2', chatId: 'chat_2' }), new AbortController());
      expect(reg.hasRunningLoopForChat('chat_1')).toBe(true);
      expect(reg.hasRunningLoopForChat('chat_3')).toBe(false);
    });
  });

  describe('abort', () => {
    it('fires the AbortController and flips status to aborting', () => {
      const reg = new LoopRegistry();
      const ctrl = new AbortController();
      reg.register(mkLoop({ loopId: 'loop_x' }), ctrl);

      const ok = reg.abort('loop_x');
      expect(ok).toBe(true);
      expect(ctrl.signal.aborted).toBe(true);
      expect(reg.get('loop_x')?.status).toBe('aborting');
    });

    it('returns false for unknown loopId', () => {
      const reg = new LoopRegistry();
      expect(reg.abort('nope')).toBe(false);
    });

    it('is idempotent — second abort is a no-op', () => {
      const reg = new LoopRegistry();
      const ctrl = new AbortController();
      reg.register(mkLoop({ loopId: 'loop_y' }), ctrl);
      reg.abort('loop_y');
      reg.abort('loop_y');
      expect(ctrl.signal.aborted).toBe(true);
    });
  });

  describe('end', () => {
    it('removes the entry and broadcasts an ended change', () => {
      const reg = new LoopRegistry();
      const sub = vi.fn();
      reg.subscribe(sub); // initial snapshot

      reg.register(mkLoop({ loopId: 'loop_z' }), new AbortController());
      reg.end('loop_z', 'complete');

      expect(reg.get('loop_z')).toBeUndefined();
      expect(reg.list()).toEqual([]);
      // snapshot, started, ended
      expect(sub).toHaveBeenCalledTimes(3);
      expect(sub.mock.calls[2][0]).toEqual({
        type: 'ended',
        loopId: 'loop_z',
        status: 'complete',
      });
    });

    it('is a no-op for unknown loopId', () => {
      const reg = new LoopRegistry();
      const sub = vi.fn();
      reg.subscribe(sub);
      reg.end('nope', 'complete');
      // Only the initial snapshot
      expect(sub).toHaveBeenCalledTimes(1);
    });
  });

  describe('subscribe', () => {
    it('emits an initial snapshot synchronously on subscribe', () => {
      const reg = new LoopRegistry();
      reg.register(mkLoop({ loopId: 'loop_init' }), new AbortController());

      const sub = vi.fn();
      reg.subscribe(sub);
      expect(sub).toHaveBeenCalledTimes(1);
      expect(sub.mock.calls[0][0]).toMatchObject({
        type: 'snapshot',
        loops: expect.arrayContaining([expect.objectContaining({ loopId: 'loop_init' })]),
      });
    });

    it('broadcasts started / updated / ended deltas to subscribers', () => {
      const reg = new LoopRegistry();
      const sub = vi.fn();
      reg.subscribe(sub);

      reg.register(mkLoop({ loopId: 'loop_a' }), new AbortController());
      reg.updateStatus('loop_a', 'aborting');
      reg.end('loop_a', 'aborted');

      // snapshot, started, updated, ended
      expect(sub).toHaveBeenCalledTimes(4);
      expect(sub.mock.calls[1][0].type).toBe('started');
      expect(sub.mock.calls[2][0]).toMatchObject({
        type: 'updated',
        loopId: 'loop_a',
        status: 'aborting',
      });
      expect(sub.mock.calls[3][0]).toMatchObject({
        type: 'ended',
        loopId: 'loop_a',
        status: 'aborted',
      });
    });

    it('does not broadcast updateStatus when status is unchanged', () => {
      const reg = new LoopRegistry();
      reg.register(mkLoop({ loopId: 'loop_n' }), new AbortController());
      const sub = vi.fn();
      reg.subscribe(sub); // snapshot
      reg.updateStatus('loop_n', 'running');
      expect(sub).toHaveBeenCalledTimes(1);
    });

    it('unsubscribe stops further broadcasts', () => {
      const reg = new LoopRegistry();
      const sub = vi.fn();
      const off = reg.subscribe(sub);
      off();
      reg.register(mkLoop({ loopId: 'loop_off' }), new AbortController());
      // Only the initial snapshot before unsubscribe
      expect(sub).toHaveBeenCalledTimes(1);
    });

    it('isolates subscriber errors so other subscribers still receive events', () => {
      const reg = new LoopRegistry();
      const errSub = vi.fn(() => {
        throw new Error('boom');
      });
      const okSub = vi.fn();
      reg.subscribe(errSub);
      reg.subscribe(okSub);

      // Suppress the expected console.error from the broken subscriber.
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      reg.register(mkLoop({ loopId: 'loop_iso' }), new AbortController());
      errorSpy.mockRestore();

      // okSub: snapshot + started
      expect(okSub).toHaveBeenCalledTimes(2);
    });
  });

  // ============================================================================
  // Pending tool result cache — feeds attachChat snapshot replay so a user
  // navigating away from a chat mid-tool-stream can come back and immediately
  // see the placeholder tool_result message + its accumulated streaming
  // groups instead of an empty backstage.
  // ============================================================================
  describe('pending tool result cache', () => {
    const mkPendingMessage = (msgId: string, toolUseIds: string[]): Message<unknown> =>
      ({
        id: msgId,
        role: 'user',
        timestamp: new Date(),
        content: {
          type: 'text',
          content: '',
          modelFamily: 'anthropic',
          toolResults: toolUseIds.map(id => ({
            type: 'tool_result' as const,
            tool_use_id: id,
            name: 'minion',
            content: '',
          })),
        },
      }) as unknown as Message<unknown>;

    const broadcast = (reg: LoopRegistry, chatId: string, event: LoopEvent) => {
      reg.broadcastChatEvent(chatId, event);
    };

    it('records a pending_tool_result with one entry per toolUseId', () => {
      const reg = new LoopRegistry();
      const msg = mkPendingMessage('msg_1', ['tu_a', 'tu_b']);
      broadcast(reg, 'chat_1', { type: 'pending_tool_result', message: msg });

      const snapshot = reg.getPendingToolResults('chat_1');
      expect(snapshot).toHaveLength(2);
      expect(snapshot.map(e => e.toolUseId).sort()).toEqual(['tu_a', 'tu_b']);
      // The message reference is shared across entries for one placeholder.
      expect(snapshot[0].message.id).toBe('msg_1');
      expect(snapshot[1].message.id).toBe('msg_1');
      expect(snapshot[0].mergedBlock).toEqual({});
    });

    it('merges tool_block_update events into the matching entry', () => {
      const reg = new LoopRegistry();
      const msg = mkPendingMessage('msg_2', ['tu_x']);
      broadcast(reg, 'chat_1', { type: 'pending_tool_result', message: msg });

      broadcast(reg, 'chat_1', {
        type: 'tool_block_update',
        toolUseId: 'tu_x',
        block: { status: 'running' },
      });
      broadcast(reg, 'chat_1', {
        type: 'tool_block_update',
        toolUseId: 'tu_x',
        block: { renderingGroups: [{ category: 'text', blocks: [{ type: 'text', text: 'hi' }] }] },
      });

      const snapshot = reg.getPendingToolResults('chat_1');
      expect(snapshot).toHaveLength(1);
      expect(snapshot[0].mergedBlock.status).toBe('running');
      expect(snapshot[0].mergedBlock.renderingGroups).toEqual([
        { category: 'text', blocks: [{ type: 'text', text: 'hi' }] },
      ]);
    });

    it('drops tool_block_update for a toolUseId without a placeholder', () => {
      const reg = new LoopRegistry();
      // Out-of-order: update arrives before placeholder. Defensive — should
      // not crash, should not insert a placeholder-less entry.
      broadcast(reg, 'chat_1', {
        type: 'tool_block_update',
        toolUseId: 'tu_orphan',
        block: { status: 'running' },
      });
      expect(reg.getPendingToolResults('chat_1')).toEqual([]);
    });

    it('clears matching toolUseIds when a tool_result message_created arrives', () => {
      const reg = new LoopRegistry();
      const placeholder = mkPendingMessage('msg_3', ['tu_p', 'tu_q']);
      broadcast(reg, 'chat_1', { type: 'pending_tool_result', message: placeholder });

      // Final message_created carries both tool_use_ids — clears them both.
      const finalMsg = mkPendingMessage('msg_3', ['tu_p', 'tu_q']);
      broadcast(reg, 'chat_1', { type: 'message_created', message: finalMsg });

      expect(reg.getPendingToolResults('chat_1')).toEqual([]);
    });

    it('partial message_created clears only the matching ids', () => {
      const reg = new LoopRegistry();
      const placeholder = mkPendingMessage('msg_4', ['tu_one', 'tu_two']);
      broadcast(reg, 'chat_1', { type: 'pending_tool_result', message: placeholder });

      const partialFinal = mkPendingMessage('msg_4', ['tu_one']);
      broadcast(reg, 'chat_1', { type: 'message_created', message: partialFinal });

      const snapshot = reg.getPendingToolResults('chat_1');
      expect(snapshot.map(e => e.toolUseId)).toEqual(['tu_two']);
    });

    it('loop_ended clears every entry for the chat (cleanup safety net)', () => {
      const reg = new LoopRegistry();
      broadcast(reg, 'chat_1', {
        type: 'pending_tool_result',
        message: mkPendingMessage('msg_5', ['tu_1', 'tu_2']),
      });
      broadcast(reg, 'chat_1', {
        type: 'loop_ended',
        loopId: 'loop_1',
        status: 'aborted',
      });
      expect(reg.getPendingToolResults('chat_1')).toEqual([]);
    });

    it('cache is per-chat — events on chat_1 do not affect chat_2', () => {
      const reg = new LoopRegistry();
      broadcast(reg, 'chat_1', {
        type: 'pending_tool_result',
        message: mkPendingMessage('msg_a', ['tu_a']),
      });
      broadcast(reg, 'chat_2', {
        type: 'pending_tool_result',
        message: mkPendingMessage('msg_b', ['tu_b']),
      });
      broadcast(reg, 'chat_1', { type: 'loop_ended', loopId: 'loop_1', status: 'complete' });

      expect(reg.getPendingToolResults('chat_1')).toEqual([]);
      expect(reg.getPendingToolResults('chat_2')).toHaveLength(1);
    });

    it('non-tool-result message_created (e.g. assistant) leaves the cache alone', () => {
      const reg = new LoopRegistry();
      const placeholder = mkPendingMessage('msg_p', ['tu_keep']);
      broadcast(reg, 'chat_1', { type: 'pending_tool_result', message: placeholder });

      const assistantMsg = {
        id: 'msg_assistant',
        role: 'assistant',
        timestamp: new Date(),
        content: { type: 'text', content: 'hello' },
      } as unknown as Message<unknown>;
      broadcast(reg, 'chat_1', { type: 'message_created', message: assistantMsg });

      expect(reg.getPendingToolResults('chat_1').map(e => e.toolUseId)).toEqual(['tu_keep']);
    });

    it('getPendingToolResults returns an empty array for an unknown chat', () => {
      const reg = new LoopRegistry();
      expect(reg.getPendingToolResults('chat_nope')).toEqual([]);
    });

    it('getPendingToolResults returns shallow copies of the merged block', () => {
      const reg = new LoopRegistry();
      broadcast(reg, 'chat_1', {
        type: 'pending_tool_result',
        message: mkPendingMessage('msg_x', ['tu_iso']),
      });
      broadcast(reg, 'chat_1', {
        type: 'tool_block_update',
        toolUseId: 'tu_iso',
        block: { status: 'running' },
      });

      const snapshot = reg.getPendingToolResults('chat_1');
      // Mutating the returned snapshot must not corrupt the live cache.
      snapshot[0].mergedBlock.status = 'error';

      const refetched = reg.getPendingToolResults('chat_1');
      expect(refetched[0].mergedBlock.status).toBe('running');
    });

    // Type-system spot check: the helper above produces a real
    // `Message<unknown>` whose `content.toolResults` field is the same shape
    // the broadcast intercept reads.
    it('placeholder helper produces well-formed tool_results blocks', () => {
      const msg = mkPendingMessage('msg_y', ['tu_x']);
      const trs = (msg.content as { toolResults?: ToolResultBlock[] }).toolResults;
      expect(trs).toHaveLength(1);
      expect(trs?.[0].tool_use_id).toBe('tu_x');
    });
  });
});
