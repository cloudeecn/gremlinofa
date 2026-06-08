import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ActiveLoopsStore } from '../ActiveLoopsStore';
import type { GremlinClient } from '../GremlinClient';
import type {
  ActiveLoopsChange,
  StreamEndEnvelope,
  StreamEventEnvelope,
} from '../../../shared/protocol/protocol';

/**
 * Drive the store from a controllable async iterable so we can fire deltas
 * synchronously and inspect the resulting snapshots.
 */
function makeControllableStream() {
  const queue: Array<ActiveLoopsChange | 'disconnect'> = [];
  let resolveNext: (() => void) | null = null;
  let closed = false;

  const push = (change: ActiveLoopsChange) => {
    queue.push(change);
    if (resolveNext) {
      const r = resolveNext;
      resolveNext = null;
      r();
    }
  };

  /** Simulate a transport disconnect — yields a stream_end with error. */
  const disconnect = () => {
    queue.push('disconnect');
    if (resolveNext) {
      const r = resolveNext;
      resolveNext = null;
      r();
    }
  };

  const close = () => {
    closed = true;
    if (resolveNext) {
      const r = resolveNext;
      resolveNext = null;
      r();
    }
  };

  const stream = vi.fn(() => {
    async function* gen(): AsyncGenerator<StreamEventEnvelope | StreamEndEnvelope, void, void> {
      let seq = 0;
      while (!closed) {
        if (queue.length === 0) {
          await new Promise<void>(resolve => {
            resolveNext = resolve;
          });
          continue;
        }
        const item = queue.shift()!;
        if (item === 'disconnect') {
          yield {
            kind: 'stream_end' as const,
            requestId: 'req_1',
            status: 'error' as const,
            detail: 'transport disconnected',
          };
          return;
        }
        yield {
          kind: 'stream_event' as const,
          requestId: 'req_1',
          seq: seq++,
          event: item,
        };
      }
    }
    return gen();
  });

  return { stream, push, disconnect, close };
}

/** Create a stream factory that returns a fresh controllable stream each call. */
function makeStreamFactory() {
  const streams: ReturnType<typeof makeControllableStream>[] = [];
  let callIndex = 0;

  const addStream = () => {
    const s = makeControllableStream();
    streams.push(s);
    return s;
  };

  const factory = vi.fn(() => {
    if (callIndex >= streams.length) {
      addStream();
    }
    return streams[callIndex++].stream();
  });

  return { factory, streams, addStream };
}

