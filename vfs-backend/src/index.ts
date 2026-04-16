/**
 * VFS Backend for GremlinOFA
 *
 * A standalone Express server providing filesystem CRUD with per-file locking,
 * server-side versioning, and compound text operations. Each user gets an
 * isolated directory — files are real, browsable, and editable outside the app.
 */

import express from 'express';
import { config } from './config.js';
import { basicAuth, cors } from './middleware.js';
import { router } from './routes.js';

export function createApp() {
  const app = express();

  // CORS before auth
  app.use(cors);

  // Health check (no auth)
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  // Auth for all API routes
  app.use('/api', basicAuth);

  // Mount API routes
  app.use('/api', router);

  return app;
}

// Start server when run directly
const app = createApp();

const server = app.listen(config.port, () => {
  console.log(`VFS backend listening on port ${config.port}`);
  console.log(`Data directory: ${config.dataDir}`);
  console.log(`Auth: ${config.authPassword ? 'password required' : 'dev mode (no password)'}`);
  const corsDisplay = config.corsOrigins
    ? config.corsOrigins === '*'
      ? 'allow all (*)'
      : config.corsOrigins.join(', ')
    : 'same-domain only';
  console.log(`CORS: ${corsDisplay}`);
});

process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down...');
  server.close(() => process.exit(0));
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down...');
  server.close(() => process.exit(0));
});
