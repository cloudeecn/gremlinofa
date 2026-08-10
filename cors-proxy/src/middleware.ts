/**
 * CORS middleware — adapted from storage-backend.
 * Reflects Access-Control-Request-Headers for maximum SDK compatibility.
 */

import type { Request, Response, NextFunction } from 'express';
import { config } from './config.js';

/**
 * Upstream response headers the browser is allowed to read. The ChatGPT
 * backend reports subscription quota in `x-codex-*` headers; `*` would be
 * ignored whenever `Allow-Credentials` is set, so they are listed explicitly.
 */
export const EXPOSED_RESPONSE_HEADERS = [
  'x-codex-primary-used-percent',
  'x-codex-primary-window-minutes',
  'x-codex-primary-reset-at',
  'x-codex-secondary-used-percent',
  'x-codex-secondary-window-minutes',
  'x-codex-secondary-reset-at',
  'x-codex-credits-has-credits',
  'x-codex-credits-unlimited',
  'x-codex-credits-balance',
  'x-codex-plan-type',
  'x-codex-limit-name',
  'x-codex-rate-limit-reached-type',
].join(', ');

export function cors(req: Request, res: Response, next: NextFunction): void {
  const origins = config.corsOrigins;

  if (!origins) {
    next();
    return;
  }

  // Reflect whatever headers the browser requested in the preflight
  const allowHeaders =
    req.headers['access-control-request-headers'] || 'Content-Type, Authorization, X-Proxy-Target';

  if (origins === '*') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', allowHeaders);
    res.setHeader('Access-Control-Expose-Headers', EXPOSED_RESPONSE_HEADERS);

    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
  } else {
    const requestOrigin = req.headers.origin;

    if (requestOrigin && origins.includes(requestOrigin)) {
      res.setHeader('Access-Control-Allow-Origin', requestOrigin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', allowHeaders);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Expose-Headers', EXPOSED_RESPONSE_HEADERS);

      if (req.method === 'OPTIONS') {
        res.status(204).end();
        return;
      }
    }
  }

  next();
}
