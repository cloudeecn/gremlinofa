import express, { Router, type ErrorRequestHandler, type Request, type Response } from 'express';
import crypto from 'crypto';
import * as db from './db.js';
import { classifyError, HttpError, type ClassifiedError } from './httpErrors.js';
import type { PollRegistry } from './pollManager.js';
import type { Session, SessionListEntry } from './types.js';
import {
  clearSessionCookie,
  createLoginLimiter,
  createPasswordCheck,
  createRequireWebAuth,
  deriveCookieKey,
  issueSessionCookie,
  loginClientKey,
  parseReturnTo,
  rejectCrossOriginWrites,
  webSecurityHeaders,
} from './webAuth.js';
import {
  chatPage,
  chatState,
  chatStatusHtml,
  errorPage,
  loginPage,
  messagesFragment,
  sessionListFragment,
  sessionListPage,
  undeliveredAnswerHtml,
  webRootFor,
  type Banner,
} from './webViews.js';

/** Long pasted answers are fine; this only stops absurd bodies. */
const ANSWER_BODY_LIMIT = '1mb';
const LOGIN_BODY_LIMIT = '16kb';

export interface WebRouterOptions {
  webPassword: string;
  /** Directory served at /web/static. */
  staticDir: string;
  /** Answers and deletes wake the API's long-polls through it. */
  polls: PollRegistry;
}

function genId(): string {
  return crypto.randomBytes(16).toString('hex');
}

function formField(req: Request, name: string): string | undefined {
  const value: unknown = (req.body as Record<string, unknown> | undefined)?.[name];
  return typeof value === 'string' ? value : undefined;
}

function sendHtml(res: Response, status: number, html: string): void {
  res.status(status).type('html').send(html);
}

function sessionGonePage(base: string): string {
  return errorPage({
    base,
    title: 'Session not found',
    message: 'This session no longer exists. It may have been deleted.',
  });
}

/**
 * Ids of the questions waiting for the human, leaving out one session's. app.js alerts when an
 * id it hasn't seen shows up, which a count would miss when one question replaces another.
 */
function pendingRequestIds(sessions: SessionListEntry[], exceptSessionId?: string): string[] {
  return sessions.flatMap(session =>
    session.pending && session.id !== exceptSessionId ? [session.pending.requestId] : []
  );
}

/** The session list; its fragment links are relative to the list page at the web root. */
function sessionListView() {
  const sessions = db.listSessionsWithPending();
  const listHtml = sessionListFragment(sessions, './');
  return {
    listHtml,
    pendingIds: pendingRequestIds(sessions),
    signature: crypto.createHash('sha256').update(listHtml).digest('hex').slice(0, 16),
  };
}

/** Questions waiting in every session except the one on screen. */
function othersPending(sessionId: string): string[] {
  return pendingRequestIds(db.listSessionsWithPending(), sessionId);
}

function renderChat(
  res: Response,
  status: number,
  base: string,
  session: Session,
  extras: { banner?: Banner; draft?: string } = {}
): void {
  sendHtml(
    res,
    status,
    chatPage({
      base,
      session,
      messages: db.getMessages(session.id),
      state: chatState(
        db.getLatestRequestForSession(session.id),
        db.getLatestMessageForSession(session.id)
      ),
      othersPending: othersPending(session.id),
      ...extras,
    })
  );
}

function parseAfter(raw: unknown): number {
  if (raw === undefined) return 0;
  if (typeof raw !== 'string' || !/^\d{1,9}$/.test(raw)) {
    throw new HttpError(400, 'after must be a non-negative integer');
  }
  return Number(raw);
}

/** classifyError, except body-parser's 413 gets a message that fits the web form limit. */
function classifyWebError(err: unknown): ClassifiedError {
  if ((err as { type?: unknown } | null)?.type === 'entity.too.large') {
    return { status: 413, message: 'That form is too large. Answers are limited to 1 MB of text.' };
  }
  return classifyError(err);
}

/** HTML for pages, JSON under /api/. */
const webErrorHandler: ErrorRequestHandler = (err, req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }
  const { status, message } = classifyWebError(err);
  if (status >= 500) {
    console.error(`Web ${req.method} ${req.originalUrl} failed:`, err);
  }
  if (req.path.startsWith('/api/')) {
    res.status(status).json({ error: message });
    return;
  }
  sendHtml(
    res,
    status,
    errorPage({
      base: webRootFor(req.path),
      title: status === 404 ? 'Not found' : 'Error',
      message,
    })
  );
};

/**
 * The human operator UI, mounted at /web. Order matters: headers apply to everything,
 * static assets and the login/logout routes are public, everything after requireAuth is not.
 * Login parses its own small form before any cookie check; answer and delete form bodies are
 * only parsed after requireAuth.
 */
