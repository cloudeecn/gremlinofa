/**
 * HTTP route handlers for VFS CRUD, compound operations, and versioning.
 */

import { Router } from 'express';
import * as fsOps from './fsOperations.js';

export const router = Router();

// All endpoints require projectId query param
function getString(value: unknown): string | undefined {
  if (typeof value === 'string' && value) return value;
  return undefined;
}

function getProjectRoot(
  req: { userId?: string; query: Record<string, unknown> },
  res: { status: (code: number) => { json: (body: unknown) => void } }
): string | null {
  const projectId = getString(req.query.projectId);
  if (!projectId) {
    res.status(400).json({ error: 'projectId query parameter required' });
    return null;
  }
  if (!req.userId) {
    res.status(401).json({ error: 'userId not available' });
    return null;
  }
  return fsOps.projectRoot(req.userId, projectId);
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

// ============================================================================
// Basic CRUD
// ============================================================================

router.get('/ls', async (req, res) => {
  const root = getProjectRoot(req, res);
  if (!root) return;
  const dirPath = (req.query.path as string) || '/';

  try {
    const entries = await fsOps.ls(root, dirPath);
    res.json({ entries });
  } catch (e) {
    handleError(res, e, 'ls');
  }
});

router.get('/stat', async (req, res) => {
  const root = getProjectRoot(req, res);
  if (!root) return;
  const filePath = getPath(req, res);
  if (!filePath) return;

  try {
    const s = await fsOps.stat(root, filePath);
    res.json(s);
  } catch (e) {
    handleError(res, e, 'stat');
  }
});

router.get('/exists', async (req, res) => {
  const root = getProjectRoot(req, res);
  if (!root) return;
  const filePath = getPath(req, res);
  if (!filePath) return;

  try {
    const result = await fsOps.exists(root, filePath);
    res.json({ exists: result });
  } catch (e) {
    handleError(res, e, 'exists');
  }
});

router.get('/read', async (req, res) => {
  const root = getProjectRoot(req, res);
  if (!root) return;
  const filePath = getPath(req, res);
  if (!filePath) return;

  try {
    const content = await fsOps.read(root, filePath);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.send(content);
  } catch (e) {
    handleError(res, e, 'read');
  }
});

router.put('/write', async (req, res) => {
  const root = getProjectRoot(req, res);
  if (!root) return;
  const filePath = getPath(req, res);
  if (!filePath) return;
  const createOnly = req.query.createOnly === 'true';

  try {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const body = Buffer.concat(chunks);

    await fsOps.write(root, filePath, body, createOnly);
    res.status(204).end();
  } catch (e) {
    handleError(res, e, 'write');
  }
});

router.delete('/rm', async (req, res) => {
  const root = getProjectRoot(req, res);
  if (!root) return;
  const filePath = getPath(req, res);
  if (!filePath) return;

  try {
    await fsOps.rm(root, filePath);
    res.status(204).end();
  } catch (e) {
    handleError(res, e, 'rm');
  }
});

router.post('/mkdir', async (req, res) => {
  const root = getProjectRoot(req, res);
  if (!root) return;
  const filePath = getPath(req, res);
  if (!filePath) return;

  try {
    await fsOps.mkdir(root, filePath);
    res.status(204).end();
  } catch (e) {
    handleError(res, e, 'mkdir');
  }
});

router.delete('/rmdir', async (req, res) => {
  const root = getProjectRoot(req, res);
  if (!root) return;
  const filePath = getPath(req, res);
  if (!filePath) return;

  try {
    await fsOps.rmdir(root, filePath);
    res.status(204).end();
  } catch (e) {
    handleError(res, e, 'rmdir');
  }
});

router.post('/rename', async (req, res) => {
  const root = getProjectRoot(req, res);
  if (!root) return;

  // Read JSON body
  const body = req.body as { from?: string; to?: string } | undefined;
  if (!body?.from || !body?.to) {
    res.status(400).json({ error: 'from and to fields required in body' });
    return;
  }

  try {
    await fsOps.rename(root, body.from, body.to);
    res.status(204).end();
  } catch (e) {
    handleError(res, e, 'rename');
  }
});

// ============================================================================
// Compound operations
// ============================================================================

router.post('/str-replace', async (req, res) => {
  const root = getProjectRoot(req, res);
  if (!root) return;
  const filePath = getPath(req, res);
  if (!filePath) return;

  const body = req.body as { oldStr?: string; newStr?: string } | undefined;
  if (body?.oldStr === undefined || body?.newStr === undefined) {
    res.status(400).json({ error: 'oldStr and newStr fields required in body' });
    return;
  }

  try {
    const result = await fsOps.strReplace(root, filePath, body.oldStr, body.newStr);
    res.json(result);
  } catch (e) {
    handleError(res, e, 'str-replace');
  }
});

router.post('/insert', async (req, res) => {
  const root = getProjectRoot(req, res);
  if (!root) return;
  const filePath = getPath(req, res);
  if (!filePath) return;

  const body = req.body as { line?: number; text?: string } | undefined;
  if (body?.line === undefined || body?.text === undefined) {
    res.status(400).json({ error: 'line and text fields required in body' });
    return;
  }

  try {
    const result = await fsOps.insert(root, filePath, body.line, body.text);
    res.json(result);
  } catch (e) {
    handleError(res, e, 'insert');
  }
});

router.post('/append', async (req, res) => {
  const root = getProjectRoot(req, res);
  if (!root) return;
  const filePath = getPath(req, res);
  if (!filePath) return;

  const body = req.body as { text?: string } | undefined;
  if (body?.text === undefined) {
    res.status(400).json({ error: 'text field required in body' });
    return;
  }

  try {
    const result = await fsOps.append(root, filePath, body.text);
    res.json(result);
  } catch (e) {
    handleError(res, e, 'append');
  }
});

// ============================================================================
// Versioning
// ============================================================================

router.get('/versions', async (req, res) => {
  const root = getProjectRoot(req, res);
  if (!root) return;
  const filePath = getPath(req, res);
  if (!filePath) return;

  try {
    const versions = await fsOps.fileVersions(root, filePath);
    res.json({ versions });
  } catch (e) {
    handleError(res, e, 'versions');
  }
});

router.get('/version', async (req, res) => {
  const root = getProjectRoot(req, res);
  if (!root) return;
  const filePath = getPath(req, res);
  if (!filePath) return;

  const v = parseInt(req.query.v as string, 10);
  if (isNaN(v)) {
    res.status(400).json({ error: 'v query parameter required (version number)' });
    return;
  }

  try {
    const content = await fsOps.fileVersion(root, filePath, v);
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

router.delete('/versions', async (req, res) => {
  const root = getProjectRoot(req, res);
  if (!root) return;
  const filePath = getPath(req, res);
  if (!filePath) return;

  const keep = parseInt(req.query.keep as string, 10);
  if (isNaN(keep) || keep < 0) {
    res.status(400).json({ error: 'keep query parameter required (positive integer)' });
    return;
  }

  try {
    const deleted = await fsOps.dropFileVersions(root, filePath, keep);
    res.json({ deleted });
  } catch (e) {
    handleError(res, e, 'drop-versions');
  }
});

router.get('/file-meta', async (req, res) => {
  const root = getProjectRoot(req, res);
  if (!root) return;
  const filePath = getPath(req, res);
  if (!filePath) return;

  try {
    const meta = await fsOps.fileMeta(root, filePath);
    if (!meta) {
      res.status(404).json({ error: 'File not found' });
      return;
    }
    res.json(meta);
  } catch (e) {
    handleError(res, e, 'file-meta');
  }
});

router.post('/compact', async (req, res) => {
  const root = getProjectRoot(req, res);
  if (!root) return;

  const body = req.body as { keepCount?: number } | undefined;
  const keepCount = body?.keepCount ?? 10;

  try {
    const result = await fsOps.compact(root, keepCount);
    res.json(result);
  } catch (e) {
    handleError(res, e, 'compact');
  }
});

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
