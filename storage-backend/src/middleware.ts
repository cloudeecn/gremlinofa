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
 * Basic Auth middleware
 * Extracts userId from the username part of Basic Auth credentials
 * Password is currently ignored (placeholder for future control plane auth)
 */
export function basicAuth(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Basic ')) {
    res.status(401).json({ error: 'Authorization required' });
    return;
  }

  try {
    const base64Credentials = authHeader.slice(6); // Remove 'Basic '
    const credentials = Buffer.from(base64Credentials, 'base64').toString('utf-8');
    const [userId] = credentials.split(':');

    if (!userId) {
      res.status(401).json({ error: 'Invalid credentials format' });
      return;
    }

    // Attach userId to request
    req.userId = userId;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid authorization header' });
  }
}

/**
 * CORS middleware
 * Configurable via CORS_ORIGIN env var
 */
export function cors(req: Request, res: Response, next: NextFunction): void {
  const origin = config.corsOrigin;

  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Credentials', 'true');

    // Handle preflight
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
  }

  next();
}