export function createWebRouter({ webPassword, staticDir, polls }: WebRouterOptions): Router {
  const router = Router();
  const loginLimiter = createLoginLimiter();
  const cookieKey = deriveCookieKey(webPassword);
  const passwordMatches = createPasswordCheck(webPassword);

  router.use(webSecurityHeaders);

  // '/web' and '/web/' both land here; only the slash-less one needs bouncing, since every
  // relative URL on the page assumes the browser is inside the web/ directory.
  router.use((req, res, next) => {
    const pathname = req.originalUrl.split('?')[0];
    if (req.path === '/' && !pathname.endsWith('/')) {
      res.redirect(302, 'web/');
      return;
    }
    next();
  });

  router.use('/static', express.static(staticDir, { index: false, fallthrough: false }));

  router.use((_req, res, next) => {
    // Pages hold the conversation; keep them out of shared caches and the disk cache.
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  router.use(rejectCrossOriginWrites);

  // ── Public: login and logout ──

  router.get('/login', (req, res) => {
    sendHtml(
      res,
      200,
      loginPage({ base: webRootFor(req.path), returnTo: parseReturnTo(req.query.next) })
    );
  });

  router.post(
    '/login',
    express.urlencoded({ extended: false, limit: LOGIN_BODY_LIMIT }),
    (req, res) => {
      const base = webRootFor(req.path);
      const returnTo = parseReturnTo(formField(req, 'next'));
      const clientKey = loginClientKey(req.ip);

      const sendLocked = (seconds: number) => {
        res.setHeader('Retry-After', String(seconds));
        sendHtml(
          res,
          429,
          loginPage({
            base,
            returnTo,
            banner: {
              kind: 'error',
              html: `Too many wrong passwords. Wait ${seconds} second${seconds === 1 ? '' : 's'} before trying again.`,
            },
          })
        );
      };

      const lockedFor = loginLimiter.lockedFor(clientKey);
      if (lockedFor > 0) {
        sendLocked(lockedFor);
        return;
      }
      if (!passwordMatches(formField(req, 'password'))) {
        const lockSeconds = loginLimiter.recordFailure(clientKey);
        if (lockSeconds > 0) {
          sendLocked(lockSeconds);
          return;
        }
        sendHtml(
          res,
          401,
          loginPage({ base, returnTo, banner: { kind: 'error', html: 'Wrong password.' } })
        );
        return;
      }

      loginLimiter.recordSuccess(clientKey);
      issueSessionCookie(req, res, cookieKey);
      res.redirect(303, `${base}${returnTo}`);
    }
  );

  router.post('/logout', (req, res) => {
    clearSessionCookie(req, res);
    res.redirect(303, `${webRootFor(req.path)}login`);
  });

  // ── Everything below needs the cookie ──

  router.use(createRequireWebAuth(cookieKey));
  router.use(express.urlencoded({ extended: false, limit: ANSWER_BODY_LIMIT }));

  router.get('/', (req, res) => {
    sendHtml(res, 200, sessionListPage({ base: webRootFor(req.path), ...sessionListView() }));
  });

  router.get('/sessions/:id', (req, res) => {
    const base = webRootFor(req.path);
    const session = db.getSession(req.params.id);
    if (!session) {
      sendHtml(res, 404, sessionGonePage(base));
      return;
    }
    renderChat(res, 200, base, session);
  });

  router.post('/sessions/:id/respond', (req, res) => {
    const base = webRootFor(req.path);
    const session = db.getSession(req.params.id);
    if (!session) {
      sendHtml(res, 404, sessionGonePage(base));
      return;
    }

    // Browsers submit textarea line breaks as CRLF; the AI should see plain \n.
    const draft = (formField(req, 'content') ?? '').replace(/\r\n?/g, '\n');
    const requestId = formField(req, 'requestId') ?? '';
    if (draft.trim() === '') {
      renderChat(res, 400, base, session, {
        banner: { kind: 'error', html: 'Your answer is empty. Type something before sending.' },
        draft,
      });
      return;
    }

    // The answer goes to the question the human was looking at, never to whatever happens to
    // be pending now: answerRequest only takes it while that exact request is still pending.
    const result = db.answerRequest({
      requestId,
      sessionId: session.id,
      messageId: genId(),
      content: draft,
    });
    if (!result.answered) {
      renderChat(res, 409, base, session, {
        banner: { kind: 'warn', html: undeliveredAnswerHtml(requestId, result.request) },
        draft,
      });
      return;
    }

    polls.notifyAnswered(requestId, draft);
    // `sent` tells app.js the answer landed, so it can drop the draft it kept for this send.
    res.redirect(303, `${base}sessions/${session.id}?sent=${encodeURIComponent(requestId)}`);
  });

  router.post('/sessions/:id/delete', (req, res) => {
    for (const requestId of db.deleteSession(req.params.id) ?? []) {
      polls.notifyGone(requestId);
    }
    // Already gone (double click, another tab) lands on the list too.
    res.redirect(303, webRootFor(req.path));
  });

  // ── JSON for app.js polling ──

  router.get('/api/sessions', (_req, res) => {
    const { listHtml, pendingIds, signature } = sessionListView();
    res.json({ html: listHtml, pendingIds, signature });
  });

  router.get('/api/sessions/:id/updates', (req, res) => {
    const session = db.getSession(req.params.id);
    if (!session) {
      throw new HttpError(404, 'Session not found');
    }
    const after = parseAfter(req.query.after);
    const messages = db.getMessagesAfter(session.id, after);
    const state = chatState(
      db.getLatestRequestForSession(session.id),
      db.getLatestMessageForSession(session.id)
    );
    res.json({
      html: messagesFragment(messages),
      count: after + messages.length,
      pending: state.pending,
      othersPending: othersPending(session.id),
      statusHtml: chatStatusHtml(state),
    });
  });

  router.use((req, res) => {
    if (req.path.startsWith('/api/')) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    sendHtml(
      res,
      404,
      errorPage({
        base: webRootFor(req.path),
        title: 'Not found',
        message: 'Nothing lives at this address.',
      })
    );
  });
  router.use(webErrorHandler);

  return router;
}
