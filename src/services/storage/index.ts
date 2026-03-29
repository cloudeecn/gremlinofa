/**
 * Storage service entry point for web
 * Auto-routes to IndexedDBAdapter or RemoteStorageAdapter based on localStorage config
 */

import { UnifiedStorage } from './unifiedStorage';
import { IndexedDBAdapter } from './adapters/IndexedDBAdapter';
import { RemoteStorageAdapter } from './adapters/RemoteStorageAdapter';
import { CachedStorageAdapter } from './adapters/CachedStorageAdapter';
import { getStorageConfig, type StorageConfig } from './storageConfig';

/**
 * Factory function to create a storage adapter
 * @param config Optional storage config. If not provided, reads from localStorage.
 * Useful for creating instances with explicit config (e.g., OOBE, migration/sync)
 */
export function createStorageAdapter(config?: StorageConfig): CachedStorageAdapter {
  const resolvedConfig = config ?? getStorageConfig();

  let inner;
  if (resolvedConfig.type === 'remote') {
    inner = new RemoteStorageAdapter(
      resolvedConfig.baseUrl,
      resolvedConfig.userId,
      resolvedConfig.password
    );
  } else {
    inner = new IndexedDBAdapter();
  }

  return new CachedStorageAdapter(inner);
}

/**
 * Factory function to create a UnifiedStorage instance
 * @param config Optional storage config. If not provided, reads from localStorage.
 * Creates a new instance each time - useful for OOBE, migration/sync scenarios
 */
export function createStorage(config?: StorageConfig): UnifiedStorage {
  const adapter = createStorageAdapter(config);
  return new UnifiedStorage(adapter);
}

// Default singleton instance (auto-routes based on config at module load time)
export const storage = createStorage();
