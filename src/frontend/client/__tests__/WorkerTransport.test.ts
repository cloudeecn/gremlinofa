import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WorkerTransport } from '../transports/worker';

/**
 * Drive `WorkerTransport` against a hand-rolled fake `Worker` so we don't
 * need a real Web Worker environment. The fake captures every postMessage
 * the transport sends and lets the test inject inbound messages via
 * `simulateMessage`. The exact framing the fake produces matches what the
 * real worker would post back, so the transport contract is exercised
 * end-to-end (worker_ready handshake, init gating, request/response,
 * stream_event/stream_end, stream_cancel on early break, error envelopes).
 */
class FakeWorker {
  public posted: unknown[] = [];
  private listeners = new Map<string, ((ev: Event) => void)[]>();
  private terminated = false;

  postMessage(msg: unknown): void {
    if (this.terminated) throw new Error('worker terminated');
    this.posted.push(msg);
  }
  addEventListener(kind: string, listener: (ev: Event) => void): void {
    this.listeners.set(kind, [...(this.listeners.get(kind) ?? []), listener]);
  }
  removeEventListener(kind: string, listener: (ev: Event) => void): void {
    this.listeners.set(
      kind,
      (this.listeners.get(kind) ?? []).filter(l => l !== listener)
    );
  }
  listenerCount(kind: string): number {
    return this.listeners.get(kind)?.length ?? 0;
  }
  terminate(): void {
    this.terminated = true;
  }
  simulateMessage(data: unknown): void {
    const ev = { data } as MessageEvent;
    for (const l of this.listeners.get('message') ?? []) l(ev);
  }
  /** What the browser fires when the worker script fails or throws. */
  simulateError(fields: Partial<ErrorEvent> = {}): void {
    const ev = { type: 'error', ...fields } as Event;
    for (const l of this.listeners.get('error') ?? []) l(ev);
  }
}

/**
 * Build a transport that's already passed both the `worker_ready` handshake
 * and the first `init` round-trip, so subsequent RPCs flow without setup
 * boilerplate in each test.
 */
async function makeReadyTransport(): Promise<{ transport: WorkerTransport; worker: FakeWorker }> {
  const worker = new FakeWorker();
  const transport = new WorkerTransport(worker as unknown as Worker);

  // 1. Worker announces it's ready to accept envelopes.
  worker.simulateMessage({ kind: 'worker_ready' });

  // 2. Issue init (it bypasses initPromise and goes through immediately).
  const initPromise = transport.request('init', {});
  // Drain microtasks so the request envelope is actually posted.
  await Promise.resolve();
  await Promise.resolve();
  const initEnvelope = worker.posted.find(
    m => (m as { kind?: string; method?: string }).method === 'init'
  ) as { requestId: string };

  // 3. Worker responds — initPromise resolves and unblocks the queue.
  worker.simulateMessage({
    kind: 'response',
    requestId: initEnvelope.requestId,
    result: { ok: true, subscriberId: 'sub_test', serverVersion: '1.0.0-phase1' },
  });
  await initPromise;

  return { transport, worker };
}

