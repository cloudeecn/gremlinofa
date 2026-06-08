/**
 * Standalone VFS server entry point.
 *
 * Build with `npm run build:vfs-server`, then deploy `dist/vfs-server/`.
 */

import { createVfsApp, config } from './app.js';

const app = createVfsApp();

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
