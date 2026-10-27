import { Router, type ErrorRequestHandler, type Request, type RequestHandler } from 'express';
import crypto from 'crypto';
import * as db from './db.js';
import { classifyError, HttpError } from './httpErrors.js';
import type { PollRegistry } from './pollManager.js';
import type { ExpireReason, InjectedFile, RequestRecord } from './types.js';

const DISPLAY_NAME_MAX_LENGTH = 200;
const FILES_MAX_COUNT = 200;
const TIMEOUT_MS_MIN = 1000;
const TIMEOUT_MS_MAX = 7 * 24 * 60 * 60 * 1000;
/**
 * A poll clamped to a request's deadline sleeps this much past it, so the re-read lands after
 * expiresAt (and reports expired) instead of a timer tick before it (and reporting pending).
 */
const EXPIRY_GRACE_MS = 25;

function genId(): string {
  return crypto.randomBytes(16).toString('hex');
}

function jsonBody(req: Request): Record<string, unknown> {
  const body: unknown = req.body;
  if (body === undefined) {
    return {};
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new HttpError(400, 'Request body must be a JSON object');
  }
  return body as Record<string, unknown>;
}

function parseDisplayName(raw: unknown): string | null {
  if (raw === undefined || raw === null) {
    return null;
  }
  if (typeof raw !== 'string') {
    throw new HttpError(400, 'displayName must be a string or null');
  }
  const trimmed = raw.trim();
  if (trimmed.length > DISPLAY_NAME_MAX_LENGTH) {
    throw new HttpError(400, `displayName must be at most ${DISPLAY_NAME_MAX_LENGTH} characters`);
  }
  return trimmed || null;
}

function parseFiles(raw: unknown): InjectedFile[] {
  if (raw === undefined) {
    return [];
  }
  if (!Array.isArray(raw)) {
    throw new HttpError(400, 'files must be an array');
  }
  if (raw.length > FILES_MAX_COUNT) {
    throw new HttpError(400, `files must have at most ${FILES_MAX_COUNT} entries`);
  }
  return raw.map((entry: unknown, index): InjectedFile => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new HttpError(400, `files[${index}] must be an object`);
    }
    const { path, content, placement, lineNumbers } = entry as Record<string, unknown>;
    if (typeof path !== 'string' || path.trim() === '') {
      throw new HttpError(400, `files[${index}].path must be a non-empty string`);
    }
    if (typeof content !== 'string') {
      throw new HttpError(400, `files[${index}].content must be a string`);
    }
    if (placement !== undefined && placement !== 'before' && placement !== 'after') {
      throw new HttpError(400, `files[${index}].placement must be 'before' or 'after'`);
    }
    if (lineNumbers !== undefined && typeof lineNumbers !== 'boolean') {
      throw new HttpError(400, `files[${index}].lineNumbers must be a boolean`);
    }
    return {
      path,
      content,
      placement: placement ?? 'before',
      ...(lineNumbers === true && { lineNumbers: true }),
    };
  });
}

function parseTimeoutMs(raw: unknown): number | null {
  if (raw === undefined) {
    return null;
  }
  if (
    typeof raw !== 'number' ||
    !Number.isInteger(raw) ||
    raw < TIMEOUT_MS_MIN ||
    raw > TIMEOUT_MS_MAX
  ) {
    throw new HttpError(
      400,
      `timeoutMs must be an integer between ${TIMEOUT_MS_MIN} and ${TIMEOUT_MS_MAX}`
    );
  }
  return raw;
}

function parseAwaitReply(raw: unknown): boolean {
  if (raw === undefined) {
    return true;
  }
  if (typeof raw !== 'boolean') {
    throw new HttpError(400, 'awaitReply must be a boolean');
  }
  return raw;
}

function parseWaitMs(raw: unknown, maxWaitMs: number): number {
  if (raw === undefined) {
    return maxWaitMs;
  }
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
    throw new HttpError(400, 'waitMs must be a non-negative integer');
  }
  return Math.min(Number(raw), maxWaitMs);
}

type RequestState =
  | { status: 'pending'; expiresAt: string | null }
  | { status: 'answered'; response: { content: string } }
  | { status: 'expired'; reason: ExpireReason };

function describeRequestState(request: RequestRecord): RequestState {
  switch (request.status) {
    case 'pending':
      return { status: 'pending', expiresAt: request.expiresAt };
    case 'answered': {
      const answer = request.responseMessageId ? db.getMessage(request.responseMessageId) : null;
      return { status: 'answered', response: { content: answer?.content ?? '' } };
    }
    case 'expired':
      // The migration backfills v1 rows, so a missing reason means a superseded v1 request.
      return { status: 'expired', reason: request.expireReason ?? 'superseded' };
  }
}

