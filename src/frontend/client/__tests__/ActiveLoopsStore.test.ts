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
  const queue: ActiveLoopsChange[] = [];
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
        const event = queue.shift()!;
        yield {
          kind: 'stream_event',
          requestId: 'req_1',
          seq: seq++,
          event,
        };
      }
    }
    return gen();
  });

  return { stream, push, close };
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
});