describe('WorkerTransport', () => {
  let transport: WorkerTransport;
  let worker: FakeWorker;

  beforeEach(async () => {
    const built = await makeReadyTransport();
    transport = built.transport;
    worker = built.worker;
  });

  it('routes one-shot requests through the worker and resolves with the response', async () => {
    const promise = transport.request('listProjects', {});
    await Promise.resolve();
    await Promise.resolve();
    const requestEnvelope = worker.posted.find(
      m => (m as { kind?: string; method?: string }).method === 'listProjects'
    ) as { requestId: string; method: string };
    expect(requestEnvelope).toMatchObject({ kind: 'request', method: 'listProjects' });

    worker.simulateMessage({
      kind: 'response',
      requestId: requestEnvelope.requestId,
      result: [{ id: 'p1' }],
    });
    await expect(promise).resolves.toEqual([{ id: 'p1' }]);
  });

  it('rejects requests with a typed ProtocolError when the worker emits an error envelope', async () => {
    const promise = transport.request('abortLoop', { loopId: 'missing' });
    await Promise.resolve();
    await Promise.resolve();
    const requestEnvelope = worker.posted.find(
      m => (m as { kind?: string; method?: string }).method === 'abortLoop'
    ) as { requestId: string };

    worker.simulateMessage({
      kind: 'error',
      requestId: requestEnvelope.requestId,
      code: 'LOOP_NOT_FOUND',
      message: 'no running loop with id missing',
    });

    await expect(promise).rejects.toMatchObject({ code: 'LOOP_NOT_FOUND' });
  });

  it('streams events through the consumer and ends on stream_end', async () => {
    const events: unknown[] = [];
    const consume = (async () => {
      for await (const env of transport.stream('subscribeActiveLoops', {})) {
        events.push(env);
      }
    })();
    // Drain microtasks for both `await this.readyPromise` and `await
    // this.initPromise` inside the stream generator before we look for
    // the posted request envelope.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    const requestEnvelope = worker.posted.find(
      m => (m as { kind?: string; method?: string }).method === 'subscribeActiveLoops'
    ) as { requestId: string };
    expect(requestEnvelope).toBeDefined();

    worker.simulateMessage({
      kind: 'stream_event',
      requestId: requestEnvelope.requestId,
      seq: 0,
      event: { type: 'snapshot', loops: [] },
    });
    worker.simulateMessage({
      kind: 'stream_end',
      requestId: requestEnvelope.requestId,
      status: 'complete',
    });

    await consume;
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      kind: 'stream_event',
      event: { type: 'snapshot' },
    });
    expect(events[1]).toMatchObject({ kind: 'stream_end', status: 'complete' });
  });

  it('sends stream_cancel when the consumer breaks out early', async () => {
    const consume = (async () => {
      for await (const env of transport.stream('subscribeActiveLoops', {})) {
        // Break out after the first event so the finally block fires.
        void env;
        break;
      }
    })();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    const requestEnvelope = worker.posted.find(
      m => (m as { kind?: string; method?: string }).method === 'subscribeActiveLoops'
    ) as { requestId: string };

    worker.simulateMessage({
      kind: 'stream_event',
      requestId: requestEnvelope.requestId,
      seq: 0,
      event: { type: 'snapshot', loops: [] },
    });
    await consume;

    expect(worker.posted).toContainEqual({
      kind: 'stream_cancel',
      requestId: requestEnvelope.requestId,
    });
  });

  it('rejects an in-flight stream when the worker emits an error envelope', async () => {
    const consume = (async () => {
      const events: unknown[] = [];
      for await (const env of transport.stream('runLoop', {
        chatId: 'c1',
        mode: 'send',
        content: 'hi',
      })) {
        events.push(env);
      }
      return events;
    })();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    const requestEnvelope = worker.posted.find(
      m => (m as { kind?: string; method?: string }).method === 'runLoop'
    ) as { requestId: string };

    worker.simulateMessage({
      kind: 'error',
      requestId: requestEnvelope.requestId,
      code: 'INTERNAL_ERROR',
      message: 'kaboom',
    });

    await expect(consume).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
  });

  it('queues non-init requests until init resolves', async () => {
    const lateWorker = new FakeWorker();
    const lateTransport = new WorkerTransport(lateWorker as unknown as Worker);

    // Worker becomes ready, but init has not been sent yet.
    lateWorker.simulateMessage({ kind: 'worker_ready' });

    // Issuing a non-init request should NOT post an envelope until init lands.
    const projectsPromise = lateTransport.request('listProjects', {});
    await Promise.resolve();
    await Promise.resolve();
    const beforeInit = lateWorker.posted.find(
      m => (m as { kind?: string; method?: string }).method === 'listProjects'
    );
    expect(beforeInit).toBeUndefined();

    // Send init and resolve it.
    const initPromise = lateTransport.request('init', {});
    await Promise.resolve();
    await Promise.resolve();
    const initEnvelope = lateWorker.posted.find(
      m => (m as { kind?: string; method?: string }).method === 'init'
    ) as { requestId: string };
    expect(initEnvelope).toBeDefined();

    lateWorker.simulateMessage({
      kind: 'response',
      requestId: initEnvelope.requestId,
      result: { ok: true, subscriberId: 'sub_late', serverVersion: '1.0.0-phase1' },
    });
    await initPromise;

    // Now the queued request should have been posted.
    await Promise.resolve();
    const afterInit = lateWorker.posted.find(
      m => (m as { kind?: string; method?: string }).method === 'listProjects'
    ) as { requestId: string };
    expect(afterInit).toBeDefined();

    lateWorker.simulateMessage({
      kind: 'response',
      requestId: afterInit.requestId,
      result: [],
    });
    await expect(projectsPromise).resolves.toEqual([]);
  });

  it('lets dormant-callable methods (generateNewCEK) post before init resolves', async () => {
    // Regression: OOBE on the IndexedDB "fresh" path calls
    // gremlinClient.generateNewCEK() *before* configureWorker + init. If
    // the transport waits on initPromise for this method the OOBE flow
    // hangs forever (no UI hint, just a spinner), and the user can't
    // start the app from a clean origin.
    const lateWorker = new FakeWorker();
    const lateTransport = new WorkerTransport(lateWorker as unknown as Worker);
    lateWorker.simulateMessage({ kind: 'worker_ready' });

    const cekPromise = lateTransport.request('generateNewCEK', {});
    // The envelope must be posted immediately — no init in flight.
    await Promise.resolve();
    await Promise.resolve();
    const cekEnvelope = lateWorker.posted.find(
      m => (m as { kind?: string; method?: string }).method === 'generateNewCEK'
    ) as { requestId: string };
    expect(cekEnvelope).toBeDefined();

    lateWorker.simulateMessage({
      kind: 'response',
      requestId: cekEnvelope.requestId,
      result: 'mock_base32_cek',
    });

    // Race against a short timer so a regression that hangs fails the
    // test instead of hanging the whole suite.
    const settled = await Promise.race([
      cekPromise.then(v => ({ ok: true, value: v })),
      new Promise<{ ok: false }>(resolve => setTimeout(() => resolve({ ok: false }), 200)),
    ]);
    expect(settled).toEqual({ ok: true, value: 'mock_base32_cek' });

    // Sanity: a non-exempt method called in the same dormant state still
    // queues — we only lifted the gate for the exempt set.
    lateTransport.request('listProjects', {}).catch(() => {});
    await Promise.resolve();
    await Promise.resolve();
    const queued = lateWorker.posted.find(
      m => (m as { kind?: string; method?: string }).method === 'listProjects'
    );
    expect(queued).toBeUndefined();
  });

  it('a failed init re-arms the gate so a retried init unblocks later RPCs', async () => {
    const freshWorker = new FakeWorker();
    const freshTransport = new WorkerTransport(freshWorker as unknown as Worker);
    freshWorker.simulateMessage({ kind: 'worker_ready' });

    // First init fails (e.g. OOBE posted before worker_config).
    const firstInit = freshTransport.request('init', {});
    await Promise.resolve();
    await Promise.resolve();
    const firstEnvelope = freshWorker.posted.find(
      m => (m as { method?: string }).method === 'init'
    ) as { requestId: string };
    freshWorker.simulateMessage({
      kind: 'error',
      requestId: firstEnvelope.requestId,
      code: 'NOT_INITIALIZED',
      message: 'worker storage config has not been posted',
    });
    await expect(firstInit).rejects.toMatchObject({ code: 'NOT_INITIALIZED' });

    // A non-exempt RPC issued now must BLOCK on the fresh gate — the old
    // behavior replayed the stale rejection forever, so a retry in the
    // same page session (OOBE fixing its input) could never work.
    const queued = freshTransport.request('listProjects', {});
    let queuedSettled = false;
    void queued.finally(() => {
      queuedSettled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(queuedSettled).toBe(false);

    // Retry init — success unblocks the queued request.
    const secondInit = freshTransport.request('init', {});
    await Promise.resolve();
    await Promise.resolve();
    const initEnvelopes = freshWorker.posted.filter(
      m => (m as { method?: string }).method === 'init'
    ) as { requestId: string }[];
    freshWorker.simulateMessage({
      kind: 'response',
      requestId: initEnvelopes[initEnvelopes.length - 1].requestId,
      result: { ok: true, subscriberId: 'sub_test', serverVersion: '1.0.0-phase1' },
    });
    await secondInit;

    await Promise.resolve();
    await Promise.resolve();
    const listEnvelope = freshWorker.posted.find(
      m => (m as { method?: string }).method === 'listProjects'
    ) as { requestId: string };
    expect(listEnvelope).toBeDefined();
    freshWorker.simulateMessage({
      kind: 'response',
      requestId: listEnvelope.requestId,
      result: [],
    });
    await expect(queued).resolves.toEqual([]);
  });

  it('dispose() rejects in-flight requests', async () => {
    const promise = transport.request('listProjects', {});
    // Drain microtasks so the envelope is actually posted before dispose.
    await Promise.resolve();
    await Promise.resolve();
    transport.dispose();
    await expect(promise).rejects.toThrow('transport disposed');
  });

  it('dispose() terminates the worker', () => {
    const terminate = vi.spyOn(worker, 'terminate');
    transport.dispose();
    expect(terminate).toHaveBeenCalled();
  });

  it('dispose() removes its error listeners', () => {
    transport.dispose();
    expect(worker.listenerCount('error')).toBe(0);
    expect(worker.listenerCount('messageerror')).toBe(0);
  });

  it('logs an error raised after worker_ready without failing anything', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    worker.simulateError({ message: 'boom in a handler' });
    expect(consoleError).toHaveBeenCalled();

    const promise = transport.request('listProjects', {});
    await Promise.resolve();
    await Promise.resolve();
    const envelope = worker.posted.find(
      m => (m as { method?: string }).method === 'listProjects'
    ) as { requestId: string };
    worker.simulateMessage({ kind: 'response', requestId: envelope.requestId, result: [] });
    await expect(promise).resolves.toEqual([]);
    consoleError.mockRestore();
  });
});

