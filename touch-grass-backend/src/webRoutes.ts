import express, {
  Router,
  type ErrorRequestHandler,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';
import crypto from 'crypto';
import * as db from './db.js';
import { classifyError, HttpError, type ClassifiedError } from './httpErrors.js';
import { createAuthFailureLimiter } from './middleware.js';
import {
  generateUserToken,
  hashPassword,
  passwordProblem,
  sameUsername,
  usernameProblem,
  verifyPassword,
} from './passwords.js';
import type { PollRegistry } from './pollManager.js';
import type { Session, SessionListEntry, SessionScope, User } from './types.js';
import {
  ADMIN_PRINCIPAL_ID,
  adminBinding,
  clearSessionCookie,
  createLoginLimiter,
  createLoginQueue,
  createPasswordCheck,
  createRequireWebAuth,
  deriveCookieKey,
  issueSessionCookie,
  loginClientKey,
  parseReturnTo,
  principalIdOf,
  rejectCrossOriginWrites,
  userBinding,
  webSecurityHeaders,
  type LoginTarget,
  type ResolvedPrincipal,
  type WebPrincipal,
} from './webAuth.js';
import {
  accountPage,
  adminPage,
  chatPage,
  chatState,
  chatStatusHtml,
  errorPage,
  escapeHtml,
  loginPage,
  messagesFragment,
  sessionListFragment,
  sessionListPage,
  undeliveredAnswerHtml,
  webRootFor,
  type AdminFormState,
  type Banner,
} from './webViews.js';

/** Long pasted answers are fine; this only stops absurd bodies. */
const ANSWER_BODY_LIMIT = '1mb';
const LOGIN_BODY_LIMIT = '16kb';

const USER_ID_PATTERN = /^[0-9a-f]{32}$/;

/** `?done=` on the admin page after a change that leaves nothing new to look at. */
const ADMIN_NOTICES = new Map([
  ['renamed', 'Renamed. The user stays signed in under the new name.'],
  [
    'password-reset',
    'Password reset. The user is signed out everywhere until they use the new one.',
  ],
  ['deleted', 'User deleted. Their sessions stay, and only you see them now.'],
]);

export interface WebRouterOptions {
  /** The admin's password. */
  webPassword: string;
  /** The admin's sign-in name (WEB_ADMIN_USERNAME), matched regardless of case. */
  webAdminUsername: string;
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

function errorBanner(message: string): Banner {
  return { kind: 'error', html: escapeHtml(message) };
}

function lockedMessage(seconds: number): string {
  return `Too many wrong passwords. Wait ${seconds} second${seconds === 1 ? '' : 's'} before trying again.`;
}

function sessionGonePage(base: string): string {
  return errorPage({
    base,
    title: 'Session not found',
    message: 'This session no longer exists. It may have been deleted.',
  });
}

/** The generic 404, also what a user gets for the admin's pages. */
function sendNotFound(req: Request, res: Response): void {
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
}

function userPrincipal(user: User): ResolvedPrincipal {
  return {
    principal: { role: 'user', id: user.id, username: user.username, token: user.token },
    binding: userBinding(user.passwordHash),
  };
}

/** Who sent the request. Only for routes registered after requireWebAuth, which sets it. */
function viewer(req: Request): WebPrincipal {
  if (!req.webUser) {
    throw new Error('Web route registered before requireWebAuth');
  }
  return req.webUser;
}

function scopeOf(principal: WebPrincipal): SessionScope {
  return principal.role === 'admin' ? { kind: 'all' } : { kind: 'user', token: principal.token };
}

/**
 * The session, when `principal` may see it. Routes answer an invisible session exactly like a
 * missing one, so nobody can probe for the ids of sessions in other inboxes.
 */
function getVisibleSession(principal: WebPrincipal, id: string): Session | undefined {
  const session = db.getSession(id);
  if (!session) return undefined;
  return principal.role === 'admin' || session.userToken === principal.token ? session : undefined;
}

/** Attached per route: router.use('/admin', …) would strip the prefix webRootFor reads. */
const requireAdmin: RequestHandler = (req, res, next) => {
  if (viewer(req).role === 'admin') {
    next();
    return;
  }
  sendNotFound(req, res);
};

/**
 * Ids of the questions waiting for the human, leaving out one session's. app.js alerts when an
 * id it hasn't seen shows up, which a count would miss when one question replaces another.
 */
function pendingRequestIds(sessions: SessionListEntry[], exceptSessionId?: string): string[] {
  return sessions.flatMap(session =>
    session.pending && session.id !== exceptSessionId ? [session.pending.requestId] : []
  );
}

/**
 * The sessions `principal` may see. Its fragment links are relative to the list page at the web
 * root, and the signature hashes the scoped markup, so it changes only with what this viewer sees.
 */
function sessionListView(principal: WebPrincipal) {
  const sessions = db.listSessionsWithPending(scopeOf(principal));
  const listHtml = sessionListFragment(sessions, './', { showOwner: principal.role === 'admin' });
  return {
    listHtml,
    pendingIds: pendingRequestIds(sessions),
    signature: crypto.createHash('sha256').update(listHtml).digest('hex').slice(0, 16),
  };
}

/** Questions waiting in every session `scope` covers, except the one on screen. */
function othersPending(scope: SessionScope, sessionId: string): string[] {
  return pendingRequestIds(db.listSessionsWithPending(scope), sessionId);
}

function ownerUsername(session: Session): string | null {
  return session.userToken === null
    ? null
    : (db.getUserByToken(session.userToken)?.username ?? null);
}

function renderChat(
  res: Response,
  status: number,
  base: string,
  principal: WebPrincipal,
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
      othersPending: othersPending(scopeOf(principal), session.id),
      ...(principal.role === 'admin' && { owner: ownerUsername(session) }),
      ...extras,
    })
  );
}

