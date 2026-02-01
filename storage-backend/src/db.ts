/**
 * SQLite database setup with better-sqlite3
 * Schema designed for multi-tenant storage with efficient indexing
 */

import Database from 'better-sqlite3';
import { config } from './config.js';
import type {
  StoredRecord,
  QueryFilters,
  RecordResponse,
  ExportRow,
  ExportResponse,
  BatchSaveRow,
  BatchSaveResponse,
  ColumnName,
  BatchGetResponse,
} from './types.js';

let db: Database.Database;

/**
 * Initialize the database with schema and indexes
 */
export function initDatabase(): void {
  db = new Database(config.dbPath);

  // Enable WAL mode for better concurrent performance
  db.pragma('journal_mode = WAL');

  // Create the records table
  db.exec(`
    CREATE TABLE IF NOT EXISTS records (
      userId TEXT NOT NULL,
      tableName TEXT NOT NULL,
      id TEXT NOT NULL,
      encryptedData TEXT NOT NULL,
      timestamp TEXT,
      parentId TEXT,
      unencryptedData TEXT,
      PRIMARY KEY (userId, tableName, id)
    )
  `);

  // Create indexes for efficient queries (no full table scans)
  // Index for basic table listing per user
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_user_table 
    ON records(userId, tableName)
  `);

  // Index for parentId queries (e.g., get messages by chatId)
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_user_table_parent 
    ON records(userId, tableName, parentId)
  `);

  // Index for parentId + timestamp queries (sorted by time)
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_user_table_parent_ts 
    ON records(userId, tableName, parentId, timestamp)
  `);

  // Index for timestamp-only queries (e.g., "all messages sorted by time")
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_user_table_ts 
    ON records(userId, tableName, timestamp)
  `);

  console.debug('Database initialized:', config.dbPath);
}

/**
 * Get the database instance (for testing)
 */
export function getDatabase(): Database.Database {
  return db;
}

/**
 * Close the database connection
 */
export function closeDatabase(): void {
  if (db) {
    db.close();
  }
}

// Prepared statements (lazily initialized)
let stmtSave: Database.Statement | null = null;
let stmtGet: Database.Statement | null = null;
let stmtDelete: Database.Statement | null = null;

function getSaveStmt(): Database.Statement {
  if (!stmtSave) {
    stmtSave = db.prepare(`
      INSERT OR REPLACE INTO records (userId, tableName, id, encryptedData, timestamp, parentId, unencryptedData)
      VALUES (@userId, @tableName, @id, @encryptedData, @timestamp, @parentId, @unencryptedData)
    `);
  }
  return stmtSave;
}

function getGetStmt(): Database.Statement {
  if (!stmtGet) {
    stmtGet = db.prepare(`
      SELECT encryptedData, timestamp, unencryptedData 
      FROM records 
      WHERE userId = ? AND tableName = ? AND id = ?
    `);
  }
  return stmtGet;
}

function getDeleteStmt(): Database.Statement {
  if (!stmtDelete) {
    stmtDelete = db.prepare(`
      DELETE FROM records 
      WHERE userId = ? AND tableName = ? AND id = ?
    `);
  }
  return stmtDelete;
}

/**
 * Save a record (upsert)
 */
export function saveRecord(
  userId: string,
  tableName: string,
  id: string,
  encryptedData: string,
  timestamp: string | null,
  parentId: string | null,
  unencryptedData: string | null
): void {
  getSaveStmt().run({
    userId,
    tableName,
    id,
    encryptedData,
    timestamp,
    parentId,
    unencryptedData,
  });
}

/**
 * Get a record by ID
 */
export function getRecord(userId: string, tableName: string, id: string): RecordResponse | null {
  const row = getGetStmt().get(userId, tableName, id) as
    | Pick<StoredRecord, 'encryptedData' | 'timestamp' | 'unencryptedData'>
    | undefined;

  if (!row) return null;

  const result: RecordResponse = { encryptedData: row.encryptedData };
  if (row.timestamp) {
    result.timestamp = row.timestamp;
  }
  if (row.unencryptedData) {
    result.unencryptedData = row.unencryptedData;
  }
  return result;
}

/**
 * Query records with filters
 */
