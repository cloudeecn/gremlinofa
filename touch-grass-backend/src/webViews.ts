/**
 * HTML rendering for the human web UI. Pure functions: routes gather the data, these turn it
 * into markup. Every interpolated value goes through escapeHtml.
 *
 * URLs are always relative to the page they appear on (`base` is the way back to the web root,
 * e.g. './' or '../'), so the UI works unchanged behind a reverse proxy that mounts it under a
 * path prefix. Pages carry no inline script or style; CSP forbids both.
 */

import { Marked } from 'marked';
import { PASSWORD_MIN_LENGTH, USERNAME_MAX_LENGTH } from './passwords.js';
import type {
  ExpireReason,
  InjectedFile,
  RequestRecord,
  Session,
  SessionListEntry,
  SessionMessage,
  User,
  UserStats,
  UserStatsReport,
} from './types.js';
import type { WebPrincipal } from './webAuth.js';

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * The relative path from a page back to the web root, given the request path inside the /web
 * router: '/' and '/login' → './', '/sessions/abc' → '../', '/sessions/abc/respond' → '../../'.
 * Browsers resolve relative URLs against the directory of the current URL, so each segment
 * after the first is one '../'.
 */
export function webRootFor(routerPath: string): string {
  const depth = routerPath.split('/').length - 2;
  return depth <= 0 ? './' : '../'.repeat(depth);
}

function sessionLabel(session: Pick<Session, 'id' | 'displayName'>): string {
  return session.displayName || `Session ${session.id.slice(0, 8)}`;
}

/** Fallback text inside <time>; app.js swaps in the browser's locale and timezone. */
function utcText(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return `${parsed.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

type TimeStyle = 'absolute' | 'elapsed' | 'countdown';

/** `elapsed` renders as "3m 20s" since the time, `countdown` as the time plus what's left. */
function timeTag(iso: string, style: TimeStyle = 'absolute'): string {
  const marker =
    style === 'elapsed' ? ' data-elapsed' : style === 'countdown' ? ' data-countdown' : '';
  return `<time datetime="${escapeHtml(iso)}"${marker}>${escapeHtml(utcText(iso))}</time>`;
}

export type BannerKind = 'info' | 'warn' | 'error';

export interface Banner {
  kind: BannerKind;
  /** Already-escaped markup. */
  html: string;
}

function bannerBlock(banner: Banner | undefined, id?: string): string {
  const idAttr = id ? ` id="${id}"` : '';
  const kind = banner?.kind ?? 'info';
  return `<div${idAttr} class="banner banner-${kind}" role="alert"${banner ? '' : ' hidden'}>
      <span class="banner-text">${banner?.html ?? ''}</span>
      <button type="button" class="banner-close" aria-label="Dismiss">&times;</button>
    </div>`;
}

interface PageParts {
  title: string;
  base: string;
  /** data-* attributes for <body>; app.js reads its state from them. */
  data: Record<string, string>;
  content: string;
}

function page({ title, base, data, content }: PageParts): string {
  const dataAttrs = Object.entries({ base, ...data })
    .map(([key, value]) => ` data-${key}="${escapeHtml(value)}"`)
    .join('');
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <link rel="icon" type="image/svg+xml" href="${base}static/favicon.svg">
  <link rel="stylesheet" href="${base}static/style.css">
</head>
<body${dataAttrs}>
${content}
<script src="${base}static/app.js"></script>
</body>
</html>`;
}

/**
 * Sound and notification switches, hidden until app.js wires them (sound needs the Web Audio
 * API, notifications a secure context). The sound switch has three states, set by app.js in
 * data-state: on, off, and blocked (on, but the browser holds audio until the next click).
 */
