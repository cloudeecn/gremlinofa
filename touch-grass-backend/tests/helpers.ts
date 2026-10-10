import crypto from 'crypto';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { createApp } from '../src/app.js';
import { config, type Config } from '../src/config.js';
import * as db from '../src/db.js';
import { createPollRegistry, type PollRegistry } from '../src/pollManager.js';

export function basicAuth(callerId: string, password: string): string {
  return 'Basic ' + Buffer.from(`${callerId}:${password}`, 'utf8').toString('base64');
}

/** vitest.config.ts sets API_PASSWORD, so this is the password the default test app expects. */
export const VALID_AUTH = basicAuth('test-caller', config.apiPassword);

export interface TestServer {
  baseUrl: string;
  server: Server;
  /** This app's long-poll waiters; nothing is shared with other test servers. */
  polls: PollRegistry;
  close: () => Promise<void>;
}

export async function startTestServer(overrides: Partial<Config> = {}): Promise<TestServer> {
  const polls = createPollRegistry();
  const app = createApp({ ...config, ...overrides }, polls);
  const server = await new Promise<Server>((resolve, reject) => {
    const listening = app.listen(0, '127.0.0.1', err => (err ? reject(err) : resolve(listening)));
  });
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    server,
    polls,
    close: () =>
      new Promise<void>(resolve => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export interface CallOptions {
  method?: string;
  /** Objects are sent as JSON; strings are sent verbatim with a JSON content type. */
  body?: unknown;
  /** null sends no Authorization header. */
  auth?: string | null;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export function makeCaller(baseUrl: string) {
  return (
    path: string,
    { method = 'GET', body, auth = VALID_AUTH, headers, signal }: CallOptions = {}
  ) => {
    const requestHeaders: Record<string, string> = { ...headers };
    if (auth !== null) requestHeaders.Authorization = auth;
    if (body !== undefined) requestHeaders['Content-Type'] = 'application/json';
    return fetch(`${baseUrl}${path}`, {
      method,
      headers: requestHeaders,
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      signal,
    });
  };
}

/** What the web UI's respond route does: record the answer, then wake the long-polls. */
export function answerAsHuman(
  polls: PollRegistry,
  sessionId: string,
  requestId: string,
  content: string
) {
  const result = db.answerRequest({
    requestId,
    sessionId,
    messageId: crypto.randomBytes(16).toString('hex'),
    content,
  });
  if (result.answered) {
    polls.notifyAnswered(requestId, content);
  }
  return result;
}
