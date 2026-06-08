/**
 * SQLite storage adapter for the Node server deployment.
 *
 * Uses `better-sqlite3` (synchronous API — no async overhead for
 * single-tenant). The whole database belongs to one CEK; no `userId`
 * column. Schema mirrors the IndexedDB object stores.
 */

import Database from 'better-sqlite3';
import type {
  BatchGetResult,
  BatchSaveResult,
  BatchSaveRow,
  ColumnName,
  ExportPage,
  ExportRow,
  PartialExportRow,
  QueryFilters,
  RecordMetadata,
  StorageAdapter,
} from '../../shared/services/storage/StorageAdapter';
import { Tables } from '../../shared/services/storage/StorageAdapter';

const SCHEMA_VERSION = 1;
const EXPORT_ROW_LIMIT = 200;
const EXPORT_SIZE_LIMIT = 20_000_000;

const ALL_TABLES = [
  Tables.API_DEFINITIONS,
  Tables.MODELS_CACHE,
  Tables.PROJECTS,
  Tables.CHATS,
  Tables.MINION_CHATS,
  Tables.MESSAGES,
  Tables.ATTACHMENTS,
  Tables.METADATA,
  Tables.VFS_META,
  Tables.VFS_FILES,
  Tables.VFS_VERSIONS,
] as const;

function filterColumns(row: ExportRow, columns?: ColumnName[]): PartialExportRow {
  if (!columns || columns.length === 0) return row;
  const result: PartialExportRow = {};
  for (const col of columns) {
    if (col in row) {
      result[col] = row[col];
    }
  }
  return result;
}