export interface ApiRouterOptions {
  /** Upper bound on one poll hold; a client's `waitMs` is clamped to it. */
  pollTimeoutMs: number;
  polls: PollRegistry;
}

export function createApiRouter({ pollTimeoutMs, polls }: ApiRouterOptions): Router {
  const router = Router();

  router.post('/sessions', (req, res) => {
    const displayName = parseDisplayName(jsonBody(req).displayName);
    const session = db.createSession(genId(), req.callerId!, displayName);
    res.status(201).json({ sessionId: session.id });
  });

  router.get('/sessions/:id', (req, res) => {
    const session = db.getSession(req.params.id);
    if (!session) {
      throw new HttpError(404, 'Session not found');
    }
    const pending = db.getPendingRequestForSession(session.id);
    res.json({
      session,
      messages: db.getMessages(session.id),
      pendingRequest: pending ? { requestId: pending.id, expiresAt: pending.expiresAt } : null,
    });
  });

  router.delete('/sessions/:id', (req, res) => {
    const removedRequestIds = db.deleteSession(req.params.id);
    if (!removedRequestIds) {
      throw new HttpError(404, 'Session not found');
    }
    for (const requestId of removedRequestIds) {
      polls.notifyGone(requestId);
    }
    res.json({ deleted: true });
  });

  router.post('/sessions/:id/message', (req, res) => {
    const body = jsonBody(req);
    if (typeof body.content !== 'string') {
      throw new HttpError(400, 'content is required and must be a string');
    }
    const files = parseFiles(body.files);
    const timeoutMs = parseTimeoutMs(body.timeoutMs);
    const awaitReply = parseAwaitReply(body.awaitReply);
    if (body.content.trim() === '' && files.length === 0) {
      throw new HttpError(400, 'content must contain text unless files are attached');
    }
    if (!awaitReply && timeoutMs !== null) {
      throw new HttpError(400, 'timeoutMs cannot be combined with awaitReply: false');
    }

    const posted = db.postAiMessage({
      sessionId: req.params.id,
      messageId: genId(),
      requestId: awaitReply ? genId() : null,
      content: body.content,
      files,
      timeoutMs,
    });
    if (!posted) {
      throw new HttpError(404, 'Session not found');
    }
    for (const requestId of posted.supersededRequestIds) {
      polls.notifyExpired(requestId, 'superseded');
    }
    res.status(201).json({
      requestId: posted.request?.id ?? null,
      messageId: posted.message.id,
      expiresAt: posted.request?.expiresAt ?? null,
    });
  });

  router.get('/requests/:id/poll', async (req, res) => {
    const waitMs = parseWaitMs(req.query.waitMs, pollTimeoutMs);
    const request = db.getRequest(req.params.id);
    if (!request) {
      throw new HttpError(404, 'Request not found');
    }
    if (request.status !== 'pending') {
      res.json(describeRequestState(request));
      return;
    }

    const msUntilExpiry =
      request.expiresAt === null ? Infinity : Date.parse(request.expiresAt) - Date.now();
    const holdMs = Math.max(0, Math.min(waitMs, msUntilExpiry + EXPIRY_GRACE_MS));
    if (holdMs === 0) {
      res.json(describeRequestState(request));
      return;
    }

    const wait = polls.waitForOutcome(request.id, holdMs);
    let clientGone = false;
    res.on('close', () => {
      clientGone = true;
      wait.cancel();
    });
    const outcome = await wait.promise;
    if (clientGone) {
      return;
    }

    switch (outcome.kind) {
      case 'answered':
        res.json({ status: 'answered', response: { content: outcome.content } });
        return;
      case 'expired':
        res.json({ status: 'expired', reason: outcome.reason });
        return;
      case 'gone':
        throw new HttpError(404, 'Request not found');
      case 'timeout':
      case 'shutdown':
      case 'detached': {
        // A deleted session cascades to its requests, so a missing request covers both.
        const current = db.getRequest(request.id);
        if (!current) {
          throw new HttpError(404, 'Request not found');
        }
        res.json(describeRequestState(current));
        return;
      }
    }
  });

  router.post('/requests/:id/cancel', (req, res) => {
    const result = db.cancelRequest(req.params.id);
    if (!result) {
      throw new HttpError(404, 'Request not found');
    }
    if (result.cancelled) {
      polls.notifyExpired(result.request.id, 'cancelled');
    }
    res.json(describeRequestState(result.request));
  });

  return router;
}

export const apiNotFound: RequestHandler = (_req, res) => {
  res.status(404).json({ error: 'Not found' });
};

/** Terminal handler for /api: always JSON, never a stack trace. */
export const apiErrorHandler: ErrorRequestHandler = (err, req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }
  const { status, message } = classifyError(err);
  if (status >= 500) {
    console.error('API %s %s failed:', req.method, req.originalUrl, err);
  }
  res.status(status).json({ error: message });
};