function alertSwitches(): string {
  return `<button type="button" id="sound-toggle" class="secondary-button sound-toggle" data-state="off" hidden>
          <svg class="sound-icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"
            fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M11 5 6 9H3v6h3l5 4z"/>
            <g class="sound-waves"><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/></g>
            <g class="sound-mute"><path d="m16 9 6 6"/><path d="m22 9-6 6"/></g>
          </svg>
          <span class="sound-label">Sound off</span>
        </button>
        <button type="button" id="notify-toggle" class="secondary-button" aria-pressed="false" hidden>Notifications: off</button>`;
}

function titleWithCount(count: number, title: string): string {
  return count > 0 ? `(${count}) ${title}` : title;
}

// ── Login ──

export interface LoginPageOptions {
  base: string;
  /** Validated return target (see parseReturnTo), carried through the form. */
  returnTo: string;
  /** What was typed into the username field, kept after a refused attempt. */
  username?: string;
  banner?: Banner;
}

export function loginPage({ base, returnTo, username = '', banner }: LoginPageOptions): string {
  // After a refused attempt the name is already there, so the cursor goes to the password.
  const focusPassword = username !== '';
  return page({
    title: 'Touch Grass - Log in',
    base,
    data: { page: 'login' },
    content: `<main class="login-container">
    <h1>Touch Grass</h1>
    <p class="subtitle">Remote human minion console</p>
    ${banner ? bannerBlock(banner) : ''}
    <form method="post" action="${base}login">
      <input type="hidden" name="next" value="${escapeHtml(returnTo)}">
      <label for="username" class="visually-hidden">Username</label>
      <input id="username" type="text" name="username" placeholder="Username" value="${escapeHtml(username)}"
        autocomplete="username" autocapitalize="none" spellcheck="false"${focusPassword ? '' : ' autofocus'} required>
      <label for="password" class="visually-hidden">Password</label>
      <input id="password" type="password" name="password" placeholder="Password"
        autocomplete="current-password"${focusPassword ? ' autofocus' : ''} required>
      <button type="submit">Enter</button>
    </form>
  </main>`,
  });
}

// ── Error pages ──

export interface ErrorPageOptions {
  base: string;
  title: string;
  /** Plain text; escaped here. */
  message: string;
}

export function errorPage({ base, title, message }: ErrorPageOptions): string {
  return page({
    title: `Touch Grass - ${title}`,
    base,
    data: { page: 'error' },
    content: `<main class="container">
    <h1>${escapeHtml(title)}</h1>
    <p class="error-message">${escapeHtml(message)}</p>
    <p><a href="${base}" class="back-link">&larr; Sessions</a></p>
  </main>`,
  });
}

// ── Session list ──

/** Whose inbox a session is in, for the admin: `user: bob`, or `no token` for admin-only ones. */
function ownerText(ownerUsername: string | null): string {
  return ownerUsername === null ? 'no token' : `user: ${escapeHtml(ownerUsername)}`;
}

function sessionCard(session: SessionListEntry, base: string, showOwner: boolean): string {
  const label = sessionLabel(session);
  const href = `${base}sessions/${escapeHtml(session.id)}`;
  const { pending } = session;
  const meta = pending
    ? `Waiting ${timeTag(pending.since, 'elapsed')}` +
      (pending.expiresAt ? ` &middot; AI gives up ${timeTag(pending.expiresAt, 'countdown')}` : '')
    : `Last activity ${timeTag(session.lastActivityAt)}`;

  return `<li class="session-card${pending ? ' pending' : ''}">
      <a class="session-link" href="${href}">
        <span class="session-header">
          <span class="session-name">${escapeHtml(label)}</span>
          ${pending ? '<span class="badge">needs answer</span>' : ''}
        </span>
        <span class="session-caller">caller: ${escapeHtml(session.callerId)}${showOwner ? ` &middot; ${ownerText(session.ownerUsername)}` : ''}</span>
        <span class="session-meta">${meta}</span>
      </a>
      <form method="post" action="${href}/delete"
        data-confirm="${escapeHtml(`Delete "${label}" and all its messages?`)}">
        <button type="submit" class="danger-button" aria-label="${escapeHtml(`Delete ${label}`)}">Delete</button>
      </form>
    </li>`;
}

