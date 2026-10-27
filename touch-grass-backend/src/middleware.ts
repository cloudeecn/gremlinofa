import type { Request, RequestHandler, Response } from 'express';
import { rateLimit, type RateLimitInfo } from 'express-rate-limit';
import type { CorsOrigins } from './config.js';
import crypto from 'crypto';

declare module 'express-serve-static-core' {
  interface Request {
    callerId?: string;
  }
}

function sha256(text: string): Buffer {
  return crypto.createHash('sha256').update(text, 'utf8').digest();
}

/**
 * Basic Auth for /api. Username is a free-form caller label (recorded, not an identity);
 * password must equal API_PASSWORD. Credentials are decoded as UTF-8.
 */
export function createApiAuth(apiPassword: string): RequestHandler {
  // Comparing fixed-length digests keeps timingSafeEqual from leaking the password length.
  const expectedDigest = sha256(apiPassword);

  return (req, res, next) => {
    const match = /^Basic\s+(\S+)\s*$/i.exec(req.headers.authorization ?? '');
    if (!match) {
      res.status(401).json({ error: 'Authorization required' });
      return;
    }

    const credentials = Buffer.from(match[1], 'base64').toString('utf8');
    const colonIdx = credentials.indexOf(':');
    if (colonIdx === -1) {
      res.status(401).json({ error: 'Invalid credentials format' });
      return;
    }

    const callerId = credentials.slice(0, colonIdx);
    if (!callerId) {
      res.status(401).json({ error: 'Missing caller ID' });
      return;
    }
    if (!crypto.timingSafeEqual(sha256(credentials.slice(colonIdx + 1)), expectedDigest)) {
      res.status(401).json({ error: 'Invalid password' });
      return;
    }

    req.callerId = callerId;
    next();
  };
}

export const AUTH_FAILURE_LIMIT = 100;
const AUTH_FAILURE_WINDOW_MS = 15 * 60_000;

/** Sends the 429; `retryAfterSeconds` is already in the Retry-After header. */
export type AuthFailureResponder = (req: Request, res: Response, retryAfterSeconds: number) => void;

/** express-rate-limit puts its counters on the request but doesn't type them there. */
function retryAfterSeconds(req: Request): number {
  const { resetTime } = (req as Request & { rateLimit: RateLimitInfo }).rateLimit;
  const msLeft = resetTime ? resetTime.getTime() - Date.now() : AUTH_FAILURE_WINDOW_MS;
  return Math.max(1, Math.ceil(msLeft / 1000));
}

/**
 * Caps wrong-password guessing: a client address that collects
 * AUTH_FAILURE_LIMIT 401s in a window is refused everything until the window
 * ends, the right password included (letting that through would let a guesser
 * keep going). Only 401s count, but express-rate-limit counts a request when it
 * starts and refunds it when it finishes, so requests still in flight (held
 * long-polls among them) count too: the limit has to stay well above a
 * client's concurrency. Each app builds its own, so each gets its own counts.
 */
export function createAuthFailureLimiter(respond: AuthFailureResponder): RequestHandler {
  return rateLimit({
    windowMs: AUTH_FAILURE_WINDOW_MS,
    limit: AUTH_FAILURE_LIMIT,
    skipSuccessfulRequests: true,
    requestWasSuccessful: (_req, res) => res.statusCode !== 401,
    standardHeaders: false,
    legacyHeaders: false,
    // config.ts already warns about TRUST_PROXY=true at boot.
    validate: { trustProxy: false },
    handler: (req, res) => {
      const seconds = retryAfterSeconds(req);
      res.setHeader('Retry-After', String(seconds));
      respond(req, res, seconds);
    },
  });
}

const CORS_PREFLIGHT_MAX_AGE_SECONDS = 600;

/**
 * CORS for /api and /health. The API authenticates with an explicit Authorization header, not
 * cookies, so credentials are never granted. Every OPTIONS request ends here with 204 so a
 * preflight never reaches apiAuth; it carries CORS headers only for an allowed origin.
 */
export function createCors(origins: CorsOrigins): RequestHandler {
  return (req, res, next) => {
    let allowOrigin: string | null = null;
    if (origins === '*') {
      allowOrigin = '*';
    } else if (origins) {
      res.vary('Origin');
      const requestOrigin = req.headers.origin;
      if (requestOrigin && origins.includes(requestOrigin)) {
        allowOrigin = requestOrigin;
      }
    }

    if (allowOrigin) {
      res.setHeader('Access-Control-Allow-Origin', allowOrigin);
    }

    if (req.method === 'OPTIONS') {
      if (allowOrigin) {
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
        res.setHeader('Access-Control-Max-Age', String(CORS_PREFLIGHT_MAX_AGE_SECONDS));
      }
      res.status(204).end();
      return;
    }

    next();
  };
}
