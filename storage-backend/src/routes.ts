/**
 * HTTP API routes matching StorageAdapter interface
 */

import { Router, json } from 'express';
import type { Request, Response, NextFunction } from 'express';
import {
  saveRecord,
  getRecord,
  queryRecords,
  deleteRecord,
  deleteMany,
  countRecords,
  clearAllForUser,
  queryAllPaginated,
  batchSave,
  batchGet,
} from './db.js';
import {
  isValidTable,
  isValidColumn,
  type SaveRequest,
  type QueryFilters,
  type BatchSaveRequest,
  type ColumnName,
} from './types.js';

// Import to get the userId type extension
import './middleware.js';

export const router = Router();

// Parse JSON bodies
router.use(json({ limit: '50mb' }));

/**
 * Validate table name middleware
 */
function validateTable(req: Request, res: Response, next: NextFunction): void {
  const { table } = req.params;
  if (!isValidTable(table)) {
    res.status(400).json({ error: `Invalid table: ${table}` });
    return;
  }
  next();
}

/** Max IDs per batch get request */
const BATCH_GET_ID_LIMIT = 200;

/**
 * Parse and validate columns query parameter
 * Returns undefined if not provided or empty, validated ColumnName[] otherwise
 */
function parseColumns(req: Request, res: Response): ColumnName[] | undefined | null {
  const columnsParam = req.query.columns;
  if (!columnsParam || typeof columnsParam !== 'string' || columnsParam.trim() === '') {
    return undefined;
  }

  const columnNames = columnsParam.split(',').map(c => c.trim());
  const validColumns: ColumnName[] = [];

  for (const col of columnNames) {
    if (!isValidColumn(col)) {
      res.status(400).json({ error: `Invalid column: ${col}` });
      return null; // Signal that response has been sent
    }
    validColumns.push(col);
  }

  return validColumns;
}

/**
 * GET /api/:table/_export - Export records with cursor-based pagination
 * Returns records sorted by id, with size/count limits.
 * Query params: afterId (cursor for pagination), columns (comma-separated)
 */
router.get('/:table/_export', validateTable, (req: Request, res: Response) => {
  try {
    const { table } = req.params;
    const userId = req.userId!;
    const afterId = typeof req.query.afterId === 'string' ? req.query.afterId : undefined;

    const columns = parseColumns(req, res);
    if (columns === null) return; // Response already sent (invalid column)

    const result = queryAllPaginated(userId, table, afterId, columns);
    res.json(result);
  } catch (err) {
    console.error('Export error:', err);
    res.status(500).json({ error: 'Failed to export records' });
  }
});

/**
 * GET /api/:table/_batch - Batch get records by IDs
 * Query params: ids (comma-separated, required), columns (comma-separated, optional)
 */
router.get('/:table/_batch', validateTable, (req: Request, res: Response) => {
  try {
    const { table } = req.params;
    const userId = req.userId!;

    // Parse and validate ids
    const idsParam = req.query.ids;
    if (!idsParam || typeof idsParam !== 'string' || idsParam.trim() === '') {
      res.status(400).json({ error: 'ids query parameter is required' });
      return;
    }

    const ids = idsParam
      .split(',')
      .map(id => id.trim())
      .filter(id => id.length > 0);
    if (ids.length === 0) {
      res.status(400).json({ error: 'ids query parameter is required' });
      return;
    }

    if (ids.length > BATCH_GET_ID_LIMIT) {
      res.status(400).json({ error: `Maximum ${BATCH_GET_ID_LIMIT} IDs per request` });
      return;
    }

    const columns = parseColumns(req, res);
    if (columns === null) return; // Response already sent (invalid column)

    const result = batchGet(userId, table, ids, columns);
    res.json(result);
  } catch (err) {
    console.error('Batch get error:', err);
    res.status(500).json({ error: 'Failed to batch get records' });
  }
});

/**
 * POST /api/:table/_batch - Batch save multiple records
 * Body: { rows: [{id, encryptedData, metadata?}], skipExisting?: boolean }
 */
router.post('/:table/_batch', validateTable, (req: Request, res: Response) => {
  try {
    const { table } = req.params;
    const userId = req.userId!;
    const body = req.body as BatchSaveRequest;

    if (!Array.isArray(body.rows)) {
      res.status(400).json({ error: 'rows array is required' });
      return;
    }

    // Validate each row has required fields
    for (let i = 0; i < body.rows.length; i++) {
      const row = body.rows[i];
      if (!row.id || !row.encryptedData) {
        res.status(400).json({ error: `Row ${i} missing required id or encryptedData` });
        return;
      }
    }

    const result = batchSave(userId, table, body.rows, body.skipExisting ?? false);
    res.json(result);
  } catch (err) {
    console.error('Batch save error:', err);
    res.status(500).json({ error: 'Failed to batch save records' });
  }
});

