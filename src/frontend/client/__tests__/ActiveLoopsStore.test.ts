import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ActiveLoopsStore } from '../ActiveLoopsStore';
import type { GremlinClient } from '../GremlinClient';
import type {
  ActiveLoop,
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

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

function makeLoop(overrides: Partial<ActiveLoop> = {}): ActiveLoop {
  return {
    loopId: 'loop_1',
    chatId: 'c1',
    startedAt: 1000,
    status: 'running',
    apiDefinitionId: 'api_1',
    modelId: 'm1',
    ...overrides,
  };
}

describe('ActiveLoopsStore', () => {
  let push: (change: ActiveLoopsChange) => void;
  let close: () => void;
  let store: ActiveLoopsStore;
  let getChat: ReturnType<typeof vi.fn<(chatId: string) => Promise<{ name: string } | null>>>;

  beforeEach(() => {
    const ctrl = makeControllableStream();
    push = ctrl.push;
    close = ctrl.close;
    getChat = vi.fn(async (chatId: string) => ({ name: `Title of ${chatId}` }));
    const client = {
      stream: ctrl.stream,
      abortLoop: vi.fn(async () => {}),
      onReconnect: vi.fn(() => () => {}),
      getChat,
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

  it('merges softStopRequested and preserves it across a status-only update', async () => {
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

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
    expect(store.getSnapshot()[0].softStopRequested).toBeUndefined();

    // Soft-stop delta sets the flag.
    push({ type: 'updated', loopId: 'loop_1', status: 'running', softStopRequested: true });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(store.getSnapshot()[0].softStopRequested).toBe(true);

    // A later status-only delta (e.g. hard abort) must not clear the request.
    push({ type: 'updated', loopId: 'loop_1', status: 'aborting' });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(store.getSnapshot()[0].status).toBe('aborting');
    expect(store.getSnapshot()[0].softStopRequested).toBe(true);

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

  describe('snapshot identity', () => {
    it('keeps the loops array when a delta changes nothing', async () => {
      const listener = vi.fn();
      const unsubscribe = store.subscribe(listener);
      push({ type: 'snapshot', loops: [makeLoop({ softStopRequested: true })] });
      await flush();
      const loops = store.getSnapshot();
      listener.mockClear();

      push({ type: 'updated', loopId: 'loop_1', status: 'running' });
      push({ type: 'updated', loopId: 'loop_1', status: 'running', softStopRequested: true });
      push({ type: 'updated', loopId: 'loop_unknown', status: 'aborting' });
      push({ type: 'ended', loopId: 'loop_unknown', status: 'complete' });
      await flush();

      expect(store.getSnapshot()).toBe(loops);
      expect(listener).not.toHaveBeenCalled();

      unsubscribe();
      close();
    });

    it('publishes a title change without touching the loops array', async () => {
      const listener = vi.fn();
      const unsubscribe = store.subscribe(listener);
      push({ type: 'snapshot', loops: [makeLoop()] });
      await flush();
      const loops = store.getSnapshot();
      listener.mockClear();

      push({ type: 'chat_title_changed', chatId: 'c1', title: 'Renamed' });
      await flush();
      expect(store.getSnapshot()).toBe(loops);
      expect(store.getTitlesSnapshot().get('c1')).toBe('Renamed');
      expect(listener).toHaveBeenCalledTimes(1);

      // The same title again is a no-op
      const titles = store.getTitlesSnapshot();
      push({ type: 'chat_title_changed', chatId: 'c1', title: 'Renamed' });
      await flush();
      expect(store.getTitlesSnapshot()).toBe(titles);
      expect(listener).toHaveBeenCalledTimes(1);

      unsubscribe();
      close();
    });
  });

  describe('chat titles', () => {
    it('looks each chat up once across republishes and remounts', async () => {
      const unsubscribe = store.subscribe(vi.fn());
      push({ type: 'snapshot', loops: [makeLoop()] });
      await flush();
      expect(getChat).toHaveBeenCalledTimes(1);
      expect(getChat).toHaveBeenCalledWith('c1');
      expect(store.getTitlesSnapshot().get('c1')).toBe('Title of c1');
      expect(store.getPendingTitlesSnapshot().size).toBe(0);

      push({ type: 'updated', loopId: 'loop_1', status: 'aborting' });
      push({ type: 'started', loop: makeLoop({ loopId: 'loop_2' }) });
      await flush();

      // Section remount: the old listener leaves, a new one arrives
      unsubscribe();
      const unsubscribeAgain = store.subscribe(vi.fn());
      push({ type: 'snapshot', loops: [makeLoop(), makeLoop({ loopId: 'loop_2' })] });
      await flush();

      expect(getChat).toHaveBeenCalledTimes(1);

      unsubscribeAgain();
      close();
    });

    it('dedupes an in-flight lookup and reports it as pending', async () => {
      let resolveLookup: (chat: { name: string }) => void = () => {};
      getChat.mockImplementation(
        () =>
          new Promise(resolve => {
            resolveLookup = resolve;
          })
      );
      const unsubscribe = store.subscribe(vi.fn());
      const titles = store.getTitlesSnapshot();
      push({
        type: 'snapshot',
        loops: [makeLoop(), makeLoop({ loopId: 'loop_2' })],
      });
      await flush();
      expect(getChat).toHaveBeenCalledTimes(1);
      expect(store.getPendingTitlesSnapshot().has('c1')).toBe(true);
      // Starting a lookup changes only the pending set
      expect(store.getTitlesSnapshot()).toBe(titles);

      resolveLookup({ name: 'Late title' });
      await flush();
      expect(store.getPendingTitlesSnapshot().has('c1')).toBe(false);
      expect(store.getTitlesSnapshot().get('c1')).toBe('Late title');

      unsubscribe();
      close();
    });

    it('skips loops that carry a displayName', async () => {
      const unsubscribe = store.subscribe(vi.fn());
      push({ type: 'snapshot', loops: [] });
      push({
        type: 'started',
        loop: makeLoop({ loopId: 'loop_m', chatId: 'minion_1', displayName: 'Researcher' }),
      });
      await flush();
      expect(getChat).not.toHaveBeenCalled();
      expect(store.getPendingTitlesSnapshot().size).toBe(0);

      unsubscribe();
      close();
    });

    it('does not retry failed or empty lookups', async () => {
      const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
      getChat.mockImplementation(async (chatId: string) => {
        if (chatId === 'c1') throw new Error('offline');
        return null;
      });
      const unsubscribe = store.subscribe(vi.fn());
      const loops = [makeLoop(), makeLoop({ loopId: 'loop_2', chatId: 'c2' })];
      push({ type: 'snapshot', loops });
      await flush();
      expect(getChat).toHaveBeenCalledTimes(2);
      expect(store.getPendingTitlesSnapshot().size).toBe(0);
      expect(store.getTitlesSnapshot().size).toBe(0);

      push({ type: 'snapshot', loops });
      push({ type: 'started', loop: makeLoop({ loopId: 'loop_3' }) });
      await flush();
      expect(getChat).toHaveBeenCalledTimes(2);

      unsubscribe();
      close();
      debug.mockRestore();
    });

    it('keeps a live title that arrives while the lookup is in flight', async () => {
      let resolveLookup: (chat: { name: string }) => void = () => {};
      getChat.mockImplementation(
        () =>
          new Promise(resolve => {
            resolveLookup = resolve;
          })
      );
      const unsubscribe = store.subscribe(vi.fn());
      push({ type: 'snapshot', loops: [makeLoop()] });
      await flush();
      push({ type: 'chat_title_changed', chatId: 'c1', title: 'Live title' });
      await flush();

      resolveLookup({ name: 'Stale title' });
      await flush();
      expect(store.getTitlesSnapshot().get('c1')).toBe('Live title');

      unsubscribe();
      close();
    });

    it("forgets a chat's title once its last loop ends, so the next loop sees a rename", async () => {
      const unsubscribe = store.subscribe(vi.fn());
      push({ type: 'snapshot', loops: [makeLoop(), makeLoop({ loopId: 'loop_2' })] });
      await flush();
      expect(store.getTitlesSnapshot().get('c1')).toBe('Title of c1');

      // Another loop in the chat still runs: the title stays
      push({ type: 'ended', loopId: 'loop_1', status: 'complete' });
      await flush();
      expect(store.getTitlesSnapshot().get('c1')).toBe('Title of c1');

      push({ type: 'ended', loopId: 'loop_2', status: 'complete' });
      await flush();
      expect(store.getTitlesSnapshot().has('c1')).toBe(false);

      // Renamed by hand between loops (patchChat broadcasts nothing)
      getChat.mockResolvedValue({ name: 'Renamed by hand' });
      push({ type: 'started', loop: makeLoop({ loopId: 'loop_3' }) });
      await flush();
      expect(getChat).toHaveBeenCalledTimes(2);
      expect(store.getTitlesSnapshot().get('c1')).toBe('Renamed by hand');

      unsubscribe();
      close();
    });

    it('retries a failed lookup for a later run, not within one', async () => {
      const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
      getChat.mockRejectedValueOnce(new Error('offline'));
      const unsubscribe = store.subscribe(vi.fn());
      push({ type: 'started', loop: makeLoop() });
      await flush();
      expect(store.getTitlesSnapshot().has('c1')).toBe(false);

      push({ type: 'ended', loopId: 'loop_1', status: 'complete' });
      push({ type: 'started', loop: makeLoop({ loopId: 'loop_2' }) });
      await flush();
      expect(getChat).toHaveBeenCalledTimes(2);
      expect(store.getTitlesSnapshot().get('c1')).toBe('Title of c1');

      unsubscribe();
      close();
      debug.mockRestore();
    });

    it('drops a lookup that resolves after its chat went idle', async () => {
      const lookups: Array<(chat: { name: string }) => void> = [];
      getChat.mockImplementation(
        () =>
          new Promise(resolve => {
            lookups.push(resolve);
          })
      );
      const unsubscribe = store.subscribe(vi.fn());
      push({ type: 'started', loop: makeLoop() });
      await flush();
      push({ type: 'ended', loopId: 'loop_1', status: 'complete' });
      await flush();
      expect(store.getPendingTitlesSnapshot().size).toBe(0);

      // A new run looks the title up again; the old answer must not win
      push({ type: 'started', loop: makeLoop({ loopId: 'loop_2' }) });
      await flush();
      expect(lookups).toHaveLength(2);
      lookups[0]({ name: 'Old name' });
      await flush();
      expect(store.getTitlesSnapshot().has('c1')).toBe(false);
      expect(store.getPendingTitlesSnapshot().has('c1')).toBe(true);

      lookups[1]({ name: 'New name' });
      await flush();
      expect(store.getTitlesSnapshot().get('c1')).toBe('New name');
      expect(store.getPendingTitlesSnapshot().size).toBe(0);

      unsubscribe();
      close();
    });
  });

  describe('start()', () => {
    it('opens the stream with no React subscriber', async () => {
      store.start();
      push({ type: 'snapshot', loops: [makeLoop({ softStopRequested: true })] });
      await flush();
      expect(store.getSnapshot()[0].softStopRequested).toBe(true);

      // A later subscriber shares the same stream
      const unsubscribe = store.subscribe(vi.fn());
      store.start();
      const client = (store as unknown as { client: { stream: ReturnType<typeof vi.fn> } }).client;
      expect(client.stream).toHaveBeenCalledTimes(1);

      unsubscribe();
      close();
    });
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

    it('reopens a started stream with no React subscriber', async () => {
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
        getChat: vi.fn(async () => null),
      } as unknown as GremlinClient;

      // The app shell starts the store; the Sidebar may never mount
      const reconnectStore = new ActiveLoopsStore(client);
      reconnectStore.start();
      stream1.disconnect();
      await flush();

      reconnectCb!();
      expect(factory).toHaveBeenCalledTimes(2);
      stream2.push({ type: 'snapshot', loops: [makeLoop({ loopId: 'loop_2', chatId: 'c2' })] });
      await flush();
      expect(reconnectStore.getSnapshot()[0].loopId).toBe('loop_2');

      reconnectStore.dispose();
      stream2.close();
    });

    it('does not reopen a stream nothing started', () => {
      let reconnectCb: (() => void) | undefined;
      const stream = vi.fn();
      const client = {
        stream,
        onReconnect: vi.fn((cb: () => void) => {
          reconnectCb = cb;
          return () => {};
        }),
      } as unknown as GremlinClient;

      const idleStore = new ActiveLoopsStore(client);
      reconnectCb!();
      expect(stream).not.toHaveBeenCalled();
      idleStore.dispose();
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
