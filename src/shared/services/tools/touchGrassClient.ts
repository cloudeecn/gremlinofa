/**
 * HTTP client for the Touch Grass backend (remote human minions).
 *
 * The wire contract is `touch-grass-backend/touch-grass-api.yaml` (v2.1). This
 * runs in both runtimes, the browser Web Worker (worker mode) and Node (server
 * mode), so it sticks to `fetch`, `AbortController`, `TextEncoder` and `btoa`,
 * and tailors its network-failure hints to whichever runtime it is in: a
 * browser hides the real cause (CORS, mixed content) behind "Failed to fetch",
 * while Node exposes a cause code.
 */

/** Basic-auth username. The backend records it as a label, not an identity. */
export const TOUCH_GRASS_CALLER_ID = 'gremlinofa';

/** Longest single long-poll hold we ask for; the server clamps to its own POLL_TIMEOUT_MS. */
export const MAX_POLL_WAIT_MS = 30_000;
/** Slack on top of `waitMs` before a poll counts as hung (server hold + network latency). */
const POLL_GRACE_MS = 10_000;
/** A `pending` that comes back faster than this would turn the poll loop into a hot loop. */
const MIN_POLL_INTERVAL_MS = 1_000;
const CREATE_SESSION_TIMEOUT_MS = 30_000;
/** Base budget for posting a message; the upload allowance below comes on top. */
const POST_MESSAGE_TIMEOUT_MS = 60_000;
/**
 * Extra post budget per 64 KB of body (a ~0.5 Mbit/s uplink), so a message
 * carrying several MB of injected files isn't cut off mid-upload on every
 * attempt. A full 10 MB body gets about 220 s.
 */
const UPLOAD_MS_PER_64KB = 1_000;
/** Reading a session back returns its whole history, files included. */
const GET_SESSION_TIMEOUT_MS = 60_000;
/** Cancel runs on a fresh signal after the caller's has fired, so it needs its own short budget. */
const CANCEL_TIMEOUT_MS = 5_000;
/** Backoff between retries of a transient failure; the last step repeats. */
const RETRY_DELAYS_MS: readonly number[] = [1_000, 2_000, 5_000, 10_000];

export const ENDPOINT_HINT =
  'Remote Minion Endpoint must be the backend root, e.g. https://host:3004 — not the /web/ page.';

export type ExpireReason = 'timeout' | 'cancelled' | 'superseded';

export type RequestState =
  | { status: 'pending'; expiresAt: string | null }
  | { status: 'answered'; response: { content: string } }
  /** `reason` is absent on a v1 backend, which had no expiry reasons. */
  | { status: 'expired'; reason?: ExpireReason };

export type FinalRequestState = Exclude<RequestState, { status: 'pending' }>;

export type CancelOutcome =
  /** The backend heard the cancel; `state` may be an answer that beat it. */
  | { reached: true; state: FinalRequestState }
  /** 404: the request went with its session, so nothing is left to withdraw. */
  | { reached: true; gone: true }
  /**
   * The cancel didn't get through. `retryable` when a later attempt may (backend
   * down, network blip, a gateway's 5xx), false when repeating it can't help
   * (401, TLS, a body that isn't a final state).
   */
  | { reached: false; retryable: boolean };

export interface RemoteInjectedFile {
  path: string;
  content: string;
  placement: 'before' | 'after';
  /** Content lines carry `%6d\t` prefixes; the human UI strips them for its markdown view. */
  lineNumbers?: boolean;
}

export interface PostMessageBody {
  content: string;
  files?: RemoteInjectedFile[];
  /** How long we will wait; the server turns it into the request's `expiresAt`. */
  timeoutMs?: number;
  /** `false` posts an async note: the human sees it, but there is nothing to answer. */
  awaitReply?: false;
}

export interface PendingRequestRef {
  requestId: string;
  /** Server-side deadline; null when the server has none (v1 backend, or no timeoutMs). */
  expiresAt: string | null;
}

