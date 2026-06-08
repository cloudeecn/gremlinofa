/**
 * Bridged integration test — wires `WorkerTransport` to `createWorkerHandler`
 * in-process so the full chain is exercised without a real Web Worker:
 *
 *   GremlinClient → WorkerTransport → BridgedFakeWorker → workerHandler
 *     → GremlinServer → fake-IndexedDB → response → transport → client
 *
 * This catches wiring bugs in the worker entry point that the contract test
 * (InProcessTransport) and the transport test (manual FakeWorker) miss:
 * bootstrap handshake, worker_config stashing, STREAM_METHODS dispatch
 * routing, stream_cancel propagation, and error envelope wrapping.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WorkerTransport } from '../../frontend/client/transports/worker';
import { GremlinClient } from '../../frontend/client/GremlinClient';
import { createWorkerHandler, type WorkerScope } from '../workerHandler';
import type { GremlinServer } from '../../shared/engine/GremlinServer';
import type { Project } from '../../shared/protocol/types';

// Valid 50-char base32 CEK (same one used in encryptionCore.test.ts).
const TEST_CEK = 'abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrst';

// ---------------------------------------------------------------------------
// BridgedFakeWorker — connects WorkerTransport ↔ workerHandler in-process.
// ---------------------------------------------------------------------------

/**
 * Dual-faced bridge: the main-thread side (`Worker` interface) is consumed
 * by `WorkerTransport`; the worker side (`WorkerScope`) is consumed by
 * `createWorkerHandler`. Messages flow synchronously between them —
 * `handleRequest` inside the worker handler is async, so the microtask
 * boundary keeps ordering correct.
 */
class BridgedFakeWorker {
  private mainListeners: ((ev: MessageEvent) => void)[] = [];
  private workerListeners: ((ev: MessageEvent) => void)[] = [];
  private terminated = false;

  /** The scope passed to `createWorkerHandler`. */
  readonly scope: WorkerScope = {
    postMessage: (msg: unknown) => {
      if (this.terminated) return;
      const ev = { data: msg } as MessageEvent;
      for (const l of [...this.mainListeners]) l(ev);
    },
    addEventListener: (_type: 'message', handler: (ev: MessageEvent) => void) => {
      this.workerListeners.push(handler);
    },
  };

  // -- Worker interface (consumed by WorkerTransport) --

  postMessage(msg: unknown): void {
    if (this.terminated) throw new Error('worker terminated');
    const ev = { data: msg } as MessageEvent;
    for (const l of [...this.workerListeners]) l(ev);
  }

  addEventListener(_type: 'message', handler: (ev: MessageEvent) => void): void {
    this.mainListeners.push(handler);
  }

  removeEventListener(_type: 'message', handler: (ev: MessageEvent) => void): void {
    this.mainListeners = this.mainListeners.filter(l => l !== handler);
  }

  terminate(): void {
    this.terminated = true;
  }
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const mkProject = (id: string): Project => ({
  id,
  name: `proj-${id}`,
  icon: '📁',
  createdAt: new Date(),
  lastUsedAt: new Date(),
  apiDefinitionId: null,
  modelId: null,
  systemPrompt: '',
  preFillResponse: '',
  webSearchEnabled: false,
  temperature: 1,
  maxOutputTokens: 1024,
  enableReasoning: false,
  reasoningBudgetTokens: 0,
});

interface TestContext {
  client: GremlinClient;
  transport: WorkerTransport;
  server: GremlinServer;
  bridge: BridgedFakeWorker;
}

/**
 * Stand up the full bridged stack. Uses `{ type: 'local' }` so the worker
 * handler creates an `IndexedDBAdapter` backed by `fake-indexeddb` (wired
 * up by the global test setup). The real `EncryptionCore` + real
 * `UnifiedStorage` run end-to-end.
 */
async function setup(): Promise<TestContext> {
  const bridge = new BridgedFakeWorker();

  // 1. Transport registers its listeners on the bridge (main-thread side).
  const transport = new WorkerTransport(bridge as unknown as Worker);

  // 2. Worker handler wires up on the scope side and posts `worker_ready`.
  //    Since routing is synchronous, the transport's readyPromise resolves
  //    immediately.
  const server = createWorkerHandler(bridge.scope);

  // 3. Post the storage config (awaits readyPromise — already resolved).
  await transport.configureWorker({ type: 'local' });

  // 4. Run init — deferred-mode path builds EncryptionCore + IndexedDB.
  const client = new GremlinClient(transport);
  await client.init({ cek: TEST_CEK });

  return { client, transport, server, bridge };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('workerHandler (bridged integration)', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setup();
  });

  afterEach(() => {
    ctx.transport.dispose();
  });

  // ---- bootstrap ----

  it('completes the worker_ready → worker_config → init handshake', () => {
    // If setup() didn't throw, the full deferred-mode bootstrap succeeded:
    // worker_ready → configureWorker → init({cek}) → EncryptionCore +
    // IndexedDBAdapter + UnifiedStorage constructed.
    expect(ctx.client).toBeDefined();
  });

  // ---- one-shot CRUD ----

  it('round-trips project save → get → list → delete', async () => {
    const proj = mkProject('p1');

    await ctx.client.saveProject(proj);
    const fetched = await ctx.client.getProject('p1');
    expect(fetched).toMatchObject({ id: 'p1', name: 'proj-p1' });

    const all = await ctx.client.getProjects();
    expect(all).toHaveLength(1);

    await ctx.client.deleteProject('p1');
    const afterDelete = await ctx.client.getProjects();
    expect(afterDelete).toHaveLength(0);
  });

  it('getStorageQuota returns a numeric result', async () => {
    const quota = await ctx.client.getStorageQuota();
    expect(typeof quota.usage).toBe('number');
    expect(typeof quota.quota).toBe('number');
  });

  it('listActiveLoops returns an empty array when nothing is running', async () => {
    const loops = await ctx.client.listActiveLoops();
    expect(loops).toEqual([]);
  });

  // ---- error propagation ----

  it('propagates ProtocolError through the bridge', async () => {
    await expect(ctx.client.abortLoop('nonexistent')).rejects.toMatchObject({
      code: 'LOOP_NOT_FOUND',
    });
  });

  // ---- streaming ----

  it('dispatches subscribeActiveLoops as a stream (not one-shot)', async () => {
    const events: unknown[] = [];
    for await (const env of ctx.client.stream('subscribeActiveLoops', {})) {
      events.push(env);
      // The initial snapshot arrives first; break to test stream_cancel.
      if (env.kind === 'stream_event') break;
    }
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0]).toMatchObject({ kind: 'stream_event' });
  });

  it('dispatches exportData as a stream and completes', async () => {
    // With an empty database the export produces header + done events.
    const events: unknown[] = [];
    for await (const env of ctx.client.stream('exportData', {})) {
      events.push(env);
    }
    // Should contain stream_event(s) and a stream_end.
    const streamEnd = events.find((e: unknown) => (e as { kind: string }).kind === 'stream_end');
    expect(streamEnd).toBeDefined();
  });
});