export interface SessionListOptions {
  /** Label each session with its owner. Only the admin sees whose inbox a session is in. */
  showOwner?: boolean;
}

/** The list body. `base` is relative to the session list page (the web root). */
export function sessionListFragment(
  sessions: SessionListEntry[],
  base: string,
  { showOwner = false }: SessionListOptions = {}
): string {
  if (sessions.length === 0) {
    return '<p class="empty">No sessions yet. Waiting for an AI to need a human&hellip;</p>';
  }
  return `<ul class="session-list">
    ${sessions.map(session => sessionCard(session, base, showOwner)).join('\n    ')}
  </ul>`;
}

export interface SessionListPageOptions {
  base: string;
  listHtml: string;
  /** Request ids of the questions waiting for an answer. */
  pendingIds: string[];
  signature: string;
  viewer: WebPrincipal;
}

export function sessionListPage({
  base,
  listHtml,
  pendingIds,
  signature,
  viewer,
}: SessionListPageOptions): string {
  return page({
    title: titleWithCount(pendingIds.length, 'Touch Grass'),
    base,
    data: { page: 'sessions', 'pending-ids': pendingIds.join(' '), signature },
    content: `<main class="container">
    <header class="page-header">
      <div>
        <h1>Touch Grass</h1>
        <p class="subtitle">Sessions</p>
      </div>
      <div class="toolbar">
        ${alertSwitches()}
        <span class="signed-in">Signed in as <strong>${escapeHtml(viewer.username)}</strong></span>
        <a href="${base}account" class="toolbar-link">Account</a>
        ${viewer.role === 'admin' ? `<a href="${base}admin" class="toolbar-link">Users</a>` : ''}
        <form method="post" action="${base}logout" class="inline-form">
          <button type="submit" class="link-button">Log out</button>
        </form>
      </div>
    </header>
    ${bannerBlock(undefined, 'poll-banner')}
    <div id="session-list">
    ${listHtml}
    </div>
  </main>`,
  });
}

// ── Chat ──

/** Bigger files and messages get the raw view only, which keeps page weight and render time in check. */
const MARKDOWN_MAX_CHARS = 200_000;
/** Paths that open in the rendered view; every other file opens raw. */
const MARKDOWN_PATH = /\.(md|markdown|mdx)$/i;
const SAFE_LINK = /^(https?:|mailto:)/i;

/**
 * The AI wrote this markdown, so raw HTML shows as text and links keep only web and mail
 * schemes. Images turn into links: the CSP blocks remote images anyway, and a link doesn't
 * call home when the page loads.
 */
const markdown = new Marked({
  gfm: true,
  renderer: {
    html({ text }) {
      return escapeHtml(text);
    },
    link({ href, title, tokens }) {
      const label = this.parser.parseInline(tokens);
      if (!SAFE_LINK.test(href)) return label;
      const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
      return `<a href="${escapeHtml(href)}"${titleAttr} rel="noopener noreferrer" target="_blank">${label}</a>`;
    },
    image({ href, text }) {
      const label = `image: ${escapeHtml(text || href)}`;
      if (!SAFE_LINK.test(href)) return `[${label}]`;
      return `<a href="${escapeHtml(href)}" rel="noopener noreferrer" target="_blank">[${label}]</a>`;
    },
  },
});

export function renderMarkdown(text: string): string {
  return markdown.parse(text, { async: false });
}

/** Undoes the minion tool's `%6d\t` line-number prefixes; lines without one stay as they are. */
export function stripLineNumbers(content: string): string {
  return content.replace(/^ *\d+\t/gm, '');
}

/** Whether text gets a rendered view next to the raw one. */
function canRender(text: string): boolean {
  return text.trim() !== '' && text.length <= MARKDOWN_MAX_CHARS;
}

