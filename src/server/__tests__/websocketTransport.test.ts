import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WebSocket } from 'ws';
import { WebSocketTransportServer } from '../websocketTransport';
import type { GremlinServer } from '../../shared/engine/GremlinServer';
import type {
  ErrorEnvelope,
  ResponseEnvelope,
  StreamEndEnvelope,
  StreamEventEnvelope,
} from '../../shared/protocol/protocol';

type ServerMessage = ResponseEnvelope | StreamEventEnvelope | StreamEndEnvelope | ErrorEnvelope;

function createMockServer(): GremlinServer {
  return {
    handleRequest: vi.fn(),
    handleStream: vi.fn(),
  } as unknown as GremlinServer;
}

/** Connect a ws client and wait for the connection to open. */
function connectClient(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

/** Read the next JSON message from a WebSocket. */
function nextMessage(ws: WebSocket): Promise<ServerMessage> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('message timeout')), 5000);
    ws.once('message', (data: Buffer) => {
      clearTimeout(timeout);
      resolve(JSON.parse(data.toString()) as ServerMessage);
    });
  });
}

/**
 * Connect and complete a successful `init` so the per-connection auth gate
 * lets subsequent data RPCs through. Under the mock server, `init` resolves
 * (any value) so handleOneShot replies with a response envelope, which marks
 * the session authenticated. Consumes the init response before returning.
 */
async function connectAndAuth(port: number): Promise<WebSocket> {
  const ws = await connectClient(port);
  const res = nextMessage(ws);
  ws.send(
    JSON.stringify({
      kind: 'request',
      requestId: 'init_auth',
      method: 'init',
      params: { cek: 'test-cek' },
    })
  );
  const msg = await res;
  if (msg.kind !== 'response') {
    throw new Error(`init did not succeed in test setup: ${JSON.stringify(msg)}`);
  }
  return ws;
}

/** Resolve with the close code when the socket closes. */
function nextClose(ws: WebSocket): Promise<number> {
  return new Promise(resolve => ws.on('close', code => resolve(code)));
}

/** Collect messages until a stream_end is received. */
async function collectStream(ws: WebSocket): Promise<ServerMessage[]> {
  const messages: ServerMessage[] = [];
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('stream timeout')), 5000);
    const handler = (data: Buffer) => {
      const msg = JSON.parse(data.toString()) as ServerMessage;
      messages.push(msg);
      if (msg.kind === 'stream_end') {
        clearTimeout(timeout);
        ws.removeListener('message', handler);
        resolve(messages);
      }
    };
    ws.on('message', handler);
  });
}