export interface PostedMessage {
  /**
   * null when the backend opened no request: an async note on a 2.1+ backend. A 2.0 backend
   * ignores `awaitReply` and opens one anyway.
   */
  requestId: string | null;
  expiresAt: string | null;
}

/** Just enough of `GET /api/sessions/{id}` to tell whether a post landed. */
export interface SessionTail {
  pendingRequest: PendingRequestRef | null;
  lastMessage:
    | { role: unknown; content: unknown; fileCount: number; awaitsReply: unknown }
    | undefined;
}

export type TouchGrassErrorKind =
  /** The caller's signal fired (user pressed Stop). */
  | 'aborted'
  /** Our per-request timeout fired. */
  | 'timeout'
  /** `fetch` itself threw: connection refused, DNS, CORS, mixed content... */
  | 'network'
  /** Non-2xx response. */
  | 'http'
  /** 2xx response whose body isn't what the contract says. */
  | 'protocol';

export class TouchGrassError extends Error {
  readonly kind: TouchGrassErrorKind;
  readonly status?: number;
  /** Worth retrying after a backoff: the same request may well succeed shortly. */
  readonly retryable: boolean;
  /**
   * The request provably never reached the backend (connection refused, DNS
   * failure, a gateway's 503), so sending it again can't duplicate
   * anything. False for failures that leave it open: a timeout, a dropped
   * connection, a browser "Failed to fetch", a gateway's 502 or 504.
   */
  readonly unsent: boolean;

  constructor(
    message: string,
    kind: TouchGrassErrorKind,
    opts: { status?: number; retryable?: boolean; unsent?: boolean } = {}
  ) {
    super(message);
    this.name = 'TouchGrassError';
    this.kind = kind;
    this.status = opts.status;
    this.retryable = opts.retryable ?? false;
    this.unsent = opts.unsent ?? false;
  }
}

export function isTouchGrassAbort(err: unknown): boolean {
  return err instanceof TouchGrassError && err.kind === 'aborted';
}

function abortedError(): TouchGrassError {
  return new TouchGrassError('Request aborted', 'aborted');
}

/**
 * Reduce whatever the user pasted to the backend root: trailing slashes go,
 * and so does a trailing `/web` (the human UI they had open) or `/api`.
 */
export function normalizeTouchGrassEndpoint(raw: string): string {
  return raw
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/(?:web|api)$/i, '')
    .replace(/\/+$/, '');
}

/** Error text when the (normalized) endpoint can't be fetched at all, else undefined. */
export function validateTouchGrassEndpoint(endpoint: string): string | undefined {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return `Remote Minion Endpoint "${endpoint}" is not a valid URL. ${ENDPOINT_HINT}`;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return `Remote Minion Endpoint "${endpoint}" must start with http:// or https://.`;
  }
  return undefined;
}

/**
 * Basic auth over the UTF-8 bytes of `user:password`, which is what the
 * backend decodes. Plain `btoa` would throw on anything outside Latin-1 and
 * send Latin-1 bytes for the rest, which then never match.
 */
export function basicAuthHeader(user: string, password: string): string {
  const bytes = new TextEncoder().encode(`${user}:${password}`);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `Basic ${btoa(binary)}`;
}

export type TouchGrassRuntime = 'browser' | 'node';

function detectRuntime(): TouchGrassRuntime {
  const proc = (globalThis as { process?: { versions?: { node?: unknown } } }).process;
  return typeof proc?.versions?.node === 'string' ? 'node' : 'browser';
}

/**
 * A signal that fires when `parent` does or after `timeoutMs`, whichever is
 * first. Hand-rolled instead of `AbortSignal.any` + `AbortSignal.timeout` so
 * the timer and the listener on the long-lived parent are released on
 * `dispose()`, and so `timedOut()` can tell the two causes apart.
 */