/**
 * Flips the raw and rendered views (app.js): the nearest `data-views` element holds both as
 * direct children, marked `data-view="raw"` and `data-view="rendered"`.
 */
function viewToggle(rendered: boolean): string {
  return `<button type="button" class="secondary-button view-toggle" aria-pressed="${rendered}">Render markdown</button>`;
}

/** A collapsible file. Files that can be rendered carry both views. */
function fileBlock(file: InjectedFile): string {
  const lineCount = file.content === '' ? 0 : file.content.split('\n').length;
  const summary = `<summary>${escapeHtml(file.path)} <span class="file-lines">${lineCount} line${lineCount === 1 ? '' : 's'}</span></summary>`;
  const rawCode = `<code>${escapeHtml(file.content)}</code>`;
  if (!canRender(file.content)) {
    return `<details class="file-block">
        ${summary}
        <pre class="file-raw">${rawCode}</pre>
      </details>`;
  }

  const rendered = MARKDOWN_PATH.test(file.path);
  const source = file.lineNumbers ? stripLineNumbers(file.content) : file.content;
  return `<details class="file-block" data-views>
        ${summary}
        <div class="file-toolbar">${viewToggle(rendered)}</div>
        <pre class="file-raw" data-view="raw"${rendered ? ' hidden' : ''}>${rawCode}</pre>
        <div class="file-markdown markdown" data-view="rendered"${rendered ? '' : ' hidden'}>${renderMarkdown(source)}</div>
      </details>`;
}

/** An AI message that opened no request: the AI said something and moved on. */
function isAsyncNote(message: SessionMessage | undefined): boolean {
  return message?.role === 'ai' && !message.awaitsReply;
}

function messageBlock(message: SessionMessage): string {
  const files = message.files ?? [];
  const filesAt = (placement: InjectedFile['placement']) =>
    files
      .filter(file => file.placement === placement)
      .map(fileBlock)
      .join('\n      ');
  // AI messages open rendered. The human's answers show as typed: they wrote them as text.
  const hasViews = message.role === 'ai' && canRender(message.content);
  const rawText = escapeHtml(message.content);
  let contentBlock = '';
  if (hasViews) {
    contentBlock = `<div class="message-content" data-view="raw" hidden>${rawText}</div>
      <div class="message-markdown markdown" data-view="rendered">${renderMarkdown(message.content)}</div>`;
  } else if (message.content !== '') {
    contentBlock = `<div class="message-content">${rawText}</div>`;
  }

  return `<article class="message ${message.role}"${hasViews ? ' data-views' : ''}>
      <header class="message-meta">
        <span class="message-role">${message.role === 'ai' ? 'AI' : 'Human'}</span>
        ${timeTag(message.createdAt)}
        ${isAsyncNote(message) ? '<span class="message-tag">no reply needed</span>' : ''}
        ${hasViews ? viewToggle(true) : ''}
      </header>
      ${filesAt('before')}
      ${contentBlock}
      ${filesAt('after')}
    </article>`;
}

/** Message blocks, in order. Used for the full page and for incremental updates. */
export function messagesFragment(messages: SessionMessage[]): string {
  return messages.map(messageBlock).join('\n    ');
}

export interface ChatState {
  pending: { requestId: string; expiresAt: string | null } | null;
  stoppedWaiting: { at: string; reason: Extract<ExpireReason, 'timeout' | 'cancelled'> } | null;
  /** The newest request in any state; drives the status line. */
  latest: RequestRecord | undefined;
  /** The newest message is an async note: the AI isn't waiting, by design. */
  note: boolean;
}