function renderAdmin(
  res: Response,
  status: number,
  base: string,
  extras: { banner?: Banner; created?: User; form?: AdminFormState } = {}
): void {
  sendHtml(res, status, adminPage({ base, report: db.listUserStats(), ...extras }));
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
    console.error('Web %s %s failed:', req.method, req.originalUrl, err);
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
 * Login parses its own small form before any cookie check; every other form body is only
 * parsed after requireAuth.
 */
export function createWebRouter({
  webPassword,
  webAdminUsername,
  staticDir,
  polls,
}: WebRouterOptions): Router {
  const router = Router();
  const loginLimiter = createLoginLimiter();
  const loginQueue = createLoginQueue();
  const cookieKey = deriveCookieKey(webPassword);
  const adminPasswordMatches = createPasswordCheck(webPassword);
  const admin: ResolvedPrincipal = {
    principal: { role: 'admin', username: webAdminUsername },
    binding: adminBinding(webAdminUsername),
  };

  function resolvePrincipal(principalId: string): ResolvedPrincipal | undefined {
    if (principalId === ADMIN_PRINCIPAL_ID) return admin;
    const user = db.getUserById(principalId);
    return user && userPrincipal(user);
  }

  /**
   * The password a login name is checked against. The admin's name never reaches the users
   * table, so a user who has it can't sign in (index.ts warns at boot).
   */
  function loginTargetFor(username: string): LoginTarget {
    return sameUsername(username, webAdminUsername)
      ? { role: 'admin' }
      : { role: 'user', username };
  }

  /** Who these credentials sign in, or null. Both paths cost one scrypt. */
  async function checkSignIn(
    target: LoginTarget,
    password: string
  ): Promise<ResolvedPrincipal | null> {
    if (target.role === 'admin') {
      // WEB_PASSWORD isn't hashed; the dummy scrypt keeps this path as slow as a user's, so
      // timing doesn't tell which name is the admin's.
      await verifyPassword(password, undefined);
      return adminPasswordMatches(password) ? admin : null;
    }
    const user = db.getUserByUsername(target.username);
    // An unknown name still runs scrypt, against a dummy salt.
    const matches = await verifyPassword(password, user?.passwordHash);
    return matches && user ? userPrincipal(user) : null;
  }

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
  // A cap on wrong passwords and cookieless /api polls, on top of the login backoff below,
  // whose own 429s don't count toward it.
  router.use(
    createAuthFailureLimiter((req, res, seconds) => {
      const minutes = Math.ceil(seconds / 60);
      const message = `Too many failed sign-ins from your address. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`;
      if (req.path.startsWith('/api/')) {
        res.status(429).json({ error: message });
        return;
      }
      sendHtml(
        res,
        429,
        errorPage({ base: webRootFor(req.path), title: 'Too many attempts', message })
      );
    })
  );

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
    async (req, res) => {
      const base = webRootFor(req.path);
      const returnTo = parseReturnTo(formField(req, 'next'));
      const username = (formField(req, 'username') ?? '').trim();
      const target = loginTargetFor(username);
      const clientKey = loginClientKey(req.ip);

      const refuse = (status: number, message: string) => {
        sendHtml(
          res,
          status,
          loginPage({ base, returnTo, username, banner: errorBanner(message) })
        );
      };
      const refuseLocked = (seconds: number) => {
        res.setHeader('Retry-After', String(seconds));
        refuse(429, lockedMessage(seconds));
      };

      await loginQueue.run(clientKey, async () => {
        const lockedFor = loginLimiter.lockedFor(clientKey);
        if (lockedFor > 0) {
          refuseLocked(lockedFor);
          return;
        }
        const signedIn = await checkSignIn(target, formField(req, 'password') ?? '');
        if (!signedIn) {
          const lockSeconds = loginLimiter.recordFailure(clientKey, target);
          if (lockSeconds > 0) {
            refuseLocked(lockSeconds);
          } else {
            refuse(401, 'Wrong username or password.');
          }
          return;
        }

        loginLimiter.recordSuccess(clientKey, target);
        const { principal, binding } = signedIn;
        issueSessionCookie(req, res, cookieKey, principalIdOf(principal), binding);
        // Only the admin has an admin page; anyone else asking for it gets the session list.
        const landing = returnTo === 'admin' && principal.role !== 'admin' ? '' : returnTo;
        res.redirect(303, `${base}${landing}`);
      });
    }
  );

  router.post('/logout', (req, res) => {
    clearSessionCookie(req, res);
    res.redirect(303, `${webRootFor(req.path)}login`);
  });

  // ── Everything below needs the cookie ──

  router.use(createRequireWebAuth({ cookieKey, resolve: resolvePrincipal }));
  router.use(express.urlencoded({ extended: false, limit: ANSWER_BODY_LIMIT }));

  router.get('/', (req, res) => {
    const principal = viewer(req);
    sendHtml(
      res,
      200,
      sessionListPage({
        base: webRootFor(req.path),
        viewer: principal,
        ...sessionListView(principal),
      })
    );
  });

  router.get('/sessions/:id', (req, res) => {
    const base = webRootFor(req.path);
    const principal = viewer(req);
    const session = getVisibleSession(principal, req.params.id);
    if (!session) {
      sendHtml(res, 404, sessionGonePage(base));
      return;
    }
    renderChat(res, 200, base, principal, session);
  });

  router.post('/sessions/:id/respond', (req, res) => {
    const base = webRootFor(req.path);
    const principal = viewer(req);
    const session = getVisibleSession(principal, req.params.id);
    if (!session) {
      sendHtml(res, 404, sessionGonePage(base));
      return;
    }

    // Browsers submit textarea line breaks as CRLF; the AI should see plain \n.
    const draft = (formField(req, 'content') ?? '').replace(/\r\n?/g, '\n');
    const requestId = formField(req, 'requestId') ?? '';
    if (draft.trim() === '') {
      renderChat(res, 400, base, principal, session, {
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
      renderChat(res, 409, base, principal, session, {
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
    // Visibility first: a session in someone else's inbox is left alone, and the answer is the
    // same redirect as for one that is already gone (double click, another tab).
    if (getVisibleSession(viewer(req), req.params.id)) {
      for (const requestId of db.deleteSession(req.params.id) ?? []) {
        polls.notifyGone(requestId);
      }
    }
    res.redirect(303, webRootFor(req.path));
  });

  // ── Account ──

  router.get('/account', (req, res) => {
    const banner: Banner | undefined =
      req.query.changed === '1'
        ? {
            kind: 'info',
            html: 'Password changed. Other browsers signed in as you are signed out.',
          }
        : undefined;
    sendHtml(res, 200, accountPage({ base: webRootFor(req.path), viewer: viewer(req), banner }));
  });

  // The form posts to the page's own URL, directly under the web root: the renewed cookie gets
  // no Path, and set from one level deeper it would land beside the old, now dead one.
  router.post('/account', async (req, res) => {
    const principal = viewer(req);
    if (principal.role !== 'user') {
      sendNotFound(req, res);
      return;
    }
    const base = webRootFor(req.path);
    const clientKey = loginClientKey(req.ip);
    const refuse = (status: number, message: string) => {
      sendHtml(res, status, accountPage({ base, viewer: principal, banner: errorBanner(message) }));
    };
    const refuseChangedMeanwhile = () => {
      sendHtml(
        res,
        409,
        errorPage({
          base,
          title: 'Password not changed',
          message:
            'Your password changed while this request was waiting, so this request changed nothing. ' +
            'If you clicked twice, the first click already saved your new password; otherwise ' +
            'another tab, another browser or the admin changed it. Sign in with the newest password.',
        })
      );
    };

    // The current password is a password guess like any other, so it shares the login backoff.
    await loginQueue.run(clientKey, async () => {
      const lockedFor = loginLimiter.lockedFor(clientKey);
      if (lockedFor > 0) {
        res.setHeader('Retry-After', String(lockedFor));
        refuse(429, lockedMessage(lockedFor));
        return;
      }
      const user = db.getUserById(principal.id);
      if (!user) {
        sendNotFound(req, res);
        return;
      }
      // requireWebAuth checked the cookie before this request queued. A change that ran ahead
      // of it (a double submit, another tab) has replaced the hash since, so the current
      // password typed here is the old one and must not count as a wrong guess. The cookie is
      // left alone: the change that ran first may have just given this browser a valid one.
      if (userBinding(user.passwordHash) !== req.webBinding) {
        refuseChangedMeanwhile();
        return;
      }
      // Keyed as this user even when WEB_ADMIN_USERNAME has since moved onto their name, so
      // proving their own password never clears guesses at WEB_PASSWORD.
      const target: LoginTarget = { role: 'user', username: user.username };
      if (!(await verifyPassword(formField(req, 'current') ?? '', user.passwordHash))) {
        const lockSeconds = loginLimiter.recordFailure(clientKey, target);
        if (lockSeconds > 0) {
          res.setHeader('Retry-After', String(lockSeconds));
          refuse(429, lockedMessage(lockSeconds));
        } else {
          refuse(401, 'Your current password is wrong.');
        }
        return;
      }
      loginLimiter.recordSuccess(clientKey, target);

      const password = formField(req, 'password') ?? '';
      const problem = passwordProblem(password);
      if (problem) {
        refuse(400, problem);
        return;
      }
      if (password !== formField(req, 'confirm')) {
        refuse(400, "The new passwords don't match.");
        return;
      }
      const passwordHash = await hashPassword(password);
      // Only over the hash just verified: an admin reset that landed during the two scrypts
      // wins, instead of being overwritten by the password the user picked.
      if (!db.setUserPasswordIfUnchanged(user.id, user.passwordHash, passwordHash)) {
        if (!db.getUserById(user.id)) {
          sendNotFound(req, res);
          return;
        }
        // An admin reset, or a change from another address, which the queue doesn't hold back.
        // This browser's cookie was bound to the replaced hash, so it is dead already.
        clearSessionCookie(req, res);
        refuseChangedMeanwhile();
        return;
      }
      // The new hash is the new binding: this browser gets a cookie for it, every other
      // browser's cookie stops verifying.
      issueSessionCookie(req, res, cookieKey, user.id, userBinding(passwordHash));
      res.redirect(303, `${base}account?changed=1`);
    });
  });

  // ── Users (admin only) ──

  router.get('/admin', requireAdmin, (req, res) => {
    const { created, done } = req.query;
    const createdUser =
      typeof created === 'string' && USER_ID_PATTERN.test(created)
        ? db.getUserById(created)
        : undefined;
    const notice = typeof done === 'string' ? ADMIN_NOTICES.get(done) : undefined;
    renderAdmin(res, 200, webRootFor(req.path), {
      created: createdUser,
      banner: notice === undefined ? undefined : { kind: 'info', html: escapeHtml(notice) },
    });
  });

  router.post('/admin/users', requireAdmin, async (req, res) => {
    const base = webRootFor(req.path);
    const username = (formField(req, 'username') ?? '').trim();
    const password = formField(req, 'password') ?? '';
    const refuse = (status: number, message: string) => {
      renderAdmin(res, status, base, {
        banner: errorBanner(message),
        form: { newUsername: username },
      });
    };

    const problem = usernameProblem(username, webAdminUsername) ?? passwordProblem(password);
    if (problem) {
      refuse(400, problem);
      return;
    }
    // Checked before hashing so a taken name doesn't cost a scrypt; createUser checks again.
    const taken = `The name ${username} is taken. Usernames ignore letter case.`;
    if (db.getUserByUsername(username)) {
      refuse(409, taken);
      return;
    }
    const user = db.createUser({
      id: genId(),
      username,
      passwordHash: await hashPassword(password),
      token: generateUserToken(),
    });
    if (!user) {
      refuse(409, taken);
      return;
    }
    res.redirect(303, `${base}admin?created=${user.id}`);
  });

  /** The :id of an /admin/users/:id route, or undefined after sending the generic 404. */
  function adminUserId(req: Request, res: Response): string | undefined {
    const userId = req.params.id;
    if (typeof userId === 'string' && USER_ID_PATTERN.test(userId)) return userId;
    sendNotFound(req, res);
    return undefined;
  }

  const userGone = 'That user no longer exists.';

  router.post('/admin/users/:id/rename', requireAdmin, (req, res) => {
    const userId = adminUserId(req, res);
    if (userId === undefined) return;
    const base = webRootFor(req.path);
    const username = (formField(req, 'username') ?? '').trim();
    const refuse = (status: number, message: string) => {
      renderAdmin(res, status, base, {
        banner: errorBanner(message),
        form: { userId, rename: username },
      });
    };

    const problem = usernameProblem(username, webAdminUsername);
    if (problem) {
      refuse(400, problem);
      return;
    }
    // The cookie binding is the password hash, not the name, so the user stays signed in.
    const outcome = db.renameUser(userId, username);
    if (outcome === 'taken') {
      refuse(409, `The name ${username} is taken. Usernames ignore letter case.`);
      return;
    }
    if (outcome === 'missing') {
      refuse(404, userGone);
      return;
    }
    res.redirect(303, `${base}admin?done=renamed`);
  });

  router.post('/admin/users/:id/password', requireAdmin, async (req, res) => {
    const userId = adminUserId(req, res);
    if (userId === undefined) return;
    const base = webRootFor(req.path);
    const refuse = (status: number, message: string) => {
      renderAdmin(res, status, base, { banner: errorBanner(message), form: { userId } });
    };

    const password = formField(req, 'password') ?? '';
    const problem = passwordProblem(password);
    if (problem) {
      refuse(400, problem);
      return;
    }
    if (!db.getUserById(userId)) {
      refuse(404, userGone);
      return;
    }
    // A new hash is a new cookie binding, which signs the user out everywhere.
    if (!db.setUserPassword(userId, await hashPassword(password))) {
      refuse(404, userGone);
      return;
    }
    res.redirect(303, `${base}admin?done=password-reset`);
  });

  router.post('/admin/users/:id/delete', requireAdmin, (req, res) => {
    const userId = adminUserId(req, res);
    if (userId === undefined) return;
    const base = webRootFor(req.path);
    // The sessions' foreign key sets their token to NULL, so they stay, admin-only. Their
    // requests are untouched, so held API polls keep waiting.
    if (!db.deleteUser(userId)) {
      renderAdmin(res, 404, base, { banner: errorBanner(userGone) });
      return;
    }
    res.redirect(303, `${base}admin?done=deleted`);
  });

  // ── JSON for app.js polling ──

  router.get('/api/sessions', (req, res) => {
    const { listHtml, pendingIds, signature } = sessionListView(viewer(req));
    res.json({ html: listHtml, pendingIds, signature });
  });

  router.get('/api/sessions/:id/updates', (req, res) => {
    const principal = viewer(req);
    const session = getVisibleSession(principal, req.params.id);
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
      othersPending: othersPending(scopeOf(principal), session.id),
      statusHtml: chatStatusHtml(state),
    });
  });

  router.use(sendNotFound);
  router.use(webErrorHandler);

  return router;
}