function linkSignal(
  parent: AbortSignal | undefined,
  timeoutMs: number
): { signal: AbortSignal; timedOut: () => boolean; dispose: () => void } {
  const controller = new AbortController();
  let timedOut = false;
  const onParentAbort = () => controller.abort();
  if (parent?.aborted) controller.abort();
  else parent?.addEventListener('abort', onParentAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose: () => {
      clearTimeout(timer);
      parent?.removeEventListener('abort', onParentAbort);
    },
  };
}

/** Resolve after `ms`, or reject with an `aborted` TouchGrassError as soon as `signal` fires. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortedError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortedError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function retryDelayMs(failureIndex: number): number {
  return RETRY_DELAYS_MS[Math.min(failureIndex, RETRY_DELAYS_MS.length - 1)];
}

/** Resolve after `ms` on a timer that, in Node, doesn't keep the process alive. */
function unrefSleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    const timer: unknown = setTimeout(resolve, ms);
    // Node's Timeout has unref(); a browser's timer id is a plain number.
    (timer as { unref?: () => void }).unref?.();
  });
}

type NodeFetchCause = { code?: unknown; message?: unknown; errors?: Array<{ code?: unknown }> };

/** Node's undici wraps the real reason (`ECONNREFUSED`, TLS errors) in `err.cause`. */
function nodeCause(err: unknown): NodeFetchCause | undefined {
  return (err as { cause?: unknown } | null)?.cause as NodeFetchCause | undefined;
}

function nodeCauseCode(cause: NodeFetchCause | undefined): string | undefined {
  if (typeof cause?.code === 'string') return cause.code;
  // Happy-eyeballs failures arrive as an AggregateError holding one error per address.
  const nestedCode = cause?.errors?.find(e => typeof e?.code === 'string')?.code;
  return typeof nestedCode === 'string' ? nestedCode : undefined;
}

/** Cause codes for a connection that was never established, so nothing was sent. */
const UNSENT_CAUSE_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']);

/** Certificate failures without an `ERR_SSL_` / `ERR_TLS_` prefix (OpenSSL's verify codes). */
const TLS_CERT_CAUSE_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
]);

/**
 * The TLS handshake failed: an https:// endpoint on a plain-HTTP backend
 * (`ERR_SSL_WRONG_VERSION_NUMBER` and kin), a name mismatch
 * (`ERR_TLS_CERT_ALTNAME_INVALID`), or a certificate Node won't trust.
 */
function isTlsCauseCode(code: string): boolean {
  return (
    code.startsWith('ERR_SSL_') || code.startsWith('ERR_TLS_') || TLS_CERT_CAUSE_CODES.has(code)
  );
}

const TLS_HINT =
  'TLS handshake failed: if the backend serves plain HTTP, use http://; otherwise check its certificate.';

function browserNetworkHint(endpoint: string): string {
  const appLocation = (globalThis as { location?: { protocol?: string; origin?: string } })
    .location;
  if (appLocation?.protocol === 'https:' && endpoint.startsWith('http:')) {
    return 'The app is served over HTTPS, so the browser blocks this http:// endpoint as mixed content. Serve the backend over HTTPS (e.g. behind a reverse proxy) and use that URL.';
  }
  const origin =
    appLocation?.origin && appLocation.origin !== 'null' ? appLocation.origin : "this app's origin";
  return `If the backend is running, the browser most likely blocked the request: set CORS_ORIGIN=${origin} on the backend, and use an https:// endpoint when the app is served over HTTPS.`;
}

/**
 * Server-provided error detail, capped: a misrouted request can come back as a
 * whole HTML page. `fromBackend` marks the backend's own `{ "error": ... }`
 * body; anything else came from whatever sits in front of it.
 */
