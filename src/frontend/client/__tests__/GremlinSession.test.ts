import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GremlinSession } from '../GremlinSession';
import type { GremlinClient } from '../GremlinClient';
import type {
  LoopEvent,
  StreamEndEnvelope,
  StreamEventEnvelope,
} from '../../../shared/protocol/protocol';

/**
 * GremlinSession's new model: a long-lived `attachChat` subscription delivers
 * snapshot + live events; commands like `send`/`resend` fire `startLoop`
 * one-shot RPCs that are picked up via the same subscription. The mock
 * client below exposes a manual `attachController` so each test can drive
 * its own sequence of events through the attach stream.
 */
function makeAttachController() {
  const queue: (StreamEventEnvelope<'attachChat'> | StreamEndEnvelope)[] = [];
  let resolveNext: (() => void) | null = null;
  let cancelled = false;

  function push(env: StreamEventEnvelope<'attachChat'> | StreamEndEnvelope): void {
    queue.push(env);
    if (resolveNext) {
      const r = resolveNext;
      resolveNext = null;
      r();
    }
  }

  async function* gen(): AsyncGenerator<
    StreamEventEnvelope<'attachChat'> | StreamEndEnvelope,
    void,
    void
  > {
    try {
      while (!cancelled) {
        if (queue.length > 0) {
          yield queue.shift()!;
          continue;
        }
        await new Promise<void>(resolve => {
          resolveNext = resolve;
        });
      }
    } finally {
      cancelled = true;
    }
  }

  return {
    pushEvent(event: LoopEvent, seq = 0) {
      push({ kind: 'stream_event', requestId: 'attach_1', seq, event });
    },
    pushEnd(status: 'complete' | 'error' | 'aborted' = 'complete') {
      push({ kind: 'stream_end', requestId: 'attach_1', status });
    },
    cancel() {
      cancelled = true;
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r();
      }
    },
    iterable: { [Symbol.asyncIterator]: () => gen() },
  };
}

function makeMockClient(attach: ReturnType<typeof makeAttachController>) {
  return {
    stream: vi.fn((method: string) => {
      if (method !== 'attachChat') {
        throw new Error(`unexpected stream method in test: ${method}`);
      }
      return attach.iterable;
    }),
    startLoop: vi.fn(async () => ({ loopId: 'loop_test' })),
    abortLoop: vi.fn(async () => {}),
    softStopLoop: vi.fn(async () => {}),
  } as unknown as GremlinClient;
}

describe('GremlinSession', () => {
  let received: LoopEvent[];
  let endStatuses: { status: string; detail?: string }[];

  beforeEach(() => {
    received = [];
    endStatuses = [];
  });

  it('attach() pumps events from the attachChat stream into the handler', async () => {
    const attach = makeAttachController();
    const client = makeMockClient(attach);
    const session = new GremlinSession(client, 'chat_1');
    session.onEvent(ev => received.push(ev));
    session.onEnd((status, detail) => endStatuses.push({ status, detail }));
    void session.attach();

    // Drain the microtask queue so the first iterator.next() is in flight.
    await Promise.resolve();

    attach.pushEvent({ type: 'loop_started', loopId: 'loop_42' });
    attach.pushEvent({ type: 'streaming_chunk', groups: [] }, 1);
    attach.pushEvent({ type: 'loop_ended', loopId: 'loop_42', status: 'complete' }, 2);
    // Let the events drain into the handler.
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(received.map(e => e.type)).toEqual(['loop_started', 'streaming_chunk', 'loop_ended']);
    // The session forwards loop_ended to the endHandler so the chat-view
    // hook still sees its idle-transition signal.
    expect(endStatuses).toEqual([{ status: 'complete', detail: undefined }]);
    expect(session.loopId).toBeNull();

    session.dispose();
  });

  it('send() delegates to client.startLoop and records the loopId from loop_started', async () => {
    const attach = makeAttachController();
    const client = makeMockClient(attach);
    (client.startLoop as ReturnType<typeof vi.fn>).mockResolvedValue({ loopId: 'loop_send' });
    const session = new GremlinSession(client, 'chat_1');
    session.onEvent(ev => received.push(ev));
    void session.attach();
    await Promise.resolve();

    await session.send('hello there');

    expect(client.startLoop).toHaveBeenCalledWith({
      chatId: 'chat_1',
      mode: 'send',
      content: 'hello there',
      attachments: undefined,
    });
    expect(session.loopId).toBe('loop_send');

    // The loop_started event arriving via attachChat sets currentLoopId from
    // the broadcast. We synthesize it here to verify the path.
    attach.pushEvent({ type: 'loop_started', loopId: 'loop_send' });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(received.map(e => e.type)).toEqual(['loop_started']);

    session.dispose();
  });

  it('softStop and abort fire while a loop is in flight', async () => {
    const attach = makeAttachController();
    const client = makeMockClient(attach);
    (client.startLoop as ReturnType<typeof vi.fn>).mockResolvedValue({ loopId: 'loop_inflight' });
    const session = new GremlinSession(client, 'chat_1');
    session.onEvent(ev => received.push(ev));
    void session.attach();
    await Promise.resolve();

    void session.send('go');
    // Drain microtasks so startLoop's await resolves and currentLoopId is set.
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(session.loopId).toBe('loop_inflight');
    expect(session.isRunning).toBe(true);

    await session.softStop();
    expect(client.softStopLoop).toHaveBeenCalledWith('loop_inflight');

    await session.abort();
    expect(client.abortLoop).toHaveBeenCalledWith('loop_inflight');

    session.dispose();
  });

  it('startLoop errors are forwarded via onError + synthetic onEnd', async () => {
    const attach = makeAttachController();
    const client = makeMockClient(attach);
    (client.startLoop as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('chat is busy'));
    const session = new GremlinSession(client, 'chat_1');
    const errors: Error[] = [];
    session.onError(err => errors.push(err));
    session.onEnd((status, detail) => endStatuses.push({ status, detail }));
    void session.attach();
    await Promise.resolve();

    await expect(session.send('test')).rejects.toThrow('chat is busy');

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toBe('chat is busy');
    expect(endStatuses).toEqual([{ status: 'error', detail: 'chat is busy' }]);

    session.dispose();
  });

  it('dispose() drops handlers so post-unmount events do nothing', async () => {
    const attach = makeAttachController();
    const client = makeMockClient(attach);
    const session = new GremlinSession(client, 'chat_1');
    const calls: string[] = [];
    session.onEvent(ev => calls.push(ev.type));
    void session.attach();
    await Promise.resolve();
    session.dispose();
    // Pushing events after dispose should be a no-op since the iterator's
    // return() has been called.
    attach.pushEvent({ type: 'loop_started', loopId: 'loop_x' });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(calls).toHaveLength(0);
  });
});