export function chatState(
  latest: RequestRecord | undefined,
  newestMessage: SessionMessage | undefined
): ChatState {
  const pending =
    latest?.status === 'pending' ? { requestId: latest.id, expiresAt: latest.expiresAt } : null;
  const stoppedReason = latest?.status === 'expired' ? latest.expireReason : null;
  const stoppedWaiting =
    latest && (stoppedReason === 'timeout' || stoppedReason === 'cancelled')
      ? { at: latest.expiredAt ?? latest.expiresAt ?? latest.createdAt, reason: stoppedReason }
      : null;
  return { pending, stoppedWaiting, latest, note: isAsyncNote(newestMessage) };
}

/** The line above the answer box saying what the AI is doing. */
export function chatStatusHtml({ pending, stoppedWaiting, latest, note }: ChatState): string {
  if (pending) {
    return pending.expiresAt
      ? `The AI is waiting for your answer. It gives up ${timeTag(pending.expiresAt, 'countdown')}.`
      : 'The AI is waiting for your answer. No deadline.';
  }
  // Before stoppedWaiting: a question that timed out earlier is old news once a note follows.
  if (note) {
    return 'The AI sent an update that needs no answer. Waiting for its next message.';
  }
  if (stoppedWaiting) {
    const why =
      stoppedWaiting.reason === 'timeout'
        ? 'Its deadline passed'
        : 'It cancelled the question (someone may have hit Stop)';
    return `The AI stopped waiting at ${timeTag(stoppedWaiting.at)}. ${why}, so there is nothing to answer until it sends another message.`;
  }
  if (latest?.status === 'answered') {
    return 'Answer delivered. Waiting for the AI to send another message.';
  }
  return 'Waiting for the AI to send a message.';
}

const PLACEHOLDER_PENDING = 'Type your answer (Ctrl/⌘+Enter sends)';
const PLACEHOLDER_IDLE = 'Nothing to answer right now';

export interface ChatPageOptions {
  base: string;
  session: Session;
  messages: SessionMessage[];
  state: ChatState;
  /** Request ids of the questions waiting in other sessions. */
  othersPending: string[];
  /**
   * For the admin only: the owner's username, or null for a session without a token. Left out,
   * the page says nothing about owners.
   */
  owner?: string | null;
  banner?: Banner;
  /** Text to put back in the answer box, e.g. an answer that could not be delivered. */
  draft?: string;
}

/** Chat preferences. app.js keeps them in localStorage and closes the menu on outside clicks. */
function chatMenu(): string {
  return `<details class="menu" id="chat-menu">
        <summary class="menu-button" title="More options"><span aria-hidden="true">&#8942;</span><span class="visually-hidden">More options</span></summary>
        <div class="menu-panel">
          <label class="menu-item"><input type="checkbox" id="auto-expand-files"> Auto-expand files</label>
        </div>
      </details>`;
}

/** Counts code points, so an emoji is one character. app.js uses the same count and wording. */
function charCountText(text: string): string {
  const count = Array.from(text).length;
  return `${count} character${count === 1 ? '' : 's'}`;
}

/** Badge text by the back button; app.js uses the same wording when the count changes. */
function othersWaitingText(count: number): string {
  return `${count} other${count === 1 ? '' : 's'} waiting`;
}

