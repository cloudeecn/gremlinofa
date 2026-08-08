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
 * Phase 2 added `WebSocketTransport` — when the storage config is
 * `{ type: 'server', wsUrl }`, the singleton connects to a Node-side
 * `GremlinServer` over WebSocket instead of spawning a worker.
 */

import type { Transport } from '../../shared/protocol/protocol';
import { getStorageConfig, type StorageConfig } from '../lib/localStorageBoot';
import { ActiveLoopsStore } from './ActiveLoopsStore';
import { GremlinClient } from './GremlinClient';
import { WebSocketTransport } from './transports/websocket';
import { WorkerTransport } from './transports/worker';

export { GremlinClient } from './GremlinClient';
export { GremlinSession } from './GremlinSession';
export type { SessionEventHandler, SessionEndHandler } from './GremlinSession';
export { ActiveLoopsStore } from './ActiveLoopsStore';

/**
 * Create the right transport for the given storage config.
 *
 * - `server` → `WebSocketTransport` pointing at the Node backend.
 * - `local` / `remote` → `WorkerTransport` hosting the engine in-browser.
 *
 * Throws if `Worker` is unavailable and the config isn't `server`.
 */
function createTransportFromConfig(config: StorageConfig): Transport {
  if (config.type === 'server') {
    return new WebSocketTransport(config.wsUrl);
  }

  if (typeof Worker === 'undefined' || typeof window === 'undefined') {
    throw new Error(
      'gremlinClient requires a browser environment with Web Workers. ' +
        'Tests that need the engine in-process should construct an InProcessTransport directly.'
    );
  }
  try {
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

/**
 * Singleton — use this everywhere on the frontend. Constructed with a lazy
 * transport factory: importing this module (including the
 * `ActiveLoopsStore` construction below, which only registers callbacks)
 * has no side effects; the transport is built from the persisted storage
 * config on the first actual RPC. Flows that change the config at runtime
 * call `rebindGremlinTransport` instead of relying on construction timing.
 */
export const gremlinClient: GremlinClient = new GremlinClient(() =>
  createTransportFromConfig(getStorageConfig())
);

/** Singleton store backing the sidebar's Running Loops section. */
export const activeLoopsStore = new ActiveLoopsStore(gremlinClient);

/**
 * Swap the singleton's transport for one matching `config` (or re-derive
 * from the persisted storage config when omitted). OOBE calls this after
 * persisting the user's storage choice so the very first attempt talks to
 * the chosen backend — and so a retry starts from a fresh transport
 * instead of a poisoned worker or a wedged socket.
 */
export function rebindGremlinTransport(config?: StorageConfig): void {
  gremlinClient.rebindTransport(
    config
      ? () => createTransportFromConfig(config)
      : () => createTransportFromConfig(getStorageConfig())
  );
}
