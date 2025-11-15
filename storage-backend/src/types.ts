/**
 * Types for the SQLite storage backend
 * Mirrors the frontend StorageAdapter interface for easy integration
 */

/**
 * Valid column names for selective fetching
 */
export const VALID_COLUMNS = [
  'id',
  'encryptedData',
  'timestamp',
  'parentId',
  'unencryptedData',
] as const;

export type ColumnName = (typeof VALID_COLUMNS)[number];

/**
 * Check if a string is a valid column name
 */
export function isValidColumn(column: string): column is ColumnName {
  return VALID_COLUMNS.includes(column as ColumnName);
}

/**
 * Query filters matching StorageAdapter.QueryFilters
 */
export interface QueryFilters {
  parentId?: string;
  orderBy?: 'timestamp' | 'createdAt';
  orderDirection?: 'asc' | 'desc';
}

/**
 * Save request body (flat structure matching storage layer)
 */
export interface SaveRequest {
  encryptedData: string;
  timestamp?: string;
  parentId?: string;
  unencryptedData?: string;
}

/**
 * Record as stored in SQLite
 */
export interface StoredRecord {
  userId: string;
  tableName: string;
  id: string;
  encryptedData: string;
  timestamp: string | null;
  parentId: string | null;
  unencryptedData: string | null;
}

/**
 * Response format for get/query operations
 */
export interface RecordResponse {
  encryptedData: string;
  unencryptedData?: string;
}

/**
 * Row format for export operations (includes all indexed columns)
 */
export interface ExportRow {
  id: string;
  encryptedData: string;
  unencryptedData?: string;
  timestamp?: string;
  parentId?: string;
}

/**
 * Response format for paginated export
 */
export interface ExportResponse {
  rows: ExportRow[];
  hasMore: boolean;
}

/**
 * Single row in batch save request (flat structure matching storage layer)
 */
export interface BatchSaveRow {
  id: string;
  encryptedData: string;
  timestamp?: string;
  parentId?: string;
  unencryptedData?: string;
}

/**
 * Request body for batch save
 */
export interface BatchSaveRequest {
  rows: BatchSaveRow[];
  skipExisting?: boolean;
}

/**
 * Response format for batch save
 */
export interface BatchSaveResponse {
  saved: number;
  skipped: number;
}

/**
 * Response format for batch get
 */
export interface BatchGetResponse {
  rows: Partial<ExportRow>[];
}

/**
 * Valid table names (matching frontend Tables constant)
 */
export const VALID_TABLES = [
  'api_definitions',
  'models_cache',
  'projects',
  'chats',
  'messages',
  'attachments',
  'memories',
  'memory_journals',
  'app_metadata',
] as const;

export type TableName = (typeof VALID_TABLES)[number];

/**
 * Check if a string is a valid table name
 */
export function isValidTable(table: string): table is TableName {
  return VALID_TABLES.includes(table as TableName);
}