describe('ActiveLoopsStore', () => {
  let push: (change: ActiveLoopsChange) => void;
  let close: () => void;
  let store: ActiveLoopsStore;

  beforeEach(() => {
    const ctrl = makeControllableStream();
    push = ctrl.push;
    close = ctrl.close;
    const client = {
      stream: ctrl.stream,
      abortLoop: vi.fn(async () => {}),
      onReconnect: vi.fn(() => () => {}),
    } as unknown as GremlinClient;
    store = new ActiveLoopsStore(client);
  });

  it('starts empty before any subscribers', () => {
    expect(store.getSnapshot()).toEqual([]);
  });

  it('lazy-opens the stream on first subscribe and applies snapshots', async () => {
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    push({
      type: 'snapshot',
      loops: [
        {
          loopId: 'loop_1',
          chatId: 'c1',
          startedAt: 1000,
          status: 'running',
          apiDefinitionId: 'api_1',
          modelId: 'm1',
        },
      ],
    });
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(listener).toHaveBeenCalled();
    expect(store.getSnapshot()).toHaveLength(1);
    expect(store.getSnapshot()[0].loopId).toBe('loop_1');

    unsubscribe();
    close();
  });

  it('applies started/updated/ended deltas', async () => {
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    push({ type: 'snapshot', loops: [] });
    await new Promise(resolve => setTimeout(resolve, 0));

    push({
      type: 'started',
      loop: {
        loopId: 'loop_1',
        chatId: 'c1',
        startedAt: 1000,
        status: 'running',
        apiDefinitionId: 'api_1',
        modelId: 'm1',
      },
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(store.getSnapshot()).toHaveLength(1);
    expect(store.getSnapshot()[0].status).toBe('running');

    push({ type: 'updated', loopId: 'loop_1', status: 'aborting' });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(store.getSnapshot()[0].status).toBe('aborting');

    push({ type: 'ended', loopId: 'loop_1', status: 'aborted' });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(store.getSnapshot()).toHaveLength(0);

    unsubscribe();
    close();
  });

  it('forwards abort() to the client', async () => {
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    push({ type: 'snapshot', loops: [] });
    await new Promise(resolve => setTimeout(resolve, 0));

    const client = (store as unknown as { client: { abortLoop: ReturnType<typeof vi.fn> } }).client;
    await store.abort('loop_99');
    expect(client.abortLoop).toHaveBeenCalledWith('loop_99');

    unsubscribe();
    close();
  });

  describe('reconnect', () => {
    it('restarts the stream when listeners are active', async () => {
      const { factory, addStream } = makeStreamFactory();
      const stream1 = addStream();
      const stream2 = addStream();

      let reconnectCb: (() => void) | undefined;
      const client = {
        stream: factory,
        abortLoop: vi.fn(async () => {}),
        onReconnect: vi.fn((cb: () => void) => {
          reconnectCb = cb;
          return () => {
            reconnectCb = undefined;
          };
        }),
      } as unknown as GremlinClient;

      const reconnectStore = new ActiveLoopsStore(client);
      const listener = vi.fn();
      reconnectStore.subscribe(listener);

      // First stream delivers initial data
      stream1.push({
        type: 'snapshot',
        loops: [
          {
            loopId: 'loop_1',
            chatId: 'c1',
            startedAt: 1000,
            status: 'running',
            apiDefinitionId: 'api_1',
            modelId: 'm1',
          },
        ],
      });
      await new Promise(r => setTimeout(r, 0));
      expect(reconnectStore.getSnapshot()).toHaveLength(1);
      expect(reconnectStore.getSnapshot()[0].loopId).toBe('loop_1');

      // Simulate disconnect — stream_end with error
      stream1.disconnect();
      await new Promise(r => setTimeout(r, 0));
      expect(reconnectStore.getSnapshot()).toHaveLength(0);

      // Fire reconnect callback (simulates WebSocket reconnecting)
      reconnectCb!();
      expect(factory).toHaveBeenCalledTimes(2);

      // Second stream delivers fresh snapshot
      stream2.push({
        type: 'snapshot',
        loops: [
          {
            loopId: 'loop_2',
            chatId: 'c2',
            startedAt: 2000,
            status: 'running',
            apiDefinitionId: 'api_2',
            modelId: 'm2',
          },
        ],
      });
      await new Promise(r => setTimeout(r, 0));
      expect(reconnectStore.getSnapshot()).toHaveLength(1);
      expect(reconnectStore.getSnapshot()[0].loopId).toBe('loop_2');

      reconnectStore.dispose();
      stream2.close();
    });

    it('does not restart after dispose()', async () => {
      const { factory, addStream } = makeStreamFactory();
      const stream1 = addStream();

      let reconnectCb: (() => void) | undefined;
      const client = {
        stream: factory,
        abortLoop: vi.fn(async () => {}),
        onReconnect: vi.fn((cb: () => void) => {
          reconnectCb = cb;
          return () => {
            reconnectCb = undefined;
          };
        }),
      } as unknown as GremlinClient;

      const reconnectStore = new ActiveLoopsStore(client);
      reconnectStore.subscribe(vi.fn());

      stream1.push({ type: 'snapshot', loops: [] });
      await new Promise(r => setTimeout(r, 0));

      reconnectStore.dispose();

      // reconnectCb should have been deregistered by dispose
      expect(reconnectCb).toBeUndefined();
      // stream should only have been opened once
      expect(factory).toHaveBeenCalledTimes(1);
    });
  });
});