export function chatPage({
  base,
  session,
  messages,
  state,
  othersPending,
  owner,
  banner,
  draft,
}: ChatPageOptions): string {
  const label = sessionLabel(session);
  const sessionPath = `${base}sessions/${escapeHtml(session.id)}`;
  const isPending = state.pending !== null;
  const othersCount = othersPending.length;

  return page({
    title: titleWithCount((isPending ? 1 : 0) + othersCount, `${label} - Touch Grass`),
    base,
    data: {
      page: 'chat',
      'session-id': session.id,
      label,
      count: String(messages.length),
      'others-pending': othersPending.join(' '),
      'placeholder-pending': PLACEHOLDER_PENDING,
      'placeholder-idle': PLACEHOLDER_IDLE,
    },
    content: `<div class="chat-container">
  <header class="chat-header">
    <a href="${base}" class="back-button" title="Back to sessions"><span aria-hidden="true">&larr;</span><span class="visually-hidden">Back to sessions</span><span class="badge" id="others-waiting"${othersCount > 0 ? '' : ' hidden'}>${othersWaitingText(othersCount)}</span></a>
    <div class="session-title">
      <h1>${escapeHtml(label)}</h1>
      <span class="session-caller">caller: ${escapeHtml(session.callerId)}${owner === undefined ? '' : ` &middot; ${ownerText(owner)}`}</span>
    </div>
    <div class="toolbar">
      ${alertSwitches()}
      ${chatMenu()}
    </div>
  </header>
  <div class="messages" id="messages">
    ${messages.length > 0 ? messagesFragment(messages) : '<p class="empty" id="no-messages">No messages yet.</p>'}
  </div>
  <div class="composer">
    ${bannerBlock(banner, 'chat-banner')}
    ${bannerBlock(undefined, 'poll-banner')}
    <p class="chat-status" id="chat-status">${chatStatusHtml(state)}</p>
    <form method="post" action="${sessionPath}/respond" class="respond-form" id="respond-form">
      <input type="hidden" name="requestId" id="request-id" value="${escapeHtml(state.pending?.requestId ?? '')}">
      <label for="response-input" class="visually-hidden">Your answer</label>
      <textarea name="content" id="response-input" rows="3"
        placeholder="${isPending ? PLACEHOLDER_PENDING : PLACEHOLDER_IDLE}"${isPending ? '' : ' readonly'}>${escapeHtml(draft ?? '')}</textarea>
      <button type="submit" id="send-btn"${isPending ? '' : ' disabled'}>Send</button>
    </form>
    <p class="char-count" id="char-count">${charCountText(draft ?? '')}</p>
  </div>
</div>`,
  });
}

/** Why an answer did not land, for the banner on the re-rendered chat page. */
export function undeliveredAnswerHtml(
  submittedRequestId: string,
  request: RequestRecord | undefined
): string {
  const draftKept = ' Your draft is back in the box below.';
  // request is undefined when the id is unknown or belongs to another session.
  if (!request) {
    return submittedRequestId === ''
      ? `There was no open question when you sent this, so it was not delivered.${draftKept}`
      : `The question you were answering no longer exists, so your answer was not delivered.${draftKept}`;
  }
  if (request.status === 'answered') {
    return `That question was already answered (another tab?), so this answer was not delivered.${draftKept}`;
  }
  const at = request.expiredAt ?? request.expiresAt;
  const when = at ? ` at ${timeTag(at)}` : '';
  switch (request.expireReason) {
    case 'timeout':
      return `The AI stopped waiting${when} (its deadline passed), so your answer was not delivered.${draftKept}`;
    case 'cancelled':
      return `The AI stopped waiting${when} (it cancelled the question), so your answer was not delivered.${draftKept}`;
    default:
      return `The AI sent a new message before you answered, so your answer was not delivered. Read the new message, then send again.${draftKept}`;
  }
}

// ── Account and user admin ──

/** The account and admin pages' header: title, subtitle, and the way back to the sessions. */
function subPageHeader(base: string, title: string, subtitleHtml: string, links: string): string {
  return `<header class="page-header">
      <div>
        <h1>${escapeHtml(title)}</h1>
        <p class="subtitle">${subtitleHtml}</p>
      </div>
      <nav class="toolbar">
        ${links}
        <a href="${base}" class="toolbar-link">&larr; Sessions</a>
      </nav>
    </header>`;
}

export interface AccountPageOptions {
  base: string;
  viewer: WebPrincipal;
  banner?: Banner;
}

