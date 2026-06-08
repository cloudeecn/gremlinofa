/**
 * HTTP route handlers for VFS CRUD, compound operations, and versioning.
 */

import fsSync from 'node:fs';
import { Router } from 'express';
import express from 'express';
import * as fsOps from '../vfsEngine/fsEngine.js';
import type { VfsContext } from '../vfsEngine/fsEngine.js';
import { getAllowedRootsForProject, type VfsAccessConfig } from '../vfsEngine/accessConfig.js';

const jsonBody = express.json();
const rawBody = express.raw({ type: () => true, limit: '50mb' });

export const router = Router();

// All endpoints require projectId query param
function getString(value: unknown): string | undefined {
  if (typeof value === 'string' && value) return value;
  return undefined;
}

function getProjectContext(
  req: { userId?: string; query: Record<string, unknown> },
  res: { status: (code: number) => { json: (body: unknown) => void } },
  dataDir: string,
  accessConfig: VfsAccessConfig
): VfsContext | null {
  const projectId = getString(req.query.projectId);
  if (!projectId) {
    res.status(400).json({ error: 'projectId query parameter required' });
    return null;
  }
  if (!req.userId) {
    res.status(401).json({ error: 'userId not available' });
    return null;
  }
  const root = fsOps.projectRoot(dataDir, req.userId, projectId);
  // Materialize + canonicalize the project root. mkdirSync handles first-touch
  // projects; realpathSync makes downstream allow-list comparisons canonical.
  fsSync.mkdirSync(root, { recursive: true });
  const canonicalRoot = fsSync.realpathSync(root);
  return {
    projectRoot: canonicalRoot,
    allowedRoots: getAllowedRootsForProject(accessConfig, projectId, canonicalRoot),
    followSymlinks: accessConfig.followSymlinks,
  };
}

function getPath(
  req: { query: Record<string, unknown> },
  res: { status: (code: number) => { json: (body: unknown) => void } }
): string | null {
  const filePath = getString(req.query.path);
  if (!filePath) {
    res.status(400).json({ error: 'path query parameter required' });
    return null;
  }
  return filePath;
}

/**
 * Create a VFS router bound to a specific data directory + access config.
 */
