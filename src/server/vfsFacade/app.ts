/**
 * VFS Backend Express app factory.
 *
 * Creates a standalone Express server providing filesystem CRUD with per-file
 * locking, server-side versioning, and compound text operations. Each user gets
 * an isolated directory — files are real, browsable, and editable outside the app.
 */

import express from 'express';
import { basicAuth, cors, createAuthFailureLimiter } from './middleware.js';
import { createRouter } from './routes.js';
import { config } from './config.js';

export function createVfsApp() {
  const app = express();
  app.set('trust proxy', config.trustProxy);

  // CORS before auth
  app.use(cors);

  // Health check (no auth)
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  // Auth for all API routes, behind the wrong-password cap
  app.use('/api', createAuthFailureLimiter(), basicAuth);

  // Mount API routes
  app.use('/api', createRouter(config.dataDir, config.accessConfig));

  return app;
}

export { config };
