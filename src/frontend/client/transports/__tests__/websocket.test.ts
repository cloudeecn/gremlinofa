/**
 * Tests for the client-side WebSocketTransport.
 *
 * Uses a real ws server (via the `ws` package) as the test endpoint.
 * The client-side transport uses the browser `WebSocket` API, which
 * vitest/jsdom provides.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WebSocketServer, WebSocket as WsWebSocket } from 'ws';
import { WebSocketTransport } from '../websocket';
import type { RequestEnvelope } from '../../../../shared/protocol/protocol';

type ClientMessage =
  | RequestEnvelope
  | { kind: 'stream_cancel'; requestId: string }
  | { kind: 'ping' };

let wss: WebSocketServer;
let port: number;
let serverSocket: WsWebSocket | null;

/** Start a ws server on `onPort` (a random free port by default). */
async function startServer(onPort = 0): Promise<void> {
  wss = new WebSocketServer({ port: onPort, host: '127.0.0.1' });
  await new Promise<void>(resolve => wss.on('listening', resolve));
  const addr = wss.address();
  port = typeof addr === 'object' && addr ? addr.port : 0;

  wss.on('connection', ws => {
    serverSocket = ws;
  });
}

async function stopServer(): Promise<void> {
  serverSocket = null;
  await new Promise<void>((resolve, reject) => {
    wss.close(err => (err ? reject(err) : resolve()));
  });
}

/** Take the server down the way a crash does: live sockets die with it. */
async function killServer(): Promise<void> {
  for (const client of wss.clients) client.terminate();
  await stopServer();
}

/** A port nothing listens on (bound once, then released). */
async function reservePort(): Promise<number> {
  const probe = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>(resolve => probe.on('listening', resolve));
  const addr = probe.address();
  const freePort = typeof addr === 'object' && addr ? addr.port : 0;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  return freePort;
}

/** Resolves once `states` holds `count` entries equal to `state`. */
async function waitForStateCount(states: string[], state: string, count: number): Promise<void> {
  await vi.waitFor(
    () => expect(states.filter(s => s === state).length).toBeGreaterThanOrEqual(count),
    {
      timeout: 8000,
    }
  );
}

/** Wait for the server to receive a connected client. */
function waitForServerConnection(): Promise<WsWebSocket> {
  return new Promise(resolve => {
    if (serverSocket) {
      resolve(serverSocket);
      return;
    }
    wss.once('connection', ws => {
      serverSocket = ws;
      resolve(ws);
    });
  });
}

/** Read the next JSON message from the server socket. */
function nextServerMessage(ws: WsWebSocket): Promise<ClientMessage> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('timeout waiting for client message')), 5000);
    ws.once('message', (data: Buffer) => {
      clearTimeout(timeout);
      resolve(JSON.parse(data.toString()) as ClientMessage);
    });
  });
}

/**
 * Collect all messages that arrive on `ws` into a buffer. Returns a
 * `next()` function that resolves with the first buffered message (or
 * waits for one to arrive). Prevents lost events when multiple messages
 * fire back-to-back before the test can register listeners.
 */
function bufferMessages(ws: WsWebSocket) {
  const queue: ClientMessage[] = [];
  let waiter: ((msg: ClientMessage) => void) | null = null;
  ws.on('message', (data: Buffer) => {
    const msg = JSON.parse(data.toString()) as ClientMessage;
    if (waiter) {
      const w = waiter;
      waiter = null;
      w(msg);
    } else {
      queue.push(msg);
    }
  });
  return {
    next(): Promise<ClientMessage> {
      if (queue.length > 0) return Promise.resolve(queue.shift()!);
      return new Promise(resolve => {
        waiter = resolve;
      });
    },
  };
}

/** Send a JSON envelope from the server to the client. */
function serverSend(ws: WsWebSocket, msg: Record<string, unknown>): void {
  ws.send(JSON.stringify(msg));
}

