/**
 * SQLite Storage Backend for GremlinOFA
 *
 * A standalone Express server that provides HTTP APIs matching the StorageAdapter interface.
 * Multi-tenant by design - all data isolated by userId from Basic Auth.
 */

import express from 'express';
import { config } from './config.js';
import { initDatabase, closeDatabase } from './db.js';
import { basicAuth, cors } from './middleware.js';
import { router } from './routes.js';

// Initialize database
initDatabase();

// Create Express app
const app = express();

// Apply CORS middleware (before auth)
app.use(cors);

// Apply Basic Auth to all API routes
app.use('/api', basicAuth);

// Mount API routes
app.use('/api', router);

// Health check endpoint (no auth required)
app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// Start server
const server = app.listen(config.port, () => {
  console.log(`Storage backend listening on port ${config.port}`);
  console.log(`Database: ${config.dbPath}`);
  const corsDisplay = config.corsOrigins
    ? config.corsOrigins === '*'
      ? 'allow all (*)'
      : config.corsOrigins.join(', ')
    : 'same-domain only';
  console.log(`CORS: ${corsDisplay}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down...');
  server.close(() => {
    closeDatabase();
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down...');
  server.close(() => {
    closeDatabase();
    process.exit(0);
  });
});