function userAccountSections(base: string, token: string): string {
  return `<section class="panel">
      <h2>Your token</h2>
      <p><code class="token">${escapeHtml(token)}</code></p>
      <p>Questions the AI sends with this token land in your inbox. Give it to the AI as the minion tool's <code>remoteToken</code>, for example in its system prompt. It only routes questions; nobody can sign in with it.</p>
    </section>
    <section class="panel">
      <h2>Change password</h2>
      <form method="post" action="${base}account" class="stacked-form">
        <div class="field">
          <label for="current-password">Current password</label>
          <input id="current-password" type="password" name="current" autocomplete="current-password" required>
        </div>
        <div class="field">
          <label for="new-password">New password</label>
          <input id="new-password" type="password" name="password" autocomplete="new-password" minlength="${PASSWORD_MIN_LENGTH}" required>
          <p class="hint">At least ${PASSWORD_MIN_LENGTH} characters.</p>
        </div>
        <div class="field">
          <label for="confirm-password">New password again</label>
          <input id="confirm-password" type="password" name="confirm" autocomplete="new-password" minlength="${PASSWORD_MIN_LENGTH}" required>
        </div>
        <p class="hint">This browser stays signed in. Every other browser signed in as you is signed out.</p>
        <button type="submit">Change password</button>
      </form>
    </section>`;
}

const ADMIN_ACCOUNT_SECTION = `<section class="panel">
      <h2>Password</h2>
      <p>Yours is <code>WEB_PASSWORD</code> in the server's <code>.env</code>. Change it there and restart the server. That signs out every browser, users included.</p>
    </section>`;

export function accountPage({ base, viewer, banner }: AccountPageOptions): string {
  const isAdmin = viewer.role === 'admin';
  return page({
    title: 'Account - Touch Grass',
    base,
    data: { page: 'account' },
    content: `<main class="container">
    ${subPageHeader(
      base,
      'Account',
      `Signed in as <strong>${escapeHtml(viewer.username)}</strong>${isAdmin ? ' (admin)' : ''}`,
      isAdmin ? `<a href="${base}admin" class="toolbar-link">Users</a>` : ''
    )}
    ${banner ? bannerBlock(banner) : ''}
    ${viewer.role === 'admin' ? ADMIN_ACCOUNT_SECTION : userAccountSections(base, viewer.token)}
  </main>`,
  });
}

/** What a refused admin form had in it, so the re-rendered page keeps it. Never a password. */
export interface AdminFormState {
  /** The name typed into the add-user form. */
  newUsername?: string;
  /** The user whose settings were being changed; their panel opens. */
  userId?: string;
  /** The name typed into that user's rename field. */
  rename?: string;
}

export interface AdminPageOptions {
  base: string;
  report: UserStatsReport;
  banner?: Banner;
  /** A user added a moment ago; a banner shows its token, ready to copy. */
  created?: User;
  form?: AdminFormState;
}

const USER_TABLE_COLUMNS = 6;

function statCells(stats: UserStats): string {
  const counts = [stats.sessions, stats.aiMessages, stats.humanReplies, stats.pending]
    .map(count => `<td class="num">${count}</td>`)
    .join('');
  return `${counts}<td>${stats.lastActivityAt ? timeTag(stats.lastActivityAt) : '&mdash;'}</td>`;
}

