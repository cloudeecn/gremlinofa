import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';
import { initDatabase, closeDatabase } from './db.js';
import { apiAuth, webAuth, cors } from './middleware.js';
import { apiRouter } from './apiRoutes.js';
import { webRouter } from './webRoutes.js';
import { clearAll as clearPollWaiters } from './pollManager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

initDatabase();

const app = express();

app.use(cors);

// Health check (no auth)
app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// API routes (Basic Auth + JSON body)
app.use('/api', express.json({ limit: '10mb' }));
app.use('/api', apiAuth);
app.use('/api', apiRouter);

// Web UI static files (no auth needed for CSS/JS)
app.use('/web/static', express.static(path.join(__dirname, 'static')));

// Web routes (cookie auth + form body parsing)
app.use('/web', express.urlencoded({ extended: false }));
app.use('/web', express.json());
app.use('/web', webAuth);
app.use('/web', webRouter);

const server = app.listen(config.port, () => {
  console.log(`Touch Grass backend listening on port ${config.port}`);
  console.log(`Database: ${config.dbPath}`);
  console.log(`Web UI: http://localhost:${config.port}/web/`);
  const corsDisplay = config.corsOrigins
    ? config.corsOrigins === '*'
      ? 'allow all (*)'
      : config.corsOrigins.join(', ')
    : 'same-domain only';
  console.log(`CORS: ${corsDisplay}`);
});

function shutdown() {
  console.log('Shutting down...');
  clearPollWaiters();
  server.close(() => {
    closeDatabase();
    process.exit(0);
  });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

export { app };
