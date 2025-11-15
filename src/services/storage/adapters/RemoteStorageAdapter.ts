/**
 * Remote Storage Adapter
 * Connects to storage-backend via REST API for cross-device sync
 */

import type {
  BatchGetResult,
  BatchSaveResult,
  BatchSaveRow,
  ColumnName,
  ExportPage,
  QueryFilters,
  RecordMetadata,
  StorageAdapter,
} from '../StorageAdapter';
import { Tables } from '../StorageAdapter';

export class RemoteStorageAdapter implements StorageAdapter {
  private baseUrl: string;
  private authHeader: string;

  /**
   * Create a new RemoteStorageAdapter
   * @param baseUrl - Base URL for the storage backend (e.g., 'https://example.com/storage' or '' for same origin)
   * @param userId - User ID derived from CEK (64-char hex string)
   * @param password - Optional password for authentication
   */
  constructor(baseUrl: string, userId: string, password: string) {
    this.baseUrl = baseUrl;
    // Precompute auth header: base64(userId:password)
    this.authHeader = `Basic ${btoa(`${userId}:${password}`)}`;
  }

  /**
   * Build full URL for an API path
   * Handles different baseUrl formats:
   * - Empty string: use relative path (same origin)
   * - Absolute path: /storage → /storage/api/...
   * - Full URL: https://example.com → https://example.com/api/...
   */
  private buildUrl(path: string): string {
    if (!this.baseUrl) {
      return path; // Relative to current origin
    }
    // Remove trailing slash from baseUrl
    const base = this.baseUrl.replace(/\/$/, '');
    return `${base}${path}`;
  }

  /**
   * Make an authenticated fetch request
   */
  private async fetchWithAuth(path: string, options: RequestInit = {}): Promise<Response> {
    const url = this.buildUrl(path);
    const response = await fetch(url, {
      ...options,
      headers: {
        ...options.headers,
        Authorization: this.authHeader,
        'Content-Type': 'application/json',
      },
    });
    return response;
  }

  /**
   * Handle response errors
   */
  private async handleResponse(response: Response, context: string): Promise<void> {
    if (!response.ok) {
      let errorMessage = `HTTP ${response.status}`;
      try {
        const error = await response.json();
        if (error.error) {
          errorMessage = error.error;
        }
      } catch {
        // Response body not JSON or empty
      }
      throw new Error(`${context}: ${errorMessage}`);
    }
  }