export class SqliteStorageAdapter implements StorageAdapter {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = OFF');
  }

  async initialize(): Promise<void> {
    const version = this.db.pragma('user_version', { simple: true }) as number;
    if (version >= SCHEMA_VERSION) return;

    this.db.transaction(() => {
      for (const table of ALL_TABLES) {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS "${table}" (
            id TEXT PRIMARY KEY,
            encryptedData TEXT NOT NULL,
            timestamp TEXT,
            parentId TEXT,
            unencryptedData TEXT
          )
        `);
        this.db.exec(`CREATE INDEX IF NOT EXISTS "idx_${table}_parentId" ON "${table}" (parentId)`);
        this.db.exec(
          `CREATE INDEX IF NOT EXISTS "idx_${table}_timestamp" ON "${table}" (timestamp)`
        );
        this.db.exec(
          `CREATE INDEX IF NOT EXISTS "idx_${table}_parentId_timestamp" ON "${table}" (parentId, timestamp)`
        );
      }
      this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
    })();
  }

  async save(
    table: string,
    id: string,
    encryptedData: string,
    metadata: RecordMetadata
  ): Promise<void> {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO "${table}" (id, encryptedData, timestamp, parentId, unencryptedData) VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        id,
        encryptedData,
        metadata.timestamp ?? null,
        metadata.parentId ?? null,
        metadata.unencryptedData ?? null
      );
  }

  async get(
    table: string,
    id: string
  ): Promise<{ encryptedData: string; timestamp?: string; unencryptedData?: string } | null> {
    const row = this.db
      .prepare(`SELECT encryptedData, timestamp, unencryptedData FROM "${table}" WHERE id = ?`)
      .get(id) as
      | { encryptedData: string; timestamp: string | null; unencryptedData: string | null }
      | undefined;
    if (!row) return null;
    return {
      encryptedData: row.encryptedData,
      timestamp: row.timestamp ?? undefined,
      unencryptedData: row.unencryptedData ?? undefined,
    };
  }

  async query(
    table: string,
    filters?: QueryFilters
  ): Promise<Array<{ encryptedData: string; unencryptedData?: string }>> {
    let sql = `SELECT encryptedData, unencryptedData FROM "${table}"`;
    const params: unknown[] = [];

    if (filters?.parentId) {
      sql += ' WHERE parentId = ?';
      params.push(filters.parentId);
    }

    const orderCol = filters?.orderBy === 'createdAt' ? 'timestamp' : (filters?.orderBy ?? 'id');
    const dir = filters?.orderDirection === 'asc' ? 'ASC' : 'DESC';
    sql += ` ORDER BY "${orderCol}" ${dir}`;

    const rows = this.db.prepare(sql).all(...params) as Array<{
      encryptedData: string;
      unencryptedData: string | null;
    }>;
    return rows.map(r => ({
      encryptedData: r.encryptedData,
      unencryptedData: r.unencryptedData ?? undefined,
    }));
  }

  async delete(table: string, id: string): Promise<void> {
    this.db.prepare(`DELETE FROM "${table}" WHERE id = ?`).run(id);
  }

  async deleteMany(table: string, filters: QueryFilters): Promise<void> {
    if (filters.parentId) {
      this.db.prepare(`DELETE FROM "${table}" WHERE parentId = ?`).run(filters.parentId);
    } else {
      this.db.prepare(`DELETE FROM "${table}"`).run();
    }
  }

  async count(table: string, filters?: QueryFilters): Promise<number> {
    let sql = `SELECT COUNT(*) as cnt FROM "${table}"`;
    const params: unknown[] = [];
    if (filters?.parentId) {
      sql += ' WHERE parentId = ?';
      params.push(filters.parentId);
    }
    const row = this.db.prepare(sql).get(...params) as { cnt: number };
    return row.cnt;
  }

  async clearAll(): Promise<void> {
    this.db.transaction(() => {
      for (const table of ALL_TABLES) {
        this.db.exec(`DELETE FROM "${table}"`);
      }
    })();
  }

  async exportPaginated(
    table: string,
    afterId?: string,
    columns?: ColumnName[]
  ): Promise<ExportPage> {
    let sql = `SELECT id, encryptedData, timestamp, parentId, unencryptedData FROM "${table}"`;
    const params: unknown[] = [];
    if (afterId) {
      sql += ' WHERE id > ?';
      params.push(afterId);
    }
    sql += ' ORDER BY id ASC';
    // Fetch one extra to detect hasMore
    sql += ` LIMIT ${EXPORT_ROW_LIMIT + 1}`;

    const rawRows = this.db.prepare(sql).all(...params) as Array<{
      id: string;
      encryptedData: string;
      timestamp: string | null;
      parentId: string | null;
      unencryptedData: string | null;
    }>;

    const rows: PartialExportRow[] = [];
    let totalSize = 0;

    for (const raw of rawRows) {
      if (rows.length >= EXPORT_ROW_LIMIT) {
        return { rows: rows as ExportRow[], hasMore: true };
      }

      const rowSize =
        raw.id.length +
        raw.encryptedData.length +
        (raw.unencryptedData?.length ?? 0) +
        (raw.timestamp?.length ?? 0) +
        (raw.parentId?.length ?? 0);

      if (rows.length > 0 && totalSize + rowSize > EXPORT_SIZE_LIMIT) {
        return { rows: rows as ExportRow[], hasMore: true };
      }

      totalSize += rowSize;

      const fullRow: ExportRow = {
        id: raw.id,
        encryptedData: raw.encryptedData,
        timestamp: raw.timestamp ?? undefined,
        parentId: raw.parentId ?? undefined,
        unencryptedData: raw.unencryptedData ?? undefined,
      };
      rows.push(filterColumns(fullRow, columns));
    }

    return { rows: rows as ExportRow[], hasMore: false };
  }

  async batchSave(
    table: string,
    rows: BatchSaveRow[],
    skipExisting: boolean
  ): Promise<BatchSaveResult> {
    if (rows.length === 0) return { saved: 0, skipped: 0 };

    let saved = 0;
    let skipped = 0;

    this.db.transaction(() => {
      const upsert = this.db.prepare(
        `INSERT OR REPLACE INTO "${table}" (id, encryptedData, timestamp, parentId, unencryptedData) VALUES (?, ?, ?, ?, ?)`
      );
      const insertOnly = this.db.prepare(
        `INSERT OR IGNORE INTO "${table}" (id, encryptedData, timestamp, parentId, unencryptedData) VALUES (?, ?, ?, ?, ?)`
      );

      for (const row of rows) {
        if (skipExisting) {
          const result = insertOnly.run(
            row.id,
            row.encryptedData,
            row.timestamp ?? null,
            row.parentId ?? null,
            row.unencryptedData ?? null
          );
          if (result.changes > 0) saved++;
          else skipped++;
        } else {
          upsert.run(
            row.id,
            row.encryptedData,
            row.timestamp ?? null,
            row.parentId ?? null,
            row.unencryptedData ?? null
          );
          saved++;
        }
      }
    })();

    return { saved, skipped };
  }

  async batchGet(table: string, ids: string[], columns?: ColumnName[]): Promise<BatchGetResult> {
    if (ids.length === 0) return { rows: [] };

    // SQLite has a limit on placeholders; chunk if needed
    const chunkSize = 500;
    const allRows: PartialExportRow[] = [];

    for (let i = 0; i < ids.length; i += chunkSize) {
      const chunk = ids.slice(i, i + chunkSize);
      const placeholders = chunk.map(() => '?').join(',');
      const rawRows = this.db
        .prepare(
          `SELECT id, encryptedData, timestamp, parentId, unencryptedData FROM "${table}" WHERE id IN (${placeholders})`
        )
        .all(...chunk) as Array<{
        id: string;
        encryptedData: string;
        timestamp: string | null;
        parentId: string | null;
        unencryptedData: string | null;
      }>;

      for (const raw of rawRows) {
        const fullRow: ExportRow = {
          id: raw.id,
          encryptedData: raw.encryptedData,
          timestamp: raw.timestamp ?? undefined,
          parentId: raw.parentId ?? undefined,
          unencryptedData: raw.unencryptedData ?? undefined,
        };
        allRows.push(filterColumns(fullRow, columns));
      }
    }

    return { rows: allRows };
  }

  async getStorageQuota(): Promise<{ usage: number; quota: number } | null> {
    // SQLite doesn't have a meaningful quota concept; return file size as usage
    try {
      const pageCount = this.db.pragma('page_count', { simple: true }) as number;
      const pageSize = this.db.pragma('page_size', { simple: true }) as number;
      return { usage: pageCount * pageSize, quota: Infinity };
    } catch {
      return null;
    }
  }

  close(): void {
    this.db.close();
  }
}