function errorDetail(bodyText: string): { detail: string; isHtml: boolean; fromBackend: boolean } {
  const trimmed = bodyText.trim();
  if (/^<(?:!doctype|html)/i.test(trimmed)) {
    return { detail: '(HTML page)', isHtml: true, fromBackend: false };
  }
  try {
    const parsed = JSON.parse(trimmed) as { error?: unknown };
    if (typeof parsed?.error === 'string') {
      return { detail: parsed.error.slice(0, 200), isHtml: false, fromBackend: true };
    }
  } catch {
    // Not JSON: fall through to the raw text.
  }
  return { detail: trimmed.slice(0, 200), isHtml: false, fromBackend: false };
}

const RETRYABLE_STATUSES = new Set([502, 503, 504]);
/**
 * A gateway answering 503 couldn't hand the request on. A 502 is ambiguous:
 * nginx sends it for a refused connection and for a backend that died after
 * reading the request. A 504 may have reached a slow backend.
 */
const UNSENT_STATUSES = new Set([503]);

export interface TouchGrassClientConfig {
  /** Backend root, already normalized. */
  endpoint: string;
  password: string;
  /** Override runtime detection (tests). */
  runtime?: TouchGrassRuntime;
}

export class TouchGrassClient {
  readonly endpoint: string;
  private readonly password: string;
  private readonly runtime: TouchGrassRuntime;

  constructor(config: TouchGrassClientConfig) {
    this.endpoint = config.endpoint;
    this.password = config.password;
    this.runtime = config.runtime ?? detectRuntime();
  }

  /** Where the human answers this session in the bundled web UI. */
  sessionUrl(sessionId: string): string {
    return `${this.endpoint}/web/sessions/${encodeURIComponent(sessionId)}`;
  }

  async createSession(displayName: string | null, signal?: AbortSignal): Promise<string> {
    const body = await this.send('Creating the remote session', 'POST', '/api/sessions', {
      json: JSON.stringify({ displayName }),
      timeoutMs: CREATE_SESSION_TIMEOUT_MS,
      signal,
    });
    const sessionId = (body as { sessionId?: unknown } | null)?.sessionId;
    if (typeof sessionId !== 'string' || !sessionId) {
      throw this.protocolError('Creating the remote session', 'a response without sessionId');
    }
    return sessionId;
  }

  /**
   * Not idempotent: every POST adds a message (a new question, or an async
   * note) and supersedes the pending question. Retry through
   * `postMessageWithRetry`, never blindly.
   */
  async postMessage(
    sessionId: string,
    message: PostMessageBody,
    signal?: AbortSignal
  ): Promise<PostedMessage> {
    const json = JSON.stringify(message);
    const body = await this.send(
      'Sending the message',
      'POST',
      `/api/sessions/${encodeURIComponent(sessionId)}/message`,
      {
        json,
        timeoutMs: POST_MESSAGE_TIMEOUT_MS + Math.ceil(json.length / 65_536) * UPLOAD_MS_PER_64KB,
        signal,
      }
    );
    const posted = body as { requestId?: unknown; expiresAt?: unknown } | null;
    const requestId = posted?.requestId;
    if (typeof requestId === 'string' && requestId) {
      return {
        requestId,
        expiresAt: typeof posted?.expiresAt === 'string' ? posted.expiresAt : null,
      };
    }
    // Only an async note may come back without a request.
    if (message.awaitReply === false && requestId === null) {
      return { requestId: null, expiresAt: null };
    }
    throw this.protocolError('Sending the message', 'a response without requestId');
  }

