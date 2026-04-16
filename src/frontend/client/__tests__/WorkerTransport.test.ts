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
  private listeners: ((ev: MessageEvent) => void)[] = [];
  private terminated = false;

  postMessage(msg: unknown): void {
    if (this.terminated) throw new Error('worker terminated');
    this.posted.push(msg);
  }
  addEventListener(_kind: 'message', listener: (ev: MessageEvent) => void): void {
    this.listeners.push(listener);
  }
  removeEventListener(_kind: 'message', listener: (ev: MessageEvent) => void): void {
    this.listeners = this.listeners.filter(l => l !== listener);
  }
  terminate(): void {
    this.terminated = true;
  }
  simulateMessage(data: unknown): void {
    const ev = { data } as MessageEvent;
    for (const l of this.listeners) l(ev);
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

  it('dispose() terminates the worker', () => {
    const terminate = vi.spyOn(worker, 'terminate');
    transport.dispose();
    expect(terminate).toHaveBeenCalled();
  });
});