describe('WebSocketTransport', () => {
  let transport: WebSocketTransport;

  beforeEach(async () => {
    serverSocket = null;
    await startServer();
  });

  afterEach(async () => {
    transport?.dispose();
    await stopServer();
  });

  // --------------------------------------------------------------------------
  // One-shot request/response
  // --------------------------------------------------------------------------

  describe('request', () => {
    it('should send a request and resolve with the response', async () => {
      transport = new WebSocketTransport(`ws://127.0.0.1:${port}`);
      const ws = await waitForServerConnection();

      // Use 'init' which bypasses the init gate
      const resultPromise = transport.request('init', { cek: 'test-cek' });

      const msg = await nextServerMessage(ws);
      expect(msg.kind).toBe('request');
      expect((msg as RequestEnvelope).method).toBe('init');

      serverSend(ws, {
        kind: 'response',
        requestId: (msg as RequestEnvelope).requestId,
        result: { status: 'fresh' },
      });

      const result = await resultPromise;
      expect(result).toEqual({ status: 'fresh' });
    });

    it('should reject with ProtocolError on error envelope', async () => {
      transport = new WebSocketTransport(`ws://127.0.0.1:${port}`);
      const ws = await waitForServerConnection();

      const resultPromise = transport.request('init', { cek: 'test' });

      const msg = await nextServerMessage(ws);

      serverSend(ws, {
        kind: 'error',
        requestId: (msg as RequestEnvelope).requestId,
        code: 'CEK_MISMATCH',
        message: 'wrong key',
      });

      await expect(resultPromise).rejects.toThrow('wrong key');
    });
  });

  // --------------------------------------------------------------------------
  // Streaming
  // --------------------------------------------------------------------------

  describe('stream', () => {
    it('should yield stream events and end', async () => {
      transport = new WebSocketTransport(`ws://127.0.0.1:${port}`);
      const ws = await waitForServerConnection();

      // First do init to unblock the init gate
      const initPromise = transport.request('init', { cek: 'test' });
      const initMsg = await nextServerMessage(ws);
      serverSend(ws, {
        kind: 'response',
        requestId: (initMsg as RequestEnvelope).requestId,
        result: { status: 'fresh' },
      });
      await initPromise;

      // Start a stream — the generator body won't send the request until
      // we call next(), so kick it off concurrently with the server read.
      const stream = transport.stream('attachChat', { chatId: 'c1' });
      const iterator = stream[Symbol.asyncIterator]();

      // Kick the generator to send the request, and simultaneously listen
      const [ev1, streamMsg] = await Promise.all([
        iterator.next(),
        nextServerMessage(ws).then(msg => {
          const reqId = (msg as RequestEnvelope).requestId;
          serverSend(ws, {
            kind: 'stream_event',
            requestId: reqId,
            seq: 0,
            event: { type: 'chat_updated', chat: { id: 'c1' } },
          });
          serverSend(ws, {
            kind: 'stream_end',
            requestId: reqId,
            status: 'complete',
          });
          return msg;
        }),
      ]);

      expect(ev1.done).toBe(false);
      expect(ev1.done === false && ev1.value.kind).toBe('stream_event');
      expect(streamMsg.kind).toBe('request');

      const ev2 = await iterator.next();
      expect(ev2.done).toBe(false);
      expect(ev2.done === false && ev2.value.kind).toBe('stream_end');
    });

    it('should send stream_cancel when consumer breaks early', async () => {
      transport = new WebSocketTransport(`ws://127.0.0.1:${port}`);
      const ws = await waitForServerConnection();

      // Init
      const initPromise = transport.request('init', { cek: 'test' });
      const initMsg = await nextServerMessage(ws);
      serverSend(ws, {
        kind: 'response',
        requestId: (initMsg as RequestEnvelope).requestId,
        result: { status: 'fresh' },
      });
      await initPromise;

      const stream = transport.stream('attachChat', { chatId: 'c1' });
      const iterator = stream[Symbol.asyncIterator]();

      // Kick the generator and catch the server request concurrently
      let reqId: string;
      const [ev1] = await Promise.all([
        iterator.next(),
        nextServerMessage(ws).then(msg => {
          reqId = (msg as RequestEnvelope).requestId;
          serverSend(ws, {
            kind: 'stream_event',
            requestId: reqId,
            seq: 0,
            event: { type: 'chat_updated', chat: { id: 'c1' } },
          });
          return msg;
        }),
      ]);

      expect(ev1.done).toBe(false);

      // Consumer breaks early
      await iterator.return!();

      // Server should receive a stream_cancel
      const cancelMsg = await nextServerMessage(ws);
      expect(cancelMsg.kind).toBe('stream_cancel');
      expect((cancelMsg as { requestId: string }).requestId).toBe(reqId!);
    });
  });

  // --------------------------------------------------------------------------
  // Init gating
  // --------------------------------------------------------------------------

  describe('init gating', () => {
    it('should allow init() without waiting for a prior init', async () => {
      transport = new WebSocketTransport(`ws://127.0.0.1:${port}`);
      const ws = await waitForServerConnection();

      const initPromise = transport.request('init', { cek: 'test-cek' });
      const msg = await nextServerMessage(ws);
      expect((msg as RequestEnvelope).method).toBe('init');

      serverSend(ws, {
        kind: 'response',
        requestId: (msg as RequestEnvelope).requestId,
        result: { status: 'fresh' },
      });

      await initPromise;
    });
  });

  // --------------------------------------------------------------------------
  // configureWorker (no-op)
  // --------------------------------------------------------------------------

  describe('configureWorker', () => {
    it('should be a no-op', async () => {
      transport = new WebSocketTransport(`ws://127.0.0.1:${port}`);
      await transport.configureWorker({ type: 'local' });
      // No error, no message sent
    });
  });

  // --------------------------------------------------------------------------
  // onReconnect
  // --------------------------------------------------------------------------

  describe('onReconnect', () => {
    it('should fire reconnect callbacks only after the replayed init is acknowledged', async () => {
      transport = new WebSocketTransport(`ws://127.0.0.1:${port}`);
      let ws = await waitForServerConnection();

      const reconnectFired = vi.fn();
      transport.onReconnect(reconnectFired);

      // init first — reconnect re-auth replays the last successful init.
      const initPromise = transport.request('init', { cek: 'test' });
      const initMsg = (await nextServerMessage(ws)) as RequestEnvelope;
      serverSend(ws, {
        kind: 'response',
        requestId: initMsg.requestId,
        result: { status: 'fresh' },
      });
      await initPromise;

      // Disconnect
      ws.close();
      serverSocket = null;

      // Wait for reconnect (backoff is 1s)
      ws = await waitForServerConnection();
      const msgs = bufferMessages(ws);
      const replayedInit = (await msgs.next()) as RequestEnvelope;
      expect(replayedInit.method).toBe('init');

      // Callbacks must NOT fire before the server acknowledges the
      // replayed init — the server's per-connection auth gate would 4001
      // any request they issue.
      expect(reconnectFired).not.toHaveBeenCalled();

      serverSend(ws, {
        kind: 'response',
        requestId: replayedInit.requestId,
        result: { status: 'fresh' },
      });
      await vi.waitFor(() => {
        expect(reconnectFired).toHaveBeenCalledTimes(1);
      });
    }, 10000);
  });

  // --------------------------------------------------------------------------
  // Disconnect during request
  // --------------------------------------------------------------------------

  describe('disconnect handling', () => {
    it('should retry pending one-shot requests after reconnect', async () => {
      // Reconnect has a 1s backoff delay, so this test needs extra time
      transport = new WebSocketTransport(`ws://127.0.0.1:${port}`);
      let ws = await waitForServerConnection();

      // init first
      const initPromise = transport.request('init', { cek: 'test' });
      const initMsg = await nextServerMessage(ws);
      serverSend(ws, {
        kind: 'response',
        requestId: (initMsg as RequestEnvelope).requestId,
        result: { status: 'fresh' },
      });
      await initPromise;

      // Start a request but don't respond
      const reqPromise = transport.request('listProjects', {});
      const origMsg = (await nextServerMessage(ws)) as RequestEnvelope;

      // Kill the connection — the request should be queued for retry
      serverSocket = null;
      ws.close();

      // Wait for reconnect.
      ws = await waitForServerConnection();
      const msgs = bufferMessages(ws);

      // The transport replays init FIRST and waits for the ack before
      // re-sending anything else — the server's auth gate rejects
      // non-exempt frames on a not-yet-authenticated socket.
      const replayedInit = (await msgs.next()) as RequestEnvelope;
      expect(replayedInit.method).toBe('init');
      serverSend(ws, {
        kind: 'response',
        requestId: replayedInit.requestId,
        result: { status: 'fresh' },
      });

      const retriedMsg = (await msgs.next()) as RequestEnvelope;
      expect(retriedMsg.requestId).toBe(origMsg.requestId);

      serverSend(ws, {
        kind: 'response',
        requestId: retriedMsg.requestId,
        result: [],
      });

      const result = await reqPromise;
      expect(result).toEqual([]);
    }, 10000);
  });

  // --------------------------------------------------------------------------
  // Repeated disconnects + auth failure
  // --------------------------------------------------------------------------

  describe('resilience', () => {
    it('replays a pending request across TWO disconnects', async () => {
      transport = new WebSocketTransport(`ws://127.0.0.1:${port}`);
      let ws = await waitForServerConnection();

      const initPromise = transport.request('init', { cek: 'test' });
      const initMsg = (await nextServerMessage(ws)) as RequestEnvelope;
      serverSend(ws, {
        kind: 'response',
        requestId: initMsg.requestId,
        result: { status: 'fresh' },
      });
      await initPromise;

      const reqPromise = transport.request('listProjects', {});
      const origMsg = (await nextServerMessage(ws)) as RequestEnvelope;

      // First drop: ack the replayed init, then drop again before
      // answering the replayed request.
      serverSocket = null;
      ws.close();
      ws = await waitForServerConnection();
      let msgs = bufferMessages(ws);
      const replay1 = (await msgs.next()) as RequestEnvelope;
      expect(replay1.method).toBe('init');
      serverSend(ws, {
        kind: 'response',
        requestId: replay1.requestId,
        result: { status: 'fresh' },
      });
      const retried1 = (await msgs.next()) as RequestEnvelope;
      expect(retried1.requestId).toBe(origMsg.requestId);

      // Second drop — the envelope used to be de-registered after the
      // first replay, hanging the caller's promise forever.
      serverSocket = null;
      ws.close();
      ws = await waitForServerConnection();
      msgs = bufferMessages(ws);
      const replay2 = (await msgs.next()) as RequestEnvelope;
      expect(replay2.method).toBe('init');
      serverSend(ws, {
        kind: 'response',
        requestId: replay2.requestId,
        result: { status: 'fresh' },
      });
      const retried2 = (await msgs.next()) as RequestEnvelope;
      expect(retried2.requestId).toBe(origMsg.requestId);

      serverSend(ws, { kind: 'response', requestId: retried2.requestId, result: [] });
      await expect(reqPromise).resolves.toEqual([]);
    }, 15000);

    it('enters terminal auth_failed when the replayed init is rejected with CEK_MISMATCH', async () => {
      transport = new WebSocketTransport(`ws://127.0.0.1:${port}`);
      let ws = await waitForServerConnection();

      const states: string[] = [];
      transport.onConnectionStateChange(state => states.push(state));

      const initPromise = transport.request('init', { cek: 'test' });
      const initMsg = (await nextServerMessage(ws)) as RequestEnvelope;
      serverSend(ws, {
        kind: 'response',
        requestId: initMsg.requestId,
        result: { status: 'fresh' },
      });
      await initPromise;

      const pendingReq = transport.request('listProjects', {});
      // Swallow the rejection until the assertion below attaches — the
      // reject fires mid-waitFor, long before `expect(...).rejects` runs.
      pendingReq.catch(() => {});

      serverSocket = null;
      ws.close();
      ws = await waitForServerConnection();
      const msgs = bufferMessages(ws);
      const replayedInit = (await msgs.next()) as RequestEnvelope;
      serverSend(ws, {
        kind: 'error',
        requestId: replayedInit.requestId,
        code: 'CEK_MISMATCH',
        message: 'oracle verification failed',
      });

      await vi.waitFor(() => {
        expect(transport.connectionState).toBe('auth_failed');
      });
      // The pending caller fails fast instead of hanging...
      await expect(pendingReq).rejects.toMatchObject({ code: 'CEK_MISMATCH' });
      // ...new RPCs fail fast too...
      await expect(transport.request('listProjects', {})).rejects.toMatchObject({
        code: 'CEK_MISMATCH',
      });
      // ...and the transport stays put (no reconnect loop hammering 4001).
      const connectionsBefore = wss.clients.size;
      await new Promise(r => setTimeout(r, 1500));
      expect(wss.clients.size).toBeLessThanOrEqual(connectionsBefore);
      expect(states).toContain('auth_failed');
    }, 15000);
  });

  // --------------------------------------------------------------------------
  // Outages: callers parked on a gate before the socket opens
  // --------------------------------------------------------------------------

  describe('outage before the gates open', () => {
    /** Next request envelope, skipping heartbeat pings. */
    async function nextRequest(msgs: ReturnType<typeof bufferMessages>): Promise<RequestEnvelope> {
      for (;;) {
        const msg = await msgs.next();
        if (msg.kind === 'request') return msg;
      }
    }

    it('resolves an init issued while the server was down at startup', async () => {
      const downPort = await reservePort();
      transport = new WebSocketTransport(`ws://127.0.0.1:${downPort}`);
      const states: string[] = [];
      transport.onConnectionStateChange(state => states.push(state));

      // Bootstrap's init parks on the connect gate of the first attempt
      const initPromise = transport.request('init', { cek: 'test' });

      // Two failed attempts: each one used to swap the gate for a new one
      await waitForStateCount(states, 'disconnected', 2);

      await stopServer();
      await startServer(downPort);
      const ws = await waitForServerConnection();
      const msgs = bufferMessages(ws);

      const initMsg = await nextRequest(msgs);
      expect(initMsg.method).toBe('init');
      serverSend(ws, { kind: 'response', requestId: initMsg.requestId, result: { ok: true } });

      await expect(initPromise).resolves.toEqual({ ok: true });
      expect(transport.connectionState).toBe('connected');
    }, 15000);

    it('releases an RPC issued mid-outage after a reconnect attempt fails', async () => {
      transport = new WebSocketTransport(`ws://127.0.0.1:${port}`);
      let ws = await waitForServerConnection();
      const initPromise = transport.request('init', { cek: 'test' });
      const initMsg = (await nextServerMessage(ws)) as RequestEnvelope;
      serverSend(ws, { kind: 'response', requestId: initMsg.requestId, result: { ok: true } });
      await initPromise;

      const states: string[] = [];
      transport.onConnectionStateChange(state => states.push(state));
      const serverPort = port;
      await killServer();
      await waitForStateCount(states, 'disconnected', 1);

      // Parks on the gate made by the first reconnect schedule
      const reqPromise = transport.request('listProjects', {});
      // A failed attempt schedules again, which used to replace that gate
      await waitForStateCount(states, 'disconnected', 2);

      await startServer(serverPort);
      ws = await waitForServerConnection();
      const msgs = bufferMessages(ws);

      const replayedInit = await nextRequest(msgs);
      expect(replayedInit.method).toBe('init');
      serverSend(ws, { kind: 'response', requestId: replayedInit.requestId, result: { ok: true } });

      const listMsg = await nextRequest(msgs);
      expect(listMsg.method).toBe('listProjects');
      serverSend(ws, { kind: 'response', requestId: listMsg.requestId, result: [] });
      await expect(reqPromise).resolves.toEqual([]);
    }, 15000);

    it('keeps a never-opened init gate across a reconnect', async () => {
      transport = new WebSocketTransport(`ws://127.0.0.1:${port}`);
      let ws = await waitForServerConnection();

      // Parks on the init gate: nothing has inited yet
      const reqPromise = transport.request('listProjects', {});

      serverSocket = null;
      ws.close();
      ws = await waitForServerConnection();
      const msgs = bufferMessages(ws);

      const initPromise = transport.request('init', { cek: 'test' });
      const initMsg = await nextRequest(msgs);
      expect(initMsg.method).toBe('init');
      serverSend(ws, { kind: 'response', requestId: initMsg.requestId, result: { ok: true } });
      await initPromise;

      const listMsg = await nextRequest(msgs);
      expect(listMsg.method).toBe('listProjects');
      serverSend(ws, { kind: 'response', requestId: listMsg.requestId, result: [] });
      await expect(reqPromise).resolves.toEqual([]);
    }, 10000);
  });

  // --------------------------------------------------------------------------
  // Connection state
  // --------------------------------------------------------------------------

  describe('connectionState', () => {
    it('should transition connecting → connected on initial connect', async () => {
      transport = new WebSocketTransport(`ws://127.0.0.1:${port}`);
      // Before the server accepts, state should be 'connecting'
      expect(transport.connectionState).toBe('connecting');

      await waitForServerConnection();
      // Allow the open event to fire
      await new Promise(r => setTimeout(r, 50));
      expect(transport.connectionState).toBe('connected');
    });

    it('should transition connected → disconnected → reconnecting → connected', async () => {
      transport = new WebSocketTransport(`ws://127.0.0.1:${port}`);
      const ws = await waitForServerConnection();
      await new Promise(r => setTimeout(r, 50));
      expect(transport.connectionState).toBe('connected');

      const states: string[] = [];
      transport.onConnectionStateChange(s => states.push(s));

      // Disconnect
      ws.close();
      serverSocket = null;

      // Wait for reconnect (1s backoff + connect time)
      await new Promise(r => setTimeout(r, 2000));

      expect(states).toContain('disconnected');
      expect(states).toContain('reconnecting');
      expect(states).toContain('connected');
      expect(transport.connectionState).toBe('connected');
    }, 10000);

    it('should support unsubscribe from onConnectionStateChange', async () => {
      transport = new WebSocketTransport(`ws://127.0.0.1:${port}`);
      const ws = await waitForServerConnection();
      await new Promise(r => setTimeout(r, 50));

      const states: string[] = [];
      const unsubscribe = transport.onConnectionStateChange(s => states.push(s));

      // Unsubscribe before disconnect
      unsubscribe();

      ws.close();
      serverSocket = null;
      await new Promise(r => setTimeout(r, 2000));

      // Should not have received any callbacks
      expect(states).toEqual([]);
    }, 10000);
  });

  // --------------------------------------------------------------------------
  // Visibility change
  // --------------------------------------------------------------------------

  describe('visibilitychange', () => {
    it('should send a ping when tab becomes visible and connected', async () => {
      transport = new WebSocketTransport(`ws://127.0.0.1:${port}`);
      const ws = await waitForServerConnection();

      // Init to unblock
      const initPromise = transport.request('init', { cek: 'test' });
      const initMsg = await nextServerMessage(ws);
      serverSend(ws, {
        kind: 'response',
        requestId: (initMsg as RequestEnvelope).requestId,
        result: { status: 'fresh' },
      });
      await initPromise;

      // Drain any heartbeat pings that may have been sent
      await new Promise(r => setTimeout(r, 100));

      // Simulate tab becoming visible
      Object.defineProperty(document, 'visibilityState', {
        value: 'visible',
        writable: true,
        configurable: true,
      });
      document.dispatchEvent(new Event('visibilitychange'));

      // Should receive a ping
      const msg = await nextServerMessage(ws);
      expect(msg.kind).toBe('ping');
    });
  });

  // --------------------------------------------------------------------------
  // dispose
  // --------------------------------------------------------------------------

  describe('dispose', () => {
    it('should suppress reconnect after dispose', async () => {
      transport = new WebSocketTransport(`ws://127.0.0.1:${port}`);
      const ws = await waitForServerConnection();

      const reconnectFired = vi.fn();
      transport.onReconnect(reconnectFired);

      transport.dispose();
      ws.close();
      serverSocket = null;

      // Wait well past the reconnect backoff
      await new Promise(r => setTimeout(r, 2000));
      expect(reconnectFired).not.toHaveBeenCalled();
    }, 10000);

    it('rejects a caller parked on the connect gate', async () => {
      transport = new WebSocketTransport(`ws://127.0.0.1:${await reservePort()}`);
      const initPromise = transport.request('init', { cek: 'test' });
      transport.dispose();
      await expect(initPromise).rejects.toThrow('transport disposed');
    });

    it('rejects a caller parked on the init gate', async () => {
      transport = new WebSocketTransport(`ws://127.0.0.1:${port}`);
      await waitForServerConnection();
      const reqPromise = transport.request('listProjects', {});
      // Let the request get past the connect gate
      await new Promise(r => setTimeout(r, 50));
      transport.dispose();
      await expect(reqPromise).rejects.toThrow('transport disposed');
    });
  });
});