/** A user's stats row, and under it their token and the rename, reset and delete forms. */
function userRows(base: string, user: User, stats: UserStats, form: AdminFormState): string {
  const id = escapeHtml(user.id);
  const name = escapeHtml(user.username);
  const action = `${base}admin/users/${id}`;
  const editing = form.userId === user.id;
  const renameValue = editing && form.rename !== undefined ? form.rename : user.username;
  return `<tbody class="user-group">
        <tr>
          <th scope="row">${name}</th>
          ${statCells(stats)}
        </tr>
        <tr class="manage-row">
          <td colspan="${USER_TABLE_COLUMNS}">
            <details class="user-manage"${editing ? ' open' : ''}>
              <summary>Token and settings<span class="visually-hidden"> for ${name}</span></summary>
              <div class="manage-panel">
                <p>Token: <code class="token">${escapeHtml(user.token)}</code></p>
                <form method="post" action="${action}/rename" class="inline-fields">
                  <label for="rename-${id}">Rename to</label>
                  <input id="rename-${id}" type="text" name="username" value="${escapeHtml(renameValue)}"
                    autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="${USERNAME_MAX_LENGTH}" required>
                  <button type="submit" class="secondary-button">Rename</button>
                </form>
                <form method="post" action="${action}/password" class="inline-fields">
                  <label for="reset-${id}">New password</label>
                  <input id="reset-${id}" type="password" name="password" autocomplete="new-password" minlength="${PASSWORD_MIN_LENGTH}" required>
                  <button type="submit" class="secondary-button">Reset password</button>
                </form>
                <p class="hint">Renaming keeps ${name} signed in. A new password signs them out everywhere.</p>
                <form method="post" action="${action}/delete"
                  data-confirm="${escapeHtml(`Delete user "${user.username}"? Their sessions stay and become admin-only.`)}">
                  <button type="submit" class="danger-button">Delete user</button>
                </form>
              </div>
            </details>
          </td>
        </tr>
      </tbody>`;
}

function createdBanner(user: User): string {
  return bannerBlock({
    kind: 'info',
    html:
      `Added <strong>${escapeHtml(user.username)}</strong>. Their token is ` +
      `<code class="token">${escapeHtml(user.token)}</code>. ` +
      'Questions the AI sends with it as <code>remoteToken</code> land in their inbox.',
  });
}

export function adminPage({ base, report, banner, created, form = {} }: AdminPageOptions): string {
  const userGroups =
    report.users.length > 0
      ? report.users.map(({ user, stats }) => userRows(base, user, stats, form)).join('\n      ')
      : `<tbody><tr><td colspan="${USER_TABLE_COLUMNS}" class="empty-row">No users yet, so every session is yours.</td></tr></tbody>`;
  return page({
    title: 'Users - Touch Grass',
    base,
    data: { page: 'admin' },
    content: `<main class="container">
    ${subPageHeader(
      base,
      'Users',
      'Who answers which AI, and how much',
      `<a href="${base}account" class="toolbar-link">Account</a>`
    )}
    ${created ? createdBanner(created) : ''}
    ${banner ? bannerBlock(banner) : ''}
    <div class="table-scroll">
      <table class="user-table">
        <thead>
          <tr>
            <th scope="col">User</th>
            <th scope="col" class="num">Sessions</th>
            <th scope="col" class="num">AI messages</th>
            <th scope="col" class="num">Human replies</th>
            <th scope="col" class="num">Waiting</th>
            <th scope="col">Last activity</th>
          </tr>
        </thead>
      ${userGroups}
        <tbody class="no-token-group">
          <tr>
            <th scope="row">No token (admin only)</th>
            ${statCells(report.noToken)}
          </tr>
        </tbody>
      </table>
    </div>
    <p class="footnote">Counts cover the sessions still on the server. When retention (<code>SESSION_RETENTION_DAYS</code>) deletes an idle session, its counts go with it.</p>
    <section class="panel">
      <h2>Add a user</h2>
      <form method="post" action="${base}admin/users" class="stacked-form">
        <div class="field">
          <label for="new-username">Username</label>
          <input id="new-username" type="text" name="username" value="${escapeHtml(form.newUsername ?? '')}"
            autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="${USERNAME_MAX_LENGTH}" required>
          <p class="hint">Letters, digits, dots, underscores and hyphens. Sign-in ignores letter case.</p>
        </div>
        <div class="field">
          <label for="new-password">Password</label>
          <input id="new-password" type="password" name="password" autocomplete="new-password" minlength="${PASSWORD_MIN_LENGTH}" required>
          <p class="hint">At least ${PASSWORD_MIN_LENGTH} characters. They can change it on their Account page.</p>
        </div>
        <button type="submit">Add user</button>
      </form>
    </section>
  </main>`,
  });
}
