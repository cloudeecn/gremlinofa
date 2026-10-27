/**
 * Express middleware for authentication, auth-failure limiting and CORS
 */

import crypto from 'node:crypto';
import type { Request, RequestHandler, Response, NextFunction } from 'express';
import { rateLimit, type RateLimitInfo } from 'express-rate-limit';
import { config } from './config.js';

// Extend Express Request to include userId
declare module 'express-serve-static-core' {
  interface Request {
    userId?: string;
  }
}

/** Both sides of the password check are copied into buffers at least this big. */
const PASSWORD_SLOT_BYTES = 1024;

/**
 * Constant-time check against AUTH_PASSWORD. Both sides are copied into
 * equal-size zeroed buffers so timingSafeEqual always covers the same bytes,
 * and the length check comes after it, so the timing depends only on the
 * candidate's own length. No hash on purpose: CodeQL's
 * js/insufficient-password-hash flags a sha256 here even though nothing is
 * stored.
 */
function passwordMatches(candidate: string, expected: string): boolean {
  const given = Buffer.from(candidate, 'utf8');
  const wanted = Buffer.from(expected, 'utf8');
  const slotBytes = Math.max(PASSWORD_SLOT_BYTES, wanted.length);
  if (given.length > slotBytes) return false;
  const givenSlot = Buffer.alloc(slotBytes);
  const wantedSlot = Buffer.alloc(slotBytes);
  given.copy(givenSlot);
  wanted.copy(wantedSlot);
  const bytesMatch = crypto.timingSafeEqual(givenSlot, wantedSlot);
  return bytesMatch && given.length === wanted.length;
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
    if (config.authPassword && !passwordMatches(password, config.authPassword)) {
      res.status(401).json({ error: 'Invalid password' });
      return;
    }

    req.userId = userId;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid authorization header' });
  }
}

export const AUTH_FAILURE_LIMIT = 100;
const AUTH_FAILURE_WINDOW_MS = 15 * 60_000;

/** express-rate-limit puts its counters on the request but doesn't type them there. */
function retryAfterSeconds(req: Request): number {
  const { resetTime } = (req as Request & { rateLimit: RateLimitInfo }).rateLimit;
  const msLeft = resetTime ? resetTime.getTime() - Date.now() : AUTH_FAILURE_WINDOW_MS;
  return Math.max(1, Math.ceil(msLeft / 1000));
}

/**
 * Caps wrong-password guessing: a client address that collects
 * AUTH_FAILURE_LIMIT 401s in a window gets 429 on everything until the window
 * ends, the right password included (letting that through would let a
 * guesser keep going). Only 401s count, but express-rate-limit counts a
 * request when it starts and refunds it when it finishes, so requests still
 * in flight count too: the limit has to stay well above a client's
 * concurrency. Mount it ahead of basicAuth.
 */
export function createAuthFailureLimiter(): RequestHandler {
  return rateLimit({
    windowMs: AUTH_FAILURE_WINDOW_MS,
    limit: AUTH_FAILURE_LIMIT,
    skipSuccessfulRequests: true,
    requestWasSuccessful: (_req, res) => res.statusCode !== 401,
    standardHeaders: false,
    legacyHeaders: false,
    handler: (req, res) => {
      const seconds = retryAfterSeconds(req);
      res.setHeader('Retry-After', String(seconds));
      res.status(429).json({
        error: `Too many failed sign-ins from this address. Try again in ${seconds} seconds.`,
      });
    },
  });
}

/**
 * Every VFS call carries an Authorization header, so without a cached
 * preflight the browser pays an extra OPTIONS round trip per operation.
 * Browsers cap this (Chromium at 2h, Firefox at 24h).
 */
const PREFLIGHT_MAX_AGE_SECONDS = '600';

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
      res.setHeader('Access-Control-Max-Age', PREFLIGHT_MAX_AGE_SECONDS);
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
        res.setHeader('Access-Control-Max-Age', PREFLIGHT_MAX_AGE_SECONDS);
        res.status(204).end();
        return;
      }
    }
  }

  next();
}