export function queryRecords(
  userId: string,
  tableName: string,
  filters?: QueryFilters
): RecordResponse[] {
  // Build query dynamically based on filters
  let sql = 'SELECT encryptedData, unencryptedData FROM records WHERE userId = ? AND tableName = ?';
  const params: (string | null)[] = [userId, tableName];

  if (filters?.parentId) {
    sql += ' AND parentId = ?';
    params.push(filters.parentId);
  }

  // Order by
  const orderCol = filters?.orderBy === 'createdAt' ? 'timestamp' : 'timestamp';
  const orderDir = filters?.orderDirection === 'asc' ? 'ASC' : 'DESC';
  sql += ` ORDER BY ${orderCol} ${orderDir}`;

  const rows = db.prepare(sql).all(...params) as Pick<
    StoredRecord,
    'encryptedData' | 'unencryptedData'
  >[];

  return rows.map(row => {
    const result: RecordResponse = { encryptedData: row.encryptedData };
    if (row.unencryptedData) {
      result.unencryptedData = row.unencryptedData;
    }
    return result;
  });
}

/**
 * Delete a record by ID
 */
export function deleteRecord(userId: string, tableName: string, id: string): void {
  getDeleteStmt().run(userId, tableName, id);
}

/**
 * Delete multiple records matching filters
 */
export function deleteMany(userId: string, tableName: string, filters: QueryFilters): void {
  let sql = 'DELETE FROM records WHERE userId = ? AND tableName = ?';
  const params: (string | null)[] = [userId, tableName];

  if (filters.parentId) {
    sql += ' AND parentId = ?';
    params.push(filters.parentId);
  }

  db.prepare(sql).run(...params);
}

/**
 * Count records matching filters
 */
export function countRecords(userId: string, tableName: string, filters?: QueryFilters): number {
  let sql = 'SELECT COUNT(*) as count FROM records WHERE userId = ? AND tableName = ?';
  const params: (string | null)[] = [userId, tableName];

  if (filters?.parentId) {
    sql += ' AND parentId = ?';
    params.push(filters.parentId);
  }

  const row = db.prepare(sql).get(...params) as { count: number };
  return row.count;
}

/**
 * Clear all records for a user
 */
export function clearAllForUser(userId: string): void {
  db.prepare('DELETE FROM records WHERE userId = ?').run(userId);
}

/** Size limit for export response (20MB in characters) */
const EXPORT_SIZE_LIMIT = 20_000_000;
/** Max rows per export page */
const EXPORT_ROW_LIMIT = 200;

/**
 * Build SELECT clause with specific columns or all columns
 */
function buildSelectClause(columns?: ColumnName[]): string {
  if (!columns || columns.length === 0) {
    return 'id, encryptedData, unencryptedData, timestamp, parentId';
  }
  return columns.join(', ');
}

/**
 * Build row object from raw database row, respecting column filter
 */
function buildExportRow(
  raw: {
    id?: string;
    encryptedData?: string;
    unencryptedData?: string | null;
    timestamp?: string | null;
    parentId?: string | null;
  },
  columns?: ColumnName[]
): Partial<ExportRow> {
  // If no columns specified, return all columns
  if (!columns || columns.length === 0) {
    const row: ExportRow = {
      id: raw.id!,
      encryptedData: raw.encryptedData!,
    };
    if (raw.unencryptedData) row.unencryptedData = raw.unencryptedData;
    if (raw.timestamp) row.timestamp = raw.timestamp;
    if (raw.parentId) row.parentId = raw.parentId;
    return row;
  }

  // Build row with only requested columns
  const row: Partial<ExportRow> = {};
  for (const col of columns) {
    const value = raw[col];
    if (value !== null && value !== undefined) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (row as any)[col] = value;
    }
  }
  return row;
}

/**
 * Calculate row size for size limiting
 */
function calculateRowSize(raw: {
  id?: string;
  encryptedData?: string;
  unencryptedData?: string | null;
  timestamp?: string | null;
  parentId?: string | null;
}): number {
  return (
    (raw.id?.length ?? 0) +
    (raw.encryptedData?.length ?? 0) +
    (raw.unencryptedData?.length ?? 0) +
    (raw.timestamp?.length ?? 0) +
    (raw.parentId?.length ?? 0)
  );
}

/**
 * Query all records with cursor-based pagination for export.
 * Returns up to 200 rows or until total size exceeds 20M characters.
 * @param columns Optional list of columns to include (all if omitted)
 */