  /** The session's pending request and its newest message, for `postMessageWithRetry`. */
  async getSessionTail(sessionId: string, signal?: AbortSignal): Promise<SessionTail> {
    const operation = 'Reading the remote session back';
    const body = (await this.send(
      operation,
      'GET',
      `/api/sessions/${encodeURIComponent(sessionId)}`,
      { timeoutMs: GET_SESSION_TIMEOUT_MS, signal }
    )) as { messages?: unknown; pendingRequest?: unknown } | null;
    const pending = body?.pendingRequest as { requestId?: unknown; expiresAt?: unknown } | null;
    if (!Array.isArray(body?.messages) || pending === undefined) {
      throw this.protocolError(operation, 'a session without messages or pendingRequest');
    }
    if (pending !== null && (typeof pending.requestId !== 'string' || !pending.requestId)) {
      throw this.protocolError(operation, 'a pendingRequest without requestId');
    }
    const last = body.messages.at(-1) as
      | { role?: unknown; content?: unknown; files?: unknown; awaitsReply?: unknown }
      | undefined;
    return {
      pendingRequest: pending && {
        requestId: pending.requestId as string,
        expiresAt: typeof pending.expiresAt === 'string' ? pending.expiresAt : null,
      },
      lastMessage: last && {
        role: last.role,
        content: last.content,
        fileCount: Array.isArray(last.files) ? last.files.length : 0,
        awaitsReply: last.awaitsReply,
      },
    };
  }

  async poll(requestId: string, waitMs: number, signal?: AbortSignal): Promise<RequestState> {
    const holdMs = Math.max(0, Math.round(waitMs));
    const body = await this.send(
      'Polling for the answer',
      'GET',
      `/api/requests/${encodeURIComponent(requestId)}/poll?waitMs=${holdMs}`,
      { timeoutMs: holdMs + POLL_GRACE_MS, signal }
    );
    const state = parseRequestState(body);
    if (!state) throw this.protocolError('Polling for the answer', 'an unknown request state');
    return state;
  }

  /**
   * Withdraw a pending question. Never throws. The final state matters to the
   * caller: a human may have answered in the race. `reached` tells whether the
   * question is closed for good or may stay answerable until a later cancel
   * gets through. Runs on its own short timeout, never on the caller's
   * (possibly already fired) signal.
   */
  async cancel(requestId: string): Promise<CancelOutcome> {
    try {
      const body = await this.send(
        'Cancelling the question',
        'POST',
        `/api/requests/${encodeURIComponent(requestId)}/cancel`,
        { timeoutMs: CANCEL_TIMEOUT_MS }
      );
      const state = parseRequestState(body);
      if (state && state.status !== 'pending') return { reached: true, state };
      console.debug('[touchGrass] cancel of %s got no final state back', requestId);
      return { reached: false, retryable: false };
    } catch (err) {
      console.debug('[touchGrass] cancel of %s failed: %s', requestId, (err as Error).message);
      if (err instanceof TouchGrassError && err.status === 404)
        return { reached: true, gone: true };
      return { reached: false, retryable: err instanceof TouchGrassError && err.retryable };
    }
  }

  private async send(
    operation: string,
    method: 'GET' | 'POST',
    path: string,
    opts: { json?: string; timeoutMs: number; signal?: AbortSignal }
  ): Promise<unknown> {
    const link = linkSignal(opts.signal, opts.timeoutMs);
    try {
      const headers: Record<string, string> = {
        Authorization: basicAuthHeader(TOUCH_GRASS_CALLER_ID, this.password),
      };
      if (opts.json !== undefined) headers['Content-Type'] = 'application/json';

      let res: Response;
      let bodyText: string;
      try {
        res = await fetch(`${this.endpoint}${path}`, {
          method,
          headers,
          body: opts.json,
          signal: link.signal,
        });
        bodyText = await res.text();
      } catch (err) {
        throw this.fetchFailure(operation, err, opts.signal, link.timedOut(), opts.timeoutMs);
      }

      if (!res.ok) throw this.httpError(operation, res, bodyText);
      try {
        return JSON.parse(bodyText) as unknown;
      } catch {
        const redirectNote = res.redirected ? ` (after a redirect to ${res.url})` : '';
        throw new TouchGrassError(
          `${operation} failed: the backend answered HTTP ${res.status} with something that isn't JSON${redirectNote}. ${ENDPOINT_HINT}`,
          'protocol',
          { status: res.status }
        );
      }
    } finally {
      link.dispose();
    }
  }

