import express, { type ErrorRequestHandler, type Express } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import type { Config } from './config.js';
import { apiErrorHandler, apiNotFound, createApiRouter } from './apiRoutes.js';
import { classifyError } from './httpErrors.js';
import { createApiAuth, createAuthFailureLimiter, createCors } from './middleware.js';
import type { PollRegistry } from './pollManager.js';
import { createWebRouter } from './webRoutes.js';

// Resolves to src/static under tsx/vitest and to dist/static in the esbuild bundle.
const STATIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'static');

/** Last stop for anything outside /api and /web: plain text, no stack trace. */
const fallbackErrorHandler: ErrorRequestHandler = (err, req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }
  const { status, message } = classifyError(err);
  if (status >= 500) {
    console.error('%s %s failed:', req.method, req.originalUrl, err);
  }
  res.status(status).type('text/plain').send(message);
};

/**
 * Builds the Express app. Expects initDatabase() to have run; does not listen. `polls` holds
 * this app's long-poll waiters; hand the same registry to createShutdownHandler.
 */
export function createApp(appConfig: Config, polls: PollRegistry): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', appConfig.trustProxy);

  const cors = createCors(appConfig.corsOrigins);

  app.use('/health', cors);
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  // Auth runs before the body parser so unauthenticated callers can't make us parse 10 MB.
  // The limiter sits after cors so its 429 still carries the CORS headers.
  app.use(
    '/api',
    cors,
    createAuthFailureLimiter((_req, res, seconds) => {
      res.status(429).json({
        error: `Too many wrong API passwords from this address. Try again in ${seconds} seconds.`,
      });
    }),
    createApiAuth(appConfig.apiPassword),
    express.json({ limit: '10mb' }),
    createApiRouter({ pollTimeoutMs: appConfig.pollTimeoutMs, polls })
  );
  app.use('/api', apiNotFound);
  app.use('/api', apiErrorHandler);

  // The web router brings its own headers, auth, body parsing, 404 and error pages.
  app.use(
    '/web',
    createWebRouter({ webPassword: appConfig.webPassword, staticDir: STATIC_DIR, polls })
  );

  app.use(fallbackErrorHandler);
  return app;
}