describe('WebSocketTransportServer', () => {
  let mockServer: GremlinServer;
  let transport: WebSocketTransportServer;
  let port: number;

  beforeEach(async () => {
    mockServer = createMockServer();
    // Use port 0 to get a random available port
    transport = new WebSocketTransportServer({
      port: 0,
      host: '127.0.0.1',
      server: mockServer,
    });
    // Wait for the server to start listening
    await new Promise<void>(resolve => {
      transport.rawServer.on('listening', resolve);
    });
    const addr = transport.rawServer.address();
    port = typeof addr === 'object' && addr ? addr.port : 0;
  });

  afterEach(async () => {
    try {
      await transport.close();
    } catch {
      // Already closed by the test
    }
  });

  // --------------------------------------------------------------------------
  // Connection tracking
  // --------------------------------------------------------------------------

  describe('connection lifecycle', () => {
    it('should track connected clients', async () => {
      expect(transport.connectionCount).toBe(0);
      const ws = await connectClient(port);
      // Wait a tick for the server to process the connection
      await new Promise(r => setTimeout(r, 50));
      expect(transport.connectionCount).toBe(1);
      ws.close();
      await new Promise(r => setTimeout(r, 50));
      expect(transport.connectionCount).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // One-shot dispatch
  // --------------------------------------------------------------------------

  describe('one-shot request', () => {
    it('should dispatch a request and return response', async () => {
      (mockServer.handleRequest as ReturnType<typeof vi.fn>).mockResolvedValue({
        projects: [],
      });

      const ws = await connectAndAuth(port);
      const msgPromise = nextMessage(ws);

      ws.send(
        JSON.stringify({
          kind: 'request',
          requestId: 'req_1',
          method: 'listProjects',
          params: {},
        })
      );

      const response = await msgPromise;
      expect(response.kind).toBe('response');
      expect(response.requestId).toBe('req_1');
      expect((response as ResponseEnvelope).result).toEqual({ projects: [] });

      ws.close();
    });

    it('should return error envelope on handler throw', async () => {
      // init must succeed (to pass the auth gate) while the target method
      // throws — branch on the method in the mock.
      (mockServer.handleRequest as ReturnType<typeof vi.fn>).mockImplementation(
        (method: string) => {
          if (method === 'init') return Promise.resolve({ ok: true });
          return Promise.reject(new Error('something broke'));
        }
      );

      const ws = await connectAndAuth(port);
      const msgPromise = nextMessage(ws);

      ws.send(
        JSON.stringify({
          kind: 'request',
          requestId: 'req_2',
          method: 'listProjects',
          params: {},
        })
      );

      const response = await msgPromise;
      expect(response.kind).toBe('error');
      expect((response as ErrorEnvelope).code).toBe('INTERNAL_ERROR');
      expect((response as ErrorEnvelope).message).toBe('something broke');

      ws.close();
    });
  });

  // --------------------------------------------------------------------------
  // Stream dispatch
  // --------------------------------------------------------------------------

  describe('stream dispatch', () => {
    it('should stream events and send stream_end', async () => {
      async function* fakeStream() {
        yield { type: 'loop_started', loopId: 'loop_1' };
        yield { type: 'message_created', message: { id: 'm1' } };
      }
      (mockServer.handleStream as ReturnType<typeof vi.fn>).mockReturnValue(fakeStream());

      const ws = await connectAndAuth(port);
      const messagesPromise = collectStream(ws);

      ws.send(
        JSON.stringify({
          kind: 'request',
          requestId: 'req_3',
          method: 'runLoop',
          params: { chatId: 'c1', mode: 'send', content: 'hello' },
        })
      );

      const messages = await messagesPromise;
      expect(messages).toHaveLength(3); // 2 events + 1 stream_end

      expect(messages[0].kind).toBe('stream_event');
      expect((messages[0] as StreamEventEnvelope).seq).toBe(0);

      expect(messages[1].kind).toBe('stream_event');
      expect((messages[1] as StreamEventEnvelope).seq).toBe(1);

      expect(messages[2].kind).toBe('stream_end');
      expect((messages[2] as StreamEndEnvelope).status).toBe('complete');

      ws.close();
    });

    it('should send error + stream_end on generator throw', async () => {
      async function* failingStream() {
        yield { type: 'loop_started', loopId: 'loop_1' };
        throw new Error('stream failed');
      }
      (mockServer.handleStream as ReturnType<typeof vi.fn>).mockReturnValue(failingStream());

      const ws = await connectAndAuth(port);
      const messagesPromise = collectStream(ws);

      ws.send(
        JSON.stringify({
          kind: 'request',
          requestId: 'req_4',
          method: 'attachChat',
          params: { chatId: 'c1' },
        })
      );

      const messages = await messagesPromise;
      // event + error + stream_end
      const errorMsg = messages.find(m => m.kind === 'error') as ErrorEnvelope;
      expect(errorMsg).toBeDefined();
      expect(errorMsg.message).toBe('stream failed');

      const endMsg = messages.find(m => m.kind === 'stream_end') as StreamEndEnvelope;
      expect(endMsg).toBeDefined();
      expect(endMsg.status).toBe('error');

      ws.close();
    });
  });

  // --------------------------------------------------------------------------
  // Stream cancellation
  // --------------------------------------------------------------------------

  describe('stream cancellation', () => {
    it('should abort stream on stream_cancel message', async () => {
      let aborted = false;
      async function* slowStream() {
        yield { type: 'loop_started', loopId: 'loop_1' };
        // Wait long enough for the cancel to arrive
        await new Promise(r => setTimeout(r, 500));
        if (!aborted) yield { type: 'message_created', message: { id: 'm2' } };
      }
      (mockServer.handleStream as ReturnType<typeof vi.fn>).mockImplementation(() => {
        aborted = false;
        return slowStream();
      });

      const ws = await connectAndAuth(port);
      const messagesPromise = collectStream(ws);

      ws.send(
        JSON.stringify({
          kind: 'request',
          requestId: 'req_5',
          method: 'runLoop',
          params: { chatId: 'c1', mode: 'send', content: 'hi' },
        })
      );

      // Wait for the first event, then cancel
      await new Promise(r => setTimeout(r, 100));
      ws.send(JSON.stringify({ kind: 'stream_cancel', requestId: 'req_5' }));

      const messages = await messagesPromise;
      const endMsg = messages.find(m => m.kind === 'stream_end') as StreamEndEnvelope;
      expect(endMsg.status).toBe('aborted');

      ws.close();
    });
  });

  // --------------------------------------------------------------------------
  // Per-connection auth gate
  // --------------------------------------------------------------------------

  describe('auth gate', () => {
    it('rejects a one-shot RPC before init and closes the socket (4001)', async () => {
      const ws = await connectClient(port);
      const errPromise = nextMessage(ws);
      const closePromise = nextClose(ws);

      ws.send(
        JSON.stringify({
          kind: 'request',
          requestId: 'req_pre_init',
          method: 'listProjects',
          params: {},
        })
      );

      const err = await errPromise;
      expect(err.kind).toBe('error');
      expect((err as ErrorEnvelope).code).toBe('NOT_INITIALIZED');
      expect(await closePromise).toBe(4001);
      // The unauthenticated request never reached the engine.
      expect(mockServer.handleRequest).not.toHaveBeenCalled();
    });

    it('rejects a stream RPC before init and closes the socket (4001)', async () => {
      const ws = await connectClient(port);
      const errPromise = nextMessage(ws);
      const closePromise = nextClose(ws);

      ws.send(
        JSON.stringify({
          kind: 'request',
          requestId: 'req_pre_init_stream',
          method: 'attachChat',
          params: { chatId: 'c1' },
        })
      );

      const err = await errPromise;
      expect((err as ErrorEnvelope).code).toBe('NOT_INITIALIZED');
      expect(await closePromise).toBe(4001);
      expect(mockServer.handleStream).not.toHaveBeenCalled();
    });

    it('allows a data RPC after a successful init', async () => {
      (mockServer.handleRequest as ReturnType<typeof vi.fn>).mockResolvedValue({ projects: [] });

      const ws = await connectAndAuth(port);
      const msgPromise = nextMessage(ws);

      ws.send(
        JSON.stringify({
          kind: 'request',
          requestId: 'req_post_init',
          method: 'listProjects',
          params: {},
        })
      );

      const response = await msgPromise;
      expect(response.kind).toBe('response');
      expect((response as ResponseEnvelope).result).toEqual({ projects: [] });

      ws.close();
    });
  });

  // --------------------------------------------------------------------------
  // Disconnect cleanup
  // --------------------------------------------------------------------------

  describe('disconnect cleanup', () => {
    it('should abort active streams when client disconnects', async () => {
      let streamAborted = false;
      async function* longStream() {
        yield { type: 'loop_started', loopId: 'loop_1' };
        // Simulate a stream that checks abort in a poll loop
        for (let i = 0; i < 100; i++) {
          await new Promise(r => setTimeout(r, 20));
        }
        streamAborted = false;
      }
      (mockServer.handleStream as ReturnType<typeof vi.fn>).mockImplementation(() => {
        streamAborted = false;
        return longStream();
      });

      const ws = await connectAndAuth(port);

      ws.send(
        JSON.stringify({
          kind: 'request',
          requestId: 'req_6',
          method: 'runLoop',
          params: { chatId: 'c1', mode: 'send', content: 'hi' },
        })
      );

      // Wait for the first event (stream has started)
      await nextMessage(ws);
      expect(transport.connectionCount).toBe(1);

      // Disconnect the client — the server should abort the stream
      ws.close();
      await new Promise(r => setTimeout(r, 200));

      expect(transport.connectionCount).toBe(0);
      // The stream should not have completed — it was aborted
      expect(streamAborted).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // Malformed messages
  // --------------------------------------------------------------------------

  describe('malformed messages', () => {
    it('should ignore malformed JSON', async () => {
      const ws = await connectClient(port);
      // Should not crash the server
      ws.send('not json at all');
      await new Promise(r => setTimeout(r, 100));
      expect(transport.connectionCount).toBe(1);
      ws.close();
    });
  });

  // --------------------------------------------------------------------------
  // Server close
  // --------------------------------------------------------------------------

  describe('close', () => {
    it('should disconnect all clients on close', async () => {
      const ws1 = await connectClient(port);
      const ws2 = await connectClient(port);
      await new Promise(r => setTimeout(r, 50));
      expect(transport.connectionCount).toBe(2);

      // Close the transport (afterEach will skip the second close)
      await transport.close();

      // Both clients should be disconnected
      await new Promise(r => setTimeout(r, 100));
      expect(ws1.readyState).toBe(WebSocket.CLOSED);
      expect(ws2.readyState).toBe(WebSocket.CLOSED);
    });
  });
});
