/**
 * Express middleware for authentication and CORS
 */

import type { Request, Response, NextFunction } from 'express';
import { config } from './config.js';

// Extend Express Request to include userId
declare module 'express-serve-static-core' {
  interface Request {
    userId?: string;
  }
}

/**
 * Basic Auth middleware.
 * Extracts userId from the username field.
 * If AUTH_PASSWORD is configured, validates the password too.
 */
export function basicAuth(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Basic ')) {
    res.status(401).json({ error: 'Authorization required' });
    return;
  }

  try {
    const base64Credentials = authHeader.slice(6);
    const credentials = Buffer.from(base64Credentials, 'base64').toString('utf-8');
    const colonIndex = credentials.indexOf(':');

    if (colonIndex === -1) {
      res.status(401).json({ error: 'Invalid credentials format' });
      return;
    }

    const userId = credentials.slice(0, colonIndex);
    const password = credentials.slice(colonIndex + 1);

    if (!userId) {
      res.status(401).json({ error: 'Invalid credentials format' });
      return;
    }

    // Validate password if AUTH_PASSWORD is configured
    if (config.authPassword && password !== config.authPassword) {
      res.status(401).json({ error: 'Invalid password' });
      return;
    }

    req.userId = userId;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid authorization header' });
  }
}

/**
 * CORS middleware
 */
export function cors(req: Request, res: Response, next: NextFunction): void {
  const origins = config.corsOrigins;

  if (!origins) {
    next();
    return;
  }

  if (origins === '*') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
  } else {
    const requestOrigin = req.headers.origin;

    if (requestOrigin && origins.includes(requestOrigin)) {
      res.setHeader('Access-Control-Allow-Origin', requestOrigin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.setHeader('Access-Control-Allow-Credentials', 'true');

      if (req.method === 'OPTIONS') {
        res.status(204).end();
        return;
      }
    }
  }

  next();
}
