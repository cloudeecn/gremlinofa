/**
 * Generic storage adapter interface
 * All platform-specific implementations must implement this interface
 */

export interface QueryFilters {
  parentId?: string;
  orderBy?: 'timestamp' | 'createdAt';
  orderDirection?: 'asc' | 'desc';
}

/**
 * Valid column names for selective fetching
 */
export type ColumnName = 'id' | 'encryptedData' | 'timestamp' | 'parentId' | 'unencryptedData';

/**
 * Single row in an export page
 */
export interface ExportRow {
  id: string;
  encryptedData: string;
  timestamp?: string;
  parentId?: string;
  unencryptedData?: string;
}

/**
 * Partial row when specific columns are requested
 */
export type PartialExportRow = Partial<ExportRow>;

/**
 * Result of batch get operation
 */
export interface BatchGetResult {
  rows: PartialExportRow[];
}

/**
 * Paginated export result
 */
export interface ExportPage {
  rows: ExportRow[];
  hasMore: boolean;
}

/**
 * Row for batch save operation
 */
export interface BatchSaveRow {
  id: string;
  encryptedData: string;
  timestamp?: string;
  parentId?: string;
  unencryptedData?: string;
}

/**
 * Result of batch save operation
 */
export interface BatchSaveResult {
  saved: number;
  skipped: number;
}

/**
 * StorageAdapter - Platform-agnostic storage interface
 *
 * Implementations:
 * - IndexedDBAdapter (web, Android)
 * - CoreDataAdapter (iOS native with iCloud sync)
 * - SqliteAdapter (Expo Go fallback)
 */
export interface StorageAdapter {
  /**
   * Initialize the storage adapter
   */
  initialize(): Promise<void>;

  /**
   * Save a record to storage
   * @param table - Table name (e.g., "projects", "chats", "messages")
   * @param id - Unique record ID
   * @param encryptedData - Encrypted JSON string
   * @param metadata - Plaintext metadata for indexing/sorting
   */
  save(table: string, id: string, encryptedData: string, metadata: RecordMetadata): Promise<void>;

  /**
   * Get a single record by ID
   * @param table - Table name
   * @param id - Record ID
   * @returns Object with encryptedData, timestamp, and unencryptedData, or null if not found
   */
  get(
    table: string,
    id: string
  ): Promise<{ encryptedData: string; timestamp?: string; unencryptedData?: string } | null>;

  /**
   * Query records with filters
   * @param table - Table name
   * @param filters - Query filters (parentId, ordering, pagination)
   * @returns Array of objects with encryptedData and unencryptedData
   */
  query(
    table: string,
    filters?: QueryFilters
  ): Promise<Array<{ encryptedData: string; unencryptedData?: string }>>;

  /**
   * Delete a record
   * @param table - Table name
   * @param id - Record ID
   */
  delete(table: string, id: string): Promise<void>;

  /**
   * Delete multiple records matching criteria
   * @param table - Table name
   * @param filters - Query filters to match records
   */
  deleteMany(table: string, filters: QueryFilters): Promise<void>;

  /**
   * Count records matching criteria
   * @param table - Table name
   * @param filters - Query filters
   */
  count(table: string, filters?: QueryFilters): Promise<number>;

  /**
   * Clear all data (for testing/reset)
   * Deletes all records from all tables
   */
  clearAll(): Promise<void>;

  /**
   * Export records with cursor-based pagination
   * Returns records with ALL metadata (id, timestamp, parentId, unencryptedData) by default,
   * or only the specified columns if provided.
   * @param table - Table name
   * @param afterId - Cursor for pagination (fetch records with id > afterId)
   * @param columns - Optional columns to include (omit for all columns)
   * @returns Page of records with hasMore flag
   */
  exportPaginated(table: string, afterId?: string, columns?: ColumnName[]): Promise<ExportPage>;

  /**
   * Batch save multiple records in a single operation
   * @param table - Table name
   * @param rows - Array of records to save
   * @param skipExisting - If true, skip existing records; if false, overwrite
   * @returns Count of saved and skipped records
   */
  batchSave(table: string, rows: BatchSaveRow[], skipExisting: boolean): Promise<BatchSaveResult>;

  /**
   * Batch get multiple records by IDs in a single operation
   * @param table - Table name
   * @param ids - Array of record IDs to fetch
   * @param columns - Optional columns to include (omit for all columns)
   * @returns Array of found records (missing IDs silently omitted)
   */
  batchGet(table: string, ids: string[], columns?: ColumnName[]): Promise<BatchGetResult>;
}

/**
 * Metadata stored alongside encrypted data for indexing/querying
 * This data is NOT encrypted and is used for efficient queries
 */
export interface RecordMetadata {
  timestamp?: string; // ISO string
  parentId?: string; // For relationships (projectId, chatId, etc.)
  unencryptedData?: string; // JSON string for app-level metadata (versions, flags, etc.)
  [key: string]: string | undefined; // Allow additional metadata
}

/**
 * Table names
 */
export const Tables = {
  API_DEFINITIONS: 'api_definitions',
  MODELS_CACHE: 'models_cache',
  PROJECTS: 'projects',
  CHATS: 'chats',
  MESSAGES: 'messages',
  ATTACHMENTS: 'attachments',
  MEMORIES: 'memories',
  MEMORY_JOURNALS: 'memory_journals',
  METADATA: 'app_metadata',
  VFS_META: 'vfs_meta',
  VFS_FILES: 'vfs_files',
  VFS_VERSIONS: 'vfs_versions',
} as const;

export type TableName = (typeof Tables)[keyof typeof Tables];
