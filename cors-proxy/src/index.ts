/**
 * CORS Proxy for GremlinOFA
 *
 * Forwards browser requests to AI APIs that don't support CORS.
 * Streams responses (including SSE) without buffering.
 */

import express from 'express';
import { config } from './config.js';
import { cors } from './middleware.js';
import { proxyHandler } from './proxy.js';

const app = express();

app.use(cors);

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// All other requests get proxied. No body parser — raw stream piped through.
app.use(proxyHandler);

const server = app.listen(config.port, () => {
  const corsDisplay = config.corsOrigins
    ? config.corsOrigins === '*'
      ? 'all origins (*)'
      : (config.corsOrigins as string[]).join(', ')
    : 'same-domain only';
  const targetDisplay = config.allowedTargets
    ? config.allowedTargets.join(', ')
    : 'all domains (dev mode)';
  console.log(`CORS proxy listening on port ${config.port}`);
  console.log(`  CORS: ${corsDisplay}`);
  console.log(`  Allowed targets: ${targetDisplay}`);
});

process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down...');
  server.close(() => process.exit(0));
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down...');
  server.close(() => process.exit(0));
});

export { app };
