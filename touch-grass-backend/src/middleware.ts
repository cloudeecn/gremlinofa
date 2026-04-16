import type { Request, Response, NextFunction } from 'express';
import { config } from './config.js';
import crypto from 'crypto';

declare module 'express-serve-static-core' {
  interface Request {
    callerId?: string;
  }
}

/**
 * Basic Auth middleware for API routes.
 * Username = callerId, password must match API_PASSWORD.
 */
export function apiAuth(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Basic ')) {
    res.status(401).json({ error: 'Authorization required' });
    return;
  }

  try {
    const base64Credentials = authHeader.slice(6);
    const credentials = Buffer.from(base64Credentials, 'base64').toString('utf-8');
    const colonIdx = credentials.indexOf(':');

    if (colonIdx === -1) {
      res.status(401).json({ error: 'Invalid credentials format' });
      return;
    }

    const callerId = credentials.substring(0, colonIdx);
    const password = credentials.substring(colonIdx + 1);

    if (!callerId) {
      res.status(401).json({ error: 'Missing caller ID' });
      return;
    }

    if (config.apiPassword && password !== config.apiPassword) {
      res.status(401).json({ error: 'Invalid password' });
      return;
    }

    req.callerId = callerId;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid authorization header' });
  }
}

// Simple token-based web auth using a cookie
const WEB_COOKIE_NAME = 'tg_auth';

function generateWebToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

// In-memory set of valid web tokens (survives for the process lifetime)
const validWebTokens = new Set<string>();

export function createWebToken(): string {
  const token = generateWebToken();
  validWebTokens.add(token);
  return token;
}

export function validateWebToken(token: string): boolean {
  return validWebTokens.has(token);
}

/**
 * Cookie-based auth middleware for web routes.
 * Allows /web/login and /web/static through without auth.
 */
export function webAuth(req: Request, res: Response, next: NextFunction): void {
  // Allow login page and static assets through
  if (req.path === '/login' || req.path.startsWith('/static/')) {
    next();
    return;
  }

  const cookieHeader = req.headers.cookie || '';
  const cookies = Object.fromEntries(
    cookieHeader.split(';').map(c => {
      const [key, ...rest] = c.trim().split('=');
      return [key, rest.join('=')];
    })
  );

  const token = cookies[WEB_COOKIE_NAME];
  if (token && validateWebToken(token)) {
    next();
    return;
  }

  // For JSON API endpoints under /web/api, return 401
  if (req.path.startsWith('/api/')) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  // For HTML pages, redirect to login
  res.redirect('/web/login');
}

export { WEB_COOKIE_NAME };

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