  /**
   * Initialize the storage adapter
   * Tests connection by calling /health endpoint
   */
  async initialize(): Promise<void> {
    const url = this.buildUrl('/health');
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Health check failed: HTTP ${response.status}`);
      }
      const data = await response.json();
      if (data.status !== 'ok') {
        throw new Error(`Health check failed: unexpected status ${data.status}`);
      }
      console.debug('[RemoteStorage] Connection verified');
    } catch (error) {
      console.error('[RemoteStorage] Health check failed:', error);
      throw new Error(
        `Failed to connect to storage backend: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Save a record to storage
   * PUT /api/{table}/{id}
   */
  async save(
    table: string,
    id: string,
    encryptedData: string,
    metadata: RecordMetadata
  ): Promise<void> {
    const response = await this.fetchWithAuth(`/api/${table}/${id}`, {
      method: 'PUT',
      body: JSON.stringify({
        encryptedData,
        timestamp: metadata.timestamp,
        parentId: metadata.parentId,
        unencryptedData: metadata.unencryptedData,
      }),
    });
    await this.handleResponse(response, `Failed to save record ${id}`);
  }

  /**
   * Get a single record by ID
   * GET /api/{table}/{id}
   * Returns null if not found (404)
   */
  async get(
    table: string,
    id: string
  ): Promise<{ encryptedData: string; unencryptedData?: string } | null> {
    const response = await this.fetchWithAuth(`/api/${table}/${id}`, {
      method: 'GET',
    });

    if (response.status === 404) {
      return null;
    }

    await this.handleResponse(response, `Failed to get record ${id}`);

    const data = await response.json();
    return {
      encryptedData: data.encryptedData,
      unencryptedData: data.unencryptedData,
    };
  }

  /**
   * Query records with filters
   * GET /api/{table}?parentId=...&orderBy=...&orderDirection=...
   */
  async query(
    table: string,
    filters?: QueryFilters
  ): Promise<Array<{ encryptedData: string; unencryptedData?: string }>> {
    const params = new URLSearchParams();
    if (filters?.parentId) {
      params.set('parentId', filters.parentId);
    }
    if (filters?.orderBy) {
      params.set('orderBy', filters.orderBy);
    }
    if (filters?.orderDirection) {
      params.set('orderDirection', filters.orderDirection);
    }

    const queryString = params.toString();
    const path = queryString ? `/api/${table}?${queryString}` : `/api/${table}`;

    const response = await this.fetchWithAuth(path, {
      method: 'GET',
    });

    await this.handleResponse(response, `Failed to query ${table}`);

    const data = await response.json();
    return data.map((record: { encryptedData: string; unencryptedData?: string }) => ({
      encryptedData: record.encryptedData,
      unencryptedData: record.unencryptedData,
    }));
  }

  /**
   * Delete a record
   * DELETE /api/{table}/{id}
   */
  async delete(table: string, id: string): Promise<void> {
    const response = await this.fetchWithAuth(`/api/${table}/${id}`, {
      method: 'DELETE',
    });
    await this.handleResponse(response, `Failed to delete record ${id}`);
  }

  /**
   * Delete multiple records matching criteria
   * DELETE /api/{table}?parentId=...
   */
  async deleteMany(table: string, filters: QueryFilters): Promise<void> {
    if (!filters.parentId) {
      throw new Error('parentId is required for deleteMany');
    }

    const response = await this.fetchWithAuth(
      `/api/${table}?parentId=${encodeURIComponent(filters.parentId)}`,
      {
        method: 'DELETE',
      }
    );
    await this.handleResponse(response, `Failed to delete records in ${table}`);
  }

  /**
   * Count records matching criteria
   * GET /api/{table}/_count?parentId=...
   */
  async count(table: string, filters?: QueryFilters): Promise<number> {
    const params = new URLSearchParams();
    if (filters?.parentId) {
      params.set('parentId', filters.parentId);
    }

    const queryString = params.toString();
    const path = queryString ? `/api/${table}/_count?${queryString}` : `/api/${table}/_count`;

    const response = await this.fetchWithAuth(path, {
      method: 'GET',
    });

    await this.handleResponse(response, `Failed to count records in ${table}`);

    const data = await response.json();
    return data.count;
  }

  /**
   * Clear all data
   * POST /api/_clear-all
   */
  async clearAll(): Promise<void> {
    const response = await this.fetchWithAuth('/api/_clear-all', {
      method: 'POST',
    });
    await this.handleResponse(response, 'Failed to clear all data');
  }

  /**
   * Export records with cursor-based pagination
   * GET /api/{table}/_export?afterId=...&columns=...
   */
  async exportPaginated(
    table: string,
    afterId?: string,
    columns?: ColumnName[]
  ): Promise<ExportPage> {
    const params = new URLSearchParams();
    if (afterId) {
      params.set('afterId', afterId);
    }
    if (columns && columns.length > 0) {
      params.set('columns', columns.join(','));
    }

    const queryString = params.toString();
    const path = queryString ? `/api/${table}/_export?${queryString}` : `/api/${table}/_export`;

    const response = await this.fetchWithAuth(path, { method: 'GET' });
    await this.handleResponse(response, `Failed to export ${table}`);

    return response.json();
  }

  /**
   * Batch save multiple records
   * POST /api/{table}/_batch
   */
  async batchSave(
    table: string,
    rows: BatchSaveRow[],
    skipExisting: boolean
  ): Promise<BatchSaveResult> {
    const response = await this.fetchWithAuth(`/api/${table}/_batch`, {
      method: 'POST',
      body: JSON.stringify({ rows, skipExisting }),
    });
    await this.handleResponse(response, `Failed to batch save to ${table}`);

    return response.json();
  }

  /**
   * Batch get multiple records by IDs
   * GET /api/{table}/_batch?ids=...&columns=...
   *
   * Automatically chunks large ID arrays to keep URL under ~2000 chars.
   * Chunks are fetched in parallel and results merged.
   */
  async batchGet(table: string, ids: string[], columns?: ColumnName[]): Promise<BatchGetResult> {
    if (ids.length === 0) {
      return { rows: [] };
    }

    // Chunk IDs to keep URL length under ~2000 chars
    // Leave ~300 chars for base URL, path, and other query params
    const MAX_IDS_PARAM_LENGTH = 1700;
    const chunks: string[][] = [];
    let currentChunk: string[] = [];
    let currentLength = 0;

    for (const id of ids) {
      const idLength = id.length + 1; // +1 for comma separator
      if (currentLength + idLength > MAX_IDS_PARAM_LENGTH && currentChunk.length > 0) {
        chunks.push(currentChunk);
        currentChunk = [id];
        currentLength = id.length;
      } else {
        currentChunk.push(id);
        currentLength += idLength;
      }
    }
    if (currentChunk.length > 0) {
      chunks.push(currentChunk);
    }

    // Fetch all chunks in parallel
    const fetchChunk = async (chunkIds: string[]): Promise<BatchGetResult> => {
      const params = new URLSearchParams();
      params.set('ids', chunkIds.join(','));
      if (columns && columns.length > 0) {
        params.set('columns', columns.join(','));
      }

      const response = await this.fetchWithAuth(`/api/${table}/_batch?${params.toString()}`, {
        method: 'GET',
      });
      await this.handleResponse(response, `Failed to batch get from ${table}`);

      return response.json();
    };

    const results = await Promise.all(chunks.map(fetchChunk));

    // Merge all results
    return {
      rows: results.flatMap(r => r.rows),
    };
  }
}

/**
 * Valid table names for type safety
 */
export const VALID_TABLES = Object.values(Tables);
