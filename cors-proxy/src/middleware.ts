/**
 * CORS middleware — adapted from storage-backend.
 * Reflects Access-Control-Request-Headers for maximum SDK compatibility.
 */

import type { Request, Response, NextFunction } from 'express';
import { config } from './config.js';

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

      if (req.method === 'OPTIONS') {
        res.status(204).end();
        return;
      }
    }
  }

  next();
}
