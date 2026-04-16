/**
 * Frontend client entry point. Exposes the singleton `gremlinClient` used
 * by `AppContext`, `useProject`, `useMinionChat`, and (eventually) all
 * other React surfaces.
 *
 * The default singleton uses the **worker transport**: a Web Worker hosts
 * `GremlinServer` (storage adapter, agentic loop, API clients, tools) and
 * the main thread only owns React + DOM. The worker boots dormant — every
 * RPC blocks until the main thread calls `gremlinClient.init({cek})` (see
 * `bootstrapClient.ts`). The CEK never crosses the boundary except through
 * that one method.
 *
 * Phase 1.65 deleted the in-process / jsdom production fallback. The worker
 * transport is now the only production path; in environments where `Worker`
 * is unavailable the singleton throws on first method access. The
 * construction is **lazy** — importing this module (or any component that
 * imports it) does not spawn a worker. Tests that render components
 * transitively depending on `gremlinClient` therefore don't need to mock
 * it unless they actually call a method on it; tests that DO need the
 * engine in-process construct an `InProcessTransport` directly (see
 * `GremlinClient.contract.test.ts`).
 *
 * Phase 2 will introduce a third transport (`WebSocketTransport`) that
 * talks to a Node-side `GremlinServer`. The contract is the same — only
 * the wire format changes.
 */

import type { Transport } from '../../shared/protocol/protocol';
import { ActiveLoopsStore } from './ActiveLoopsStore';
import { GremlinClient } from './GremlinClient';
import { WorkerTransport } from './transports/worker';

export { GremlinClient } from './GremlinClient';
export { GremlinSession } from './GremlinSession';
export type { SessionEventHandler, SessionEndHandler } from './GremlinSession';
export { ActiveLoopsStore } from './ActiveLoopsStore';

/**
 * Spawn the Web Worker and wrap it in a `WorkerTransport`. Throws if the
 * runtime doesn't have `Worker` (jsdom without explicit setup, SSR, very
 * old browsers) — there is no longer a main-thread fallback.
 */
function createDefaultTransport(): Transport {
  if (typeof Worker === 'undefined' || typeof window === 'undefined') {
    throw new Error(
      'gremlinClient requires a browser environment with Web Workers. ' +
        'Tests that need the engine in-process should construct an InProcessTransport directly.'
    );
  }
  try {
    // Vite statically rewrites `new URL(..., import.meta.url)` + `new Worker`
    // into a worker bundle entry. The `?worker` import suffix is the
    // alternative form, but the URL form is more portable across bundlers.
    const worker = new Worker(new URL('../../worker/gremlinWorker.ts', import.meta.url), {
      type: 'module',
      name: 'gremlin-backend',
    });
    return new WorkerTransport(worker);
  } catch (err) {
    throw new Error(
      `gremlinClient failed to spawn Web Worker: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

let _gremlinClient: GremlinClient | undefined;

/** Lazy accessor — constructs the worker transport on first touch. */
function getGremlinClient(): GremlinClient {
  if (!_gremlinClient) {
    _gremlinClient = new GremlinClient(createDefaultTransport());
  }
  return _gremlinClient;
}

/**
 * Singleton — use this everywhere on the frontend. Backed by a `Proxy` so
 * the underlying `GremlinClient` is constructed on first method access
 * rather than at module-import time. This keeps jsdom-only component tests
 * (e.g. `MessageBubble.test.tsx`) working without forcing them to mock the
 * client just because they transitively import a component that does.
 */
export const gremlinClient: GremlinClient = new Proxy({} as GremlinClient, {
  get(_target, prop, receiver) {
    return Reflect.get(getGremlinClient(), prop, receiver);
  },
});

/** Singleton store backing the sidebar's Running Loops section. */
export const activeLoopsStore = new ActiveLoopsStore(gremlinClient);