export function createRouter(dataDir: string, accessConfig: VfsAccessConfig): Router {
  const r = Router();

  // ============================================================================
  // Basic CRUD
  // ============================================================================

  r.get('/ls', async (req, res) => {
    const ctx = getProjectContext(req, res, dataDir, accessConfig);
    if (!ctx) return;
    const dirPath = (req.query.path as string) || '/';

    try {
      const entries = await fsOps.ls(ctx, dirPath);
      res.json({ entries });
    } catch (e) {
      handleError(res, e, 'ls');
    }
  });

  r.get('/stat', async (req, res) => {
    const ctx = getProjectContext(req, res, dataDir, accessConfig);
    if (!ctx) return;
    const filePath = getPath(req, res);
    if (!filePath) return;

    try {
      const s = await fsOps.stat(ctx, filePath);
      res.json(s);
    } catch (e) {
      handleError(res, e, 'stat');
    }
  });

  r.get('/exists', async (req, res) => {
    const ctx = getProjectContext(req, res, dataDir, accessConfig);
    if (!ctx) return;
    const filePath = getPath(req, res);
    if (!filePath) return;

    try {
      const result = await fsOps.exists(ctx, filePath);
      res.json({ exists: result });
    } catch (e) {
      handleError(res, e, 'exists');
    }
  });

  r.get('/read', async (req, res) => {
    const ctx = getProjectContext(req, res, dataDir, accessConfig);
    if (!ctx) return;
    const filePath = getPath(req, res);
    if (!filePath) return;

    try {
      const content = await fsOps.read(ctx, filePath);
      res.setHeader('Content-Type', 'application/octet-stream');
      res.send(content);
    } catch (e) {
      handleError(res, e, 'read');
    }
  });

  r.put('/write', rawBody, async (req, res) => {
    const ctx = getProjectContext(req, res, dataDir, accessConfig);
    if (!ctx) return;
    const filePath = getPath(req, res);
    if (!filePath) return;
    const createOnly = req.query.createOnly === 'true';

    try {
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body ?? '');
      await fsOps.write(ctx, filePath, body, createOnly);
      res.status(204).end();
    } catch (e) {
      handleError(res, e, 'write');
    }
  });

  r.delete('/rm', async (req, res) => {
    const ctx = getProjectContext(req, res, dataDir, accessConfig);
    if (!ctx) return;
    const filePath = getPath(req, res);
    if (!filePath) return;

    try {
      await fsOps.rm(ctx, filePath);
      res.status(204).end();
    } catch (e) {
      handleError(res, e, 'rm');
    }
  });

  r.post('/mkdir', async (req, res) => {
    const ctx = getProjectContext(req, res, dataDir, accessConfig);
    if (!ctx) return;
    const filePath = getPath(req, res);
    if (!filePath) return;

    try {
      await fsOps.mkdir(ctx, filePath);
      res.status(204).end();
    } catch (e) {
      handleError(res, e, 'mkdir');
    }
  });

  r.delete('/rmdir', async (req, res) => {
    const ctx = getProjectContext(req, res, dataDir, accessConfig);
    if (!ctx) return;
    const filePath = getPath(req, res);
    if (!filePath) return;

    try {
      await fsOps.rmdir(ctx, filePath);
      res.status(204).end();
    } catch (e) {
      handleError(res, e, 'rmdir');
    }
  });

  r.post('/rename', jsonBody, async (req, res) => {
    const ctx = getProjectContext(req, res, dataDir, accessConfig);
    if (!ctx) return;

    // Read JSON body
    const body = req.body as { from?: string; to?: string } | undefined;
    if (!body?.from || !body?.to) {
      res.status(400).json({ error: 'from and to fields required in body' });
      return;
    }

    try {
      await fsOps.rename(ctx, body.from, body.to);
      res.status(204).end();
    } catch (e) {
      handleError(res, e, 'rename');
    }
  });

  // ============================================================================
  // Compound operations
  // ============================================================================

  r.post('/str-replace', jsonBody, async (req, res) => {
    const ctx = getProjectContext(req, res, dataDir, accessConfig);
    if (!ctx) return;
    const filePath = getPath(req, res);
    if (!filePath) return;

    const body = req.body as { oldStr?: string; newStr?: string } | undefined;
    if (body?.oldStr === undefined || body?.newStr === undefined) {
      res.status(400).json({ error: 'oldStr and newStr fields required in body' });
      return;
    }

    try {
      const result = await fsOps.strReplace(ctx, filePath, body.oldStr, body.newStr);
      res.json(result);
    } catch (e) {
      handleError(res, e, 'str-replace');
    }
  });

  r.post('/insert', jsonBody, async (req, res) => {
    const ctx = getProjectContext(req, res, dataDir, accessConfig);
    if (!ctx) return;
    const filePath = getPath(req, res);
    if (!filePath) return;

    const body = req.body as { line?: number; text?: string } | undefined;
    if (body?.line === undefined || body?.text === undefined) {
      res.status(400).json({ error: 'line and text fields required in body' });
      return;
    }

    try {
      const result = await fsOps.insert(ctx, filePath, body.line, body.text);
      res.json(result);
    } catch (e) {
      handleError(res, e, 'insert');
    }
  });

  r.post('/append', jsonBody, async (req, res) => {
    const ctx = getProjectContext(req, res, dataDir, accessConfig);
    if (!ctx) return;
    const filePath = getPath(req, res);
    if (!filePath) return;

    const body = req.body as { text?: string } | undefined;
    if (body?.text === undefined) {
      res.status(400).json({ error: 'text field required in body' });
      return;
    }

    try {
      const result = await fsOps.append(ctx, filePath, body.text);
      res.json(result);
    } catch (e) {
      handleError(res, e, 'append');
    }
  });

  // ============================================================================
  // Versioning
  // ============================================================================

  r.get('/versions', async (req, res) => {
    const ctx = getProjectContext(req, res, dataDir, accessConfig);
    if (!ctx) return;
    const filePath = getPath(req, res);
    if (!filePath) return;

    try {
      const versions = await fsOps.fileVersions(ctx, filePath);
      res.json({ versions });
    } catch (e) {
      handleError(res, e, 'versions');
    }
  });

  r.get('/versions/bulk', async (req, res) => {
    const ctx = getProjectContext(req, res, dataDir, accessConfig);
    if (!ctx) return;
    const filePath = getPath(req, res);
    if (!filePath) return;

    try {
      const versions = await fsOps.readAllFileVersions(ctx, filePath);
      res.json({ versions });
    } catch (e) {
      handleError(res, e, 'versions-bulk');
    }
  });

  r.get('/version', async (req, res) => {
    const ctx = getProjectContext(req, res, dataDir, accessConfig);
    if (!ctx) return;
    const filePath = getPath(req, res);
    if (!filePath) return;

    const v = parseInt(req.query.v as string, 10);
    if (isNaN(v)) {
      res.status(400).json({ error: 'v query parameter required (version number)' });
      return;
    }

    try {
      const content = await fsOps.fileVersion(ctx, filePath, v);
      if (!content) {
        res.status(404).json({ error: 'Version not found' });
        return;
      }
      res.setHeader('Content-Type', 'application/octet-stream');
      res.send(content);
    } catch (e) {
      handleError(res, e, 'version');
    }
  });

  r.delete('/versions', async (req, res) => {
    const ctx = getProjectContext(req, res, dataDir, accessConfig);
    if (!ctx) return;
    const filePath = getPath(req, res);
    if (!filePath) return;

    const keep = parseInt(req.query.keep as string, 10);
    if (isNaN(keep) || keep < 0) {
      res.status(400).json({ error: 'keep query parameter required (positive integer)' });
      return;
    }

    try {
      const deleted = await fsOps.dropFileVersions(ctx, filePath, keep);
      res.json({ deleted });
    } catch (e) {
      handleError(res, e, 'drop-versions');
    }
  });

  r.get('/file-meta', async (req, res) => {
    const ctx = getProjectContext(req, res, dataDir, accessConfig);
    if (!ctx) return;
    const filePath = getPath(req, res);
    if (!filePath) return;

    try {
      const meta = await fsOps.fileMeta(ctx, filePath);
      if (!meta) {
        res.status(404).json({ error: 'File not found' });
        return;
      }
      res.json(meta);
    } catch (e) {
      handleError(res, e, 'file-meta');
    }
  });

  r.post('/compact', jsonBody, async (req, res) => {
    const ctx = getProjectContext(req, res, dataDir, accessConfig);
    if (!ctx) return;

    const body = req.body as { keepCount?: number } | undefined;
    const keepCount = body?.keepCount ?? 10;

    try {
      const result = await fsOps.compact(ctx, keepCount);
      res.json(result);
    } catch (e) {
      handleError(res, e, 'compact');
    }
  });

  return r;
}

// ============================================================================
// Error handling
// ============================================================================

function handleError(
  res: { status: (code: number) => { json: (body: unknown) => void } },
  error: unknown,
  operation: string
): void {
  if (error instanceof fsOps.FsError) {
    res.status(error.status).json({ error: error.message });
    return;
  }

  const nodeError = error as { code?: string };
  if (nodeError.code === 'ENOENT') {
    res.status(404).json({ error: `Not found (${operation})` });
    return;
  }
  if (nodeError.code === 'ENOTDIR') {
    res.status(400).json({ error: `Not a directory (${operation})` });
    return;
  }

  console.error(`[vfs-backend] ${operation} error:`, error);
  res.status(500).json({ error: 'Internal server error' });
}
