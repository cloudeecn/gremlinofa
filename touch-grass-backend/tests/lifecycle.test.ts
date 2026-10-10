import net from 'net';
import type { AddressInfo } from 'net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import * as db from '../src/db.js';
import { createPollRegistry } from '../src/pollManager.js';
import { createShutdownHandler, startServer } from '../src/server.js';
import { makeCaller } from './helpers.js';

beforeEach(() => {
  db.initDatabase(':memory:');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('startServer', () => {
  it('reports EADDRINUSE to onListenError instead of throwing', async () => {
    const blocker = net.createServer();
    await new Promise<void>(resolve => blocker.listen(0, '127.0.0.1', resolve));
    const { port } = blocker.address() as AddressInfo;

    try {
      const err = await new Promise<NodeJS.ErrnoException>((resolve, reject) => {
        startServer({
          app: createApp(config, createPollRegistry()),
          port,
          host: '127.0.0.1',
          onListening: () => reject(new Error('should not have bound a busy port')),
          onListenError: resolve,
        });
      });
      expect(err.code).toBe('EADDRINUSE');
    } finally {
      await new Promise(resolve => blocker.close(resolve));
    }
  });

  it('calls onListening with the bound address', async () => {
    let server: ReturnType<typeof startServer> | undefined;
    const address = await new Promise<AddressInfo>((resolve, reject) => {
      server = startServer({
        app: createApp(config, createPollRegistry()),
        port: 0,
        host: '127.0.0.1',
        onListening: resolve,
        onListenError: reject,
      });
    });
    expect(address.port).toBeGreaterThan(0);
    await new Promise(resolve => server!.close(resolve));
  });
});

describe('shutdown', () => {
  it('answers held polls with pending, closes promptly, and ignores repeat signals', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const polls = createPollRegistry();
    const app = createApp({ ...config, pollTimeoutMs: 30000 }, polls);
    const server = await new Promise<ReturnType<typeof startServer>>((resolve, reject) => {
      const started = startServer({
        app,
        port: 0,
        host: '127.0.0.1',
        onListening: () => resolve(started),
        onListenError: reject,
      });
    });
    const { port } = server.address() as AddressInfo;
    const call = makeCaller(`http://127.0.0.1:${port}`);

    const session = (await (await call('/api/sessions', { method: 'POST', body: {} })).json()) as {
      sessionId: string;
    };
    const posted = (await (
      await call(`/api/sessions/${session.sessionId}/message`, {
        method: 'POST',
        body: { content: 'Still there?' },
      })
    ).json()) as { requestId: string };
    const heldPoll = call(`/api/requests/${posted.requestId}/poll?waitMs=30000`);
    await vi.waitFor(() => expect(polls.countWaiters(posted.requestId)).toBe(1));

    const onClosed = vi.fn();
    const shutdown = createShutdownHandler({ server, polls, onClosed, forceCloseAfterMs: 5000 });
    const startedAt = Date.now();
    shutdown('SIGTERM');
    shutdown('SIGINT');

    const res = await heldPoll;
    expect(await res.json()).toEqual({ status: 'pending', expiresAt: null });
    await vi.waitFor(() => expect(onClosed).toHaveBeenCalledTimes(1), { timeout: 6000 });
    expect(Date.now() - startedAt).toBeLessThan(2000);
    expect(console.log).toHaveBeenCalledWith('SIGINT received, shutdown already in progress');

    // Once stopped, new waits settle at once instead of pinning a connection.
    expect(await polls.waitForOutcome('late', 30000).promise).toEqual({ kind: 'shutdown' });
    expect(polls.cancelAll()).toBe(0);
  });

  it('cuts connections that outlive the deadline', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const polls = createPollRegistry();
    const app = createApp(config, polls);
    const server = await new Promise<ReturnType<typeof startServer>>((resolve, reject) => {
      const started = startServer({
        app,
        port: 0,
        host: '127.0.0.1',
        onListening: () => resolve(started),
        onListenError: reject,
      });
    });
    const { port } = server.address() as AddressInfo;

    // A client that sent half a request keeps its connection active, so only the deadline ends it.
    const socket = net.connect(port, '127.0.0.1');
    await new Promise(resolve => socket.once('connect', resolve));
    socket.write('GET /health HTTP/1.1\r\nHost: localhost\r\n');
    socket.on('error', () => {});
    await new Promise(resolve => setTimeout(resolve, 50));

    const onClosed = vi.fn();
    createShutdownHandler({ server, polls, onClosed, forceCloseAfterMs: 200 })('SIGTERM');
    await vi.waitFor(() => expect(onClosed).toHaveBeenCalledTimes(1), { timeout: 2000 });
    expect(console.warn).toHaveBeenCalled();
    socket.destroy();
  });
});