  private fetchFailure(
    operation: string,
    err: unknown,
    callerSignal: AbortSignal | undefined,
    timedOut: boolean,
    timeoutMs: number
  ): TouchGrassError {
    if (callerSignal?.aborted) return abortedError();
    if (timedOut) {
      return new TouchGrassError(
        `${operation} failed: no response within ${Math.round(timeoutMs / 1000)}s.`,
        'timeout',
        { retryable: true }
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    if (this.runtime === 'node') {
      const cause = nodeCause(err);
      const code = nodeCauseCode(cause);
      if (code !== undefined && isTlsCauseCode(code)) {
        // A retry meets the same protocol or certificate, and no HTTP request left.
        return new TouchGrassError(
          `${operation} failed: ${message} (${code}). ${TLS_HINT}`,
          'network',
          { unsent: true }
        );
      }
      const detail =
        code ?? (typeof cause?.message === 'string' && cause.message ? cause.message : undefined);
      return new TouchGrassError(
        `${operation} failed: ${message}${detail ? ` (${detail})` : ''}.`,
        'network',
        { retryable: true, unsent: code !== undefined && UNSENT_CAUSE_CODES.has(code) }
      );
    }
    return new TouchGrassError(
      `${operation} failed: ${message}. ${browserNetworkHint(this.endpoint)}`,
      'network',
      { retryable: true }
    );
  }

  private httpError(operation: string, res: Response, bodyText: string): TouchGrassError {
    const { detail, isHtml, fromBackend } = errorDetail(bodyText);
    let message = `${operation} failed: HTTP ${res.status}${detail ? ` ${detail}` : ''}.`;
    if (res.redirected) {
      // Browsers and undici drop Authorization on a cross-origin redirect, so
      // the redirect target usually answers 401: name the real cause.
      message += ` The endpoint redirected to ${res.url}; set Remote Minion Endpoint to the final URL.`;
    } else if (res.status === 401) {
      message += ' Check that Remote Minion Password matches API_PASSWORD on the backend.';
    } else if (RETRYABLE_STATUSES.has(res.status)) {
      // The backend never sends these itself.
      message +=
        ' A reverse proxy answered but could not reach the Touch Grass backend. Is the backend running?';
    } else if (res.status === 413 && !fromBackend) {
      // The backend's own 413 says it caps bodies at 10 MB; a proxy's comes first.
      message +=
        ' The message is larger than a reverse proxy in front of the backend allows. Raise its body limit to 10 MB (nginx: client_max_body_size 10m; see touch-grass-backend/README.md).';
    } else if (isHtml) {
      message += ` ${ENDPOINT_HINT}`;
    }
    return new TouchGrassError(message, 'http', {
      status: res.status,
      retryable: RETRYABLE_STATUSES.has(res.status),
      unsent: UNSENT_STATUSES.has(res.status),
    });
  }

  private protocolError(operation: string, what: string): TouchGrassError {
    return new TouchGrassError(
      `${operation} failed: the backend sent ${what}. ${ENDPOINT_HINT}`,
      'protocol'
    );
  }
}

function parseRequestState(body: unknown): RequestState | undefined {
  const state = body as {
    status?: unknown;
    expiresAt?: unknown;
    response?: { content?: unknown } | null;
    reason?: unknown;
  } | null;
  switch (state?.status) {
    case 'pending':
      return {
        status: 'pending',
        expiresAt: typeof state.expiresAt === 'string' ? state.expiresAt : null,
      };
    case 'answered':
      return typeof state.response?.content === 'string'
        ? { status: 'answered', response: { content: state.response.content } }
        : undefined;
    case 'expired':
      return {
        status: 'expired',
        reason:
          state.reason === 'timeout' ||
          state.reason === 'cancelled' ||
          state.reason === 'superseded'
            ? state.reason
            : undefined,
      };
    default:
      return undefined;
  }
}

export interface RetryOptions {
  maxRetries: number;
  deadline: number;
  signal?: AbortSignal;
}

/**
 * Run `operation`, retrying transient failures (see `TouchGrassError.retryable`)
 * with the `RETRY_DELAYS_MS` backoff, at most `maxRetries` times and never
 * sleeping past `deadline`. An abort during a backoff rejects at once.
 */
export async function withRetry<T>(operation: () => Promise<T>, opts: RetryOptions): Promise<T> {
  for (let failures = 0; ; failures++) {
    try {
      return await operation();
    } catch (err) {
      if (!(err instanceof TouchGrassError) || !err.retryable || failures >= opts.maxRetries) {
        throw err;
      }
      const delay = Math.min(retryDelayMs(failures), opts.deadline - Date.now());
      if (delay <= 0) throw err;
      console.debug('[touchGrass] retrying in %dms after: %s', delay, err.message);
      await sleep(delay, opts.signal);
    }
  }
}

/**
 * Post a message, retrying transient failures without asking the human twice.
 * After a failure that may have reached the backend (timeout, dropped
 * connection, browser "Failed to fetch", 502, 504), the next attempt reads the
 * session back first: when its pending request belongs to a newest message
 * identical to ours, the earlier post landed and is adopted. Only failures that
 * provably never left (`unsent`) are posted again blind. A matching pending
 * request can only be ours: the busy guard keeps one call per minion chat, and
 * our earlier questions were cancelled or superseded. An async note opens no
 * request, so for one an identical newest message that opened none is the
 * earlier post (an identical earlier note would match too, which at worst
 * drops a duplicate). A 404 on the read-back is thrown like the post's own
 * 404: the session is gone.
 *
 * `timeoutMs` is recomputed per attempt so the question closes at `deadline`.
 * A note carries none: it has nothing to close.
 *
 * A question always comes back with its request: `postMessage` refuses a
 * response without one, and adoption only takes a pending request.
 */
export function postMessageWithRetry(
  client: TouchGrassClient,
  sessionId: string,
  message: Omit<PostMessageBody, 'timeoutMs' | 'awaitReply'>,
  opts: RetryOptions
): Promise<PendingRequestRef>;
export function postMessageWithRetry(
  client: TouchGrassClient,
  sessionId: string,
  message: Omit<PostMessageBody, 'timeoutMs'> & { awaitReply: false },
  opts: RetryOptions
): Promise<PostedMessage>;
export async function postMessageWithRetry(
  client: TouchGrassClient,
  sessionId: string,
  message: Omit<PostMessageBody, 'timeoutMs'>,
  opts: RetryOptions
): Promise<PostedMessage> {
  let mayHaveLanded = false;
  return withRetry(async () => {
    if (mayHaveLanded) {
      const tail = await client.getSessionTail(sessionId, opts.signal);
      const last = tail.lastMessage;
      const newestIsOurs =
        last?.role === 'ai' &&
        last.content === message.content &&
        last.fileCount === (message.files?.length ?? 0);
      // A 2.0 backend turns a note into a question, so a pending request is adopted for both.
      if (newestIsOurs && tail.pendingRequest) {
        console.debug(
          '[touchGrass] earlier post landed, adopting %s',
          tail.pendingRequest.requestId
        );
        return tail.pendingRequest;
      }
      if (newestIsOurs && message.awaitReply === false && last.awaitsReply === false) {
        console.debug('[touchGrass] earlier note landed');
        return { requestId: null, expiresAt: null };
      }
      // Our question closes at the deadline, so before it an identical newest
      // message with nothing pending is an older question (a retry after Stop
      // re-sends the same text) and posting is safe. Past it, it may be ours.
      if (newestIsOurs && Date.now() >= opts.deadline) {
        throw new TouchGrassError(
          'Sending the message failed: its response was lost, and the deadline passed before the backend could confirm it.',
          'timeout'
        );
      }
      mayHaveLanded = false;
    }
    try {
      return await client.postMessage(
        sessionId,
        message.awaitReply === false
          ? message
          : { ...message, timeoutMs: Math.max(1000, Math.round(opts.deadline - Date.now())) },
        opts.signal
      );
    } catch (err) {
      mayHaveLanded = err instanceof TouchGrassError && !err.unsent;
      throw err;
    }
  }, opts);
}

export type WaitOutcome =
  | { status: 'answered'; content: string }
  | { status: 'expired'; reason?: ExpireReason }
  /** Our deadline passed. `lastError` is set when the backend was failing at the end. */
  | { status: 'timeout'; lastError?: string };

/**
 * Long-poll `requestId` until it is answered or expired, or `deadline` passes.
 * Each hold asks for `min(remaining, MAX_POLL_WAIT_MS)`, so the loop never
 * overruns the deadline by a whole server hold. Transient failures (backend
 * restart, proxy 502, network blip) are retried with backoff inside the
 * budget. Throws a TouchGrassError on a non-retryable failure or an abort.
 */
export async function waitForAnswer(
  client: TouchGrassClient,
  requestId: string,
  opts: { deadline: number; signal?: AbortSignal }
): Promise<WaitOutcome> {
  let failures = 0;
  let lastError: string | undefined;
  for (;;) {
    const remaining = opts.deadline - Date.now();
    if (remaining <= 0) return { status: 'timeout', lastError };

    const startedAt = Date.now();
    let state: RequestState;
    try {
      state = await client.poll(requestId, Math.min(remaining, MAX_POLL_WAIT_MS), opts.signal);
    } catch (err) {
      if (!(err instanceof TouchGrassError) || !err.retryable) throw err;
      lastError = err.message;
      const delay = Math.min(retryDelayMs(failures++), opts.deadline - Date.now());
      console.debug('[touchGrass] poll failed, retrying in %dms: %s', delay, err.message);
      if (delay > 0) await sleep(delay, opts.signal);
      continue;
    }
    failures = 0;
    lastError = undefined;

    if (state.status === 'answered') return { status: 'answered', content: state.response.content };
    if (state.status === 'expired') return { status: 'expired', reason: state.reason };

    const elapsed = Date.now() - startedAt;
    if (elapsed < MIN_POLL_INTERVAL_MS) {
      const gap = Math.min(MIN_POLL_INTERVAL_MS - elapsed, opts.deadline - Date.now());
      if (gap > 0) await sleep(gap, opts.signal);
    }
  }
}

/**
 * Keep withdrawing `requestId` after the caller has moved on (Stop during a
 * backend outage), so the question doesn't stay answerable once the backend
 * is back. `firstAttempt` is the cancel already on its way; while it fails
 * retryably, cancels repeat with the `RETRY_DELAYS_MS` backoff until one gets
 * through (any final state, or 404) or the next would land at or past
 * `deadline`, when the backend expires the question itself.
 *
 * Meant to run detached: it never rejects, touches nothing but the network
 * (the caller's storage guard is released by then), and its backoff timers
 * don't hold a Node process open.
 */
export async function retryCancelInBackground(
  client: TouchGrassClient,
  requestId: string,
  firstAttempt: Promise<CancelOutcome>,
  deadline: number
): Promise<void> {
  let outcome = await firstAttempt;
  for (let failures = 0; !outcome.reached && outcome.retryable; failures++) {
    const delay = retryDelayMs(failures);
    if (Date.now() + delay >= deadline) {
      console.debug('[touchGrass] gave up cancelling %s: its deadline is near', requestId);
      return;
    }
    console.debug('[touchGrass] cancel of %s not through, retrying in %dms', requestId, delay);
    await unrefSleep(delay);
    outcome = await client.cancel(requestId);
  }
}