export function queryAllPaginated(
  userId: string,
  tableName: string,
  afterId?: string,
  columns?: ColumnName[]
): ExportResponse {
  // Fetch one extra row to detect hasMore
  const limit = EXPORT_ROW_LIMIT + 1;

  const selectClause = buildSelectClause(columns);
  let sql = `
    SELECT ${selectClause}
    FROM records 
    WHERE userId = ? AND tableName = ?
  `;
  const params: string[] = [userId, tableName];

  if (afterId) {
    sql += ' AND id > ?';
    params.push(afterId);
  }

  sql += ' ORDER BY id ASC LIMIT ?';
  params.push(String(limit));

  const rawRows = db.prepare(sql).all(...params) as Array<{
    id?: string;
    encryptedData?: string;
    unencryptedData?: string | null;
    timestamp?: string | null;
    parentId?: string | null;
  }>;

  const rows: Partial<ExportRow>[] = [];
  let totalSize = 0;
  let truncatedBySize = false;

  for (const raw of rawRows) {
    // Stop if we already have enough rows
    if (rows.length >= EXPORT_ROW_LIMIT) break;

    // Calculate row size
    const rowSize = calculateRowSize(raw);

    // Check size limit (allow at least one row)
    if (rows.length > 0 && totalSize + rowSize > EXPORT_SIZE_LIMIT) {
      truncatedBySize = true;
      break;
    }

    totalSize += rowSize;
    rows.push(buildExportRow(raw, columns));
  }

  // hasMore is true if we truncated by size OR there were more rows than we returned
  const hasMore = truncatedBySize || rawRows.length > rows.length;

  return { rows: rows as ExportRow[], hasMore };
}

/**
 * Batch get records by IDs.
 * Returns records for all found IDs (missing IDs are silently omitted).
 * @param columns Optional list of columns to include (all if omitted)
 */
export function batchGet(
  userId: string,
  tableName: string,
  ids: string[],
  columns?: ColumnName[]
): BatchGetResponse {
  if (ids.length === 0) {
    return { rows: [] };
  }

  const selectClause = buildSelectClause(columns);

  // Use IN clause with placeholders for efficiency
  const placeholders = ids.map(() => '?').join(', ');
  const sql = `
    SELECT ${selectClause}
    FROM records 
    WHERE userId = ? AND tableName = ? AND id IN (${placeholders})
  `;

  const params: string[] = [userId, tableName, ...ids];
  const rawRows = db.prepare(sql).all(...params) as Array<{
    id?: string;
    encryptedData?: string;
    unencryptedData?: string | null;
    timestamp?: string | null;
    parentId?: string | null;
  }>;

  const rows = rawRows.map(raw => buildExportRow(raw, columns));
  return { rows };
}

/**
 * Batch save multiple records in a single transaction.
 * @param skipExisting If true, skip rows that already exist (INSERT OR IGNORE)
 */
export function batchSave(
  userId: string,
  tableName: string,
  rows: BatchSaveRow[],
  skipExisting: boolean
): BatchSaveResponse {
  if (rows.length === 0) {
    return { saved: 0, skipped: 0 };
  }

  // Use different SQL based on skipExisting
  const sql = skipExisting
    ? `INSERT OR IGNORE INTO records (userId, tableName, id, encryptedData, timestamp, parentId, unencryptedData)
       VALUES (@userId, @tableName, @id, @encryptedData, @timestamp, @parentId, @unencryptedData)`
    : `INSERT OR REPLACE INTO records (userId, tableName, id, encryptedData, timestamp, parentId, unencryptedData)
       VALUES (@userId, @tableName, @id, @encryptedData, @timestamp, @parentId, @unencryptedData)`;

  const stmt = db.prepare(sql);

  let saved = 0;
  let skipped = 0;

  const runBatch = db.transaction(() => {
    for (const row of rows) {
      const result = stmt.run({
        userId,
        tableName,
        id: row.id,
        encryptedData: row.encryptedData,
        timestamp: row.timestamp ?? null,
        parentId: row.parentId ?? null,
        unencryptedData: row.unencryptedData ?? null,
      });

      if (result.changes > 0) {
        saved++;
      } else {
        skipped++;
      }
    }
  });

  runBatch();

  return { saved, skipped };
}