/**
 * PUT /api/:table/:id - Save a record (upsert)
 * Maps to StorageAdapter.save()
 */
router.put('/:table/:id', validateTable, (req: Request, res: Response) => {
  try {
    const { table, id } = req.params;
    const body = req.body as SaveRequest;
    const userId = req.userId!;

    if (!body.encryptedData) {
      res.status(400).json({ error: 'encryptedData is required' });
      return;
    }

    saveRecord(
      userId,
      table,
      id,
      body.encryptedData,
      body.timestamp ?? null,
      body.parentId ?? null,
      body.unencryptedData ?? null
    );

    res.status(204).end();
  } catch (err) {
    console.error('Save error:', err);
    res.status(500).json({ error: 'Failed to save record' });
  }
});

/**
 * GET /api/:table/:id - Get a record by ID
 * Maps to StorageAdapter.get()
 */
router.get('/:table/:id', validateTable, (req: Request, res: Response) => {
  try {
    const { table, id } = req.params;
    const userId = req.userId!;

    // Special case: /_count is the count endpoint
    if (id === '_count') {
      const filters = parseQueryFilters(req);
      const count = countRecords(userId, table, filters);
      res.json({ count });
      return;
    }

    const record = getRecord(userId, table, id);

    if (!record) {
      res.status(404).json({ error: 'Record not found' });
      return;
    }

    res.json(record);
  } catch (err) {
    console.error('Get error:', err);
    res.status(500).json({ error: 'Failed to get record' });
  }
});

/**
 * GET /api/:table - Query records
 * Maps to StorageAdapter.query()
 * Query params: parentId, orderBy, orderDirection
 */
router.get('/:table', validateTable, (req: Request, res: Response) => {
  try {
    const { table } = req.params;
    const userId = req.userId!;
    const filters = parseQueryFilters(req);
    const records = queryRecords(userId, table, filters);
    res.json(records);
  } catch (err) {
    console.error('Query error:', err);
    res.status(500).json({ error: 'Failed to query records' });
  }
});

/**
 * DELETE /api/:table/:id - Delete a record by ID
 * Maps to StorageAdapter.delete()
 */
router.delete('/:table/:id', validateTable, (req: Request, res: Response) => {
  try {
    const { table, id } = req.params;
    const userId = req.userId!;
    deleteRecord(userId, table, id);
    res.status(204).end();
  } catch (err) {
    console.error('Delete error:', err);
    res.status(500).json({ error: 'Failed to delete record' });
  }
});

/**
 * DELETE /api/:table - Delete multiple records
 * Maps to StorageAdapter.deleteMany()
 * Query params: parentId
 */
router.delete('/:table', validateTable, (req: Request, res: Response) => {
  try {
    const { table } = req.params;
    const userId = req.userId!;
    const filters = parseQueryFilters(req);

    if (!filters.parentId) {
      res.status(400).json({ error: 'parentId query parameter is required for bulk delete' });
      return;
    }

    deleteMany(userId, table, filters);
    res.status(204).end();
  } catch (err) {
    console.error('DeleteMany error:', err);
    res.status(500).json({ error: 'Failed to delete records' });
  }
});

/**
 * POST /api/_clear-all - Clear all records for user
 * Maps to StorageAdapter.clearAll()
 */
router.post('/_clear-all', (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    clearAllForUser(userId);
    res.status(204).end();
  } catch (err) {
    console.error('ClearAll error:', err);
    res.status(500).json({ error: 'Failed to clear data' });
  }
});

/**
 * Parse query filters from request query string
 */
function parseQueryFilters(req: Request): QueryFilters {
  const { parentId, orderBy, orderDirection } = req.query;

  const filters: QueryFilters = {};

  if (typeof parentId === 'string') {
    filters.parentId = parentId;
  }

  if (orderBy === 'timestamp' || orderBy === 'createdAt') {
    filters.orderBy = orderBy;
  }

  if (orderDirection === 'asc' || orderDirection === 'desc') {
    filters.orderDirection = orderDirection;
  }

  return filters;
}
