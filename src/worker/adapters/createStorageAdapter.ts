/**
 * Worker-side storage adapter factory.
 *
 * Builds a `CachedStorageAdapter` wrapping the right inner adapter
 * (`IndexedDBAdapter` for local, `RemoteStorageAdapter` for remote) from
 * an explicit `StorageConfig`. Phase 1.65 hoisted this factory out of
 * `src/shared/services/storage/index.ts` so the inner adapters can live
 * under `src/worker/adapters/` (where the lint rule for shared/ doesn't
 * have to permit `indexedDB` / `navigator`).
 *
 * The worker entry imports this and registers it via
 * `GremlinServer.setBootstrapAdapterFactories` at module load. Inside
 * `GremlinServer.init` the factory is read off the bootstrap state and
 * threaded into `BackendDeps.createStorageAdapter` for downstream call
 * sites (`validateRemoteStorage` constructs a remote-storage probe via
 * the deps factory rather than importing `RemoteStorageAdapter` directly).
 */

import { CachedStorageAdapter } from '../../shared/services/storage/adapters/CachedStorageAdapter';
import type { StorageConfig } from '../../shared/protocol/types/storageConfig';
import { IndexedDBAdapter } from './IndexedDBAdapter';
import { RemoteStorageAdapter } from './RemoteStorageAdapter';

export function createStorageAdapter(config: StorageConfig): CachedStorageAdapter {
  const inner =
    config.type === 'remote'
      ? new RemoteStorageAdapter(config.baseUrl, config.userId, config.password)
      : new IndexedDBAdapter();
  return new CachedStorageAdapter(inner);
}
