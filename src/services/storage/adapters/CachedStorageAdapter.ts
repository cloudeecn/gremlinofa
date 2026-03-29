import type {
  StorageAdapter,
  QueryFilters,
  RecordMetadata,
  ColumnName,
  ExportPage,
  BatchSaveRow,
  BatchSaveResult,
  BatchGetResult,
} from '../StorageAdapter';

type GetResult = { encryptedData: string; timestamp?: string; unencryptedData?: string } | null;

interface CacheEntry {
  value: GetResult;
  expiry: number;
}

const TTL = 10_000;
const SWEEP_INTERVAL = 20_000;

/**
 * Decorator that adds a short-lived in-memory cache to `get()` lookups.
 * Range reads (`query`, `exportPaginated`, etc.) bypass the cache entirely.
 * Writes invalidate affected keys; a lazy sweep clears dangling entries.
 */
export class CachedStorageAdapter implements StorageAdapter {
  private inner: StorageAdapter;
  private cache = new Map<string, CacheEntry>();
  private lastSweep = Date.now();

  constructor(inner: StorageAdapter) {
    this.inner = inner;
  }

  private cacheKey(table: string, id: string): string {
    return `${table}:${id}`;
  }

  private sweep(): void {
    const now = Date.now();
    if (now - this.lastSweep < SWEEP_INTERVAL) return;
    for (const [key, entry] of this.cache) {
      if (now >= entry.expiry) {
        this.cache.delete(key);
      }
    }
    this.lastSweep = now;
  }

  private invalidateTable(table: string): void {
    const prefix = `${table}:`;
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) {
        this.cache.delete(key);
      }
    }
  }

  // --- Cached read ---

  async get(table: string, id: string): Promise<GetResult> {
    const key = this.cacheKey(table, id);
    const now = Date.now();
    const cached = this.cache.get(key);
    if (cached && now < cached.expiry) {
      return cached.value;
    }
    if (cached) {
      this.cache.delete(key);
    }
    const result = await this.inner.get(table, id);
    this.cache.set(key, { value: result, expiry: now + TTL });
    return result;
  }

  // --- Passthrough reads ---

  query(
    table: string,
    filters?: QueryFilters
  ): Promise<Array<{ encryptedData: string; unencryptedData?: string }>> {
    return this.inner.query(table, filters);
  }

  count(table: string, filters?: QueryFilters): Promise<number> {
    return this.inner.count(table, filters);
  }

  exportPaginated(table: string, afterId?: string, columns?: ColumnName[]): Promise<ExportPage> {
    return this.inner.exportPaginated(table, afterId, columns);
  }

  batchGet(table: string, ids: string[], columns?: ColumnName[]): Promise<BatchGetResult> {
    return this.inner.batchGet(table, ids, columns);
  }

  getStorageQuota(): Promise<{ usage: number; quota: number } | null> {
    return this.inner.getStorageQuota();
  }

  // --- Writes (invalidate + sweep) ---

  async save(
    table: string,
    id: string,
    encryptedData: string,
    metadata: RecordMetadata
  ): Promise<void> {
    this.cache.delete(this.cacheKey(table, id));
    await this.inner.save(table, id, encryptedData, metadata);
    this.sweep();
  }

  async delete(table: string, id: string): Promise<void> {
    this.cache.delete(this.cacheKey(table, id));
    await this.inner.delete(table, id);
    this.sweep();
  }

  async deleteMany(table: string, filters: QueryFilters): Promise<void> {
    this.invalidateTable(table);
    await this.inner.deleteMany(table, filters);
    this.sweep();
  }

  async batchSave(
    table: string,
    rows: BatchSaveRow[],
    skipExisting: boolean
  ): Promise<BatchSaveResult> {
    for (const row of rows) {
      this.cache.delete(this.cacheKey(table, row.id));
    }
    const result = await this.inner.batchSave(table, rows, skipExisting);
    this.sweep();
    return result;
  }

  async clearAll(): Promise<void> {
    this.cache.clear();
    await this.inner.clearAll();
    this.sweep();
  }

  // --- Lifecycle ---

  initialize(): Promise<void> {
    return this.inner.initialize();
  }
}