describe('WorkerTransport before worker_ready', () => {
  it('fails every caller when the worker script errors before it is ready', async () => {
    const worker = new FakeWorker();
    const transport = new WorkerTransport(worker as unknown as Worker);
    const configure = transport.configureWorker({ type: 'local' });
    const init = transport.request('init', {});

    worker.simulateError({
      message: 'SyntaxError: Unexpected token',
      filename: 'gremlinWorker.js',
      lineno: 12,
    });

    await expect(configure).rejects.toThrow(
      'Backend worker failed to start: SyntaxError: Unexpected token (gremlinWorker.js:12)'
    );
    await expect(init).rejects.toThrow('Backend worker failed to start');
    // Later calls fail fast too
    await expect(transport.request('generateNewCEK', {})).rejects.toThrow(
      'Backend worker failed to start'
    );
  });

  it('names a script that failed to load when the error carries no message', async () => {
    const worker = new FakeWorker();
    const transport = new WorkerTransport(worker as unknown as Worker);
    const init = transport.request('init', {});
    worker.simulateError();
    await expect(init).rejects.toThrow('Backend worker failed to start: script failed to load');
  });

  it('dispose() rejects callers parked on the ready gate', async () => {
    const worker = new FakeWorker();
    const transport = new WorkerTransport(worker as unknown as Worker);
    const init = transport.request('init', {});
    transport.dispose();
    await expect(init).rejects.toThrow('transport disposed');
  });

  it('dispose() rejects callers parked on the init gate', async () => {
    const worker = new FakeWorker();
    const transport = new WorkerTransport(worker as unknown as Worker);
    worker.simulateMessage({ kind: 'worker_ready' });
    const queued = transport.request('listProjects', {});
    await Promise.resolve();
    transport.dispose();
    await expect(queued).rejects.toThrow('transport disposed');
  });
});
