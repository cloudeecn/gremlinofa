/**
 * Server-side storage adapter factory.
 *
 * Always creates a `SqliteStorageAdapter` wrapping the database at the
 * path specified in `ServerConfig`. The `StorageConfig` argument from the
 * protocol is ignored — the server owns its own storage and never reads
 * client-posted config.
 *
 * Captures `ServerConfig` via closure at registration time, matching the
 * worker pattern where `createStorageAdapter` is a plain function
 * conforming to `CreateStorageAdapter`.
 */

import { CachedStorageAdapter } from '../../shared/services/storage/adapters/CachedStorageAdapter';
import type { StorageConfig } from '../../shared/protocol/types/storageConfig';
import type { ServerConfig } from '../config';
import { SqliteStorageAdapter } from './SqliteStorageAdapter';

export function makeCreateStorageAdapter(
  serverConfig: ServerConfig
): (config: StorageConfig) => CachedStorageAdapter {
  return (_config: StorageConfig) => {
    const inner = new SqliteStorageAdapter(serverConfig.storagePath);
    return new CachedStorageAdapter(inner);
  };
}
