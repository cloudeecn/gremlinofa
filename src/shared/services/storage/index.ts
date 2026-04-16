/**
 * Storage service entry point.
 *
 * After Phase 1.65 the inner adapter classes (`IndexedDBAdapter`,
 * `RemoteStorageAdapter`) live under `src/worker/adapters/` along with
 * the `createStorageAdapter` factory. This module is now just a re-export
 * surface for the `StorageConfig` type. Worker code that needs to build
 * a `UnifiedStorage` reaches into `src/worker/adapters/createStorageAdapter`
 * directly; the dispatcher (`GremlinServer.init`) reads the factory off
 * `BackendDeps.createStorageAdapter`.
 */

import type { StorageConfig } from '../../protocol/types/storageConfig';

export type { StorageConfig };
