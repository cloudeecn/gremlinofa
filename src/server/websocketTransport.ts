/**
 * Server-side WebSocket transport for the GremlinOFA Node server.
 *
 * Uses the `ws` package to accept connections. Each connected client gets
 * a session context that tracks active streams so they can be cleaned up
 * on disconnect. The wire format is identical to the worker transport —
 * JSON text frames carrying the standard protocol envelopes.
 *
 * The server dispatches incoming `RequestEnvelope`s to `GremlinServer`
 * for both one-shot and streaming methods. Stream cancellation and
 * disconnect-triggered cleanup abort running generators via
 * `AbortController`.
 */

import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { GremlinServer } from '../shared/engine/GremlinServer';
import { binaryReplacer, binaryReviver } from '../shared/protocol/binaryEncoding';
import { ProtocolError } from '../shared/protocol/protocolError';
import { STREAM_METHODS } from '../shared/protocol/streamMethods';
import type {
  ErrorEnvelope,
  GremlinMethods,
  RequestEnvelope,
  ResponseEnvelope,
  StreamEndEnvelope,
  StreamEventEnvelope,
} from '../shared/protocol/protocol';

interface StreamCancelMessage {
  kind: 'stream_cancel';
  requestId: string;
}

interface PingMessage {
  kind: 'ping';
}

type IncomingWsMessage = RequestEnvelope | StreamCancelMessage | PingMessage;

/** Per-connection session tracking active streams for cleanup on disconnect. */
interface ClientSession {
  ws: WebSocket;
  activeStreams: Map<string, AbortController>;
}

export interface WebSocketTransportOptions {
  port: number;
  host: string;
  server: GremlinServer;
}

/**
 * Manages the WebSocket server lifecycle: accepting connections, dispatching
 * messages to `GremlinServer`, and cleaning up on disconnect.
 */
export class WebSocketTransportServer {
  private readonly wss: WebSocketServer;
  private readonly gremlinServer: GremlinServer;
  private readonly sessions = new Set<ClientSession>();

  constructor(opts: WebSocketTransportOptions) {
    this.gremlinServer = opts.server;
    this.wss = new WebSocketServer({ port: opts.port, host: opts.host });
    this.wss.on('connection', (ws, req) => this.onConnection(ws, req));
  }

  /** Shut down the WebSocket server and abort all active streams. */
  close(): Promise<void> {
    // Abort all active streams across all sessions
    for (const session of this.sessions) {
      for (const controller of session.activeStreams.values()) {
        controller.abort();
      }
      session.ws.close(1001, 'server shutting down');
    }
    this.sessions.clear();

    return new Promise((resolve, reject) => {
      this.wss.close(err => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /** Number of currently connected clients. */
  get connectionCount(): number {
    return this.sessions.size;
  }

  /** The underlying ws server — exposed for tests that need the address. */
  get rawServer(): WebSocketServer {
    return this.wss;
  }

  // ==========================================================================
  // Connection lifecycle
  // ==========================================================================

  private onConnection(ws: WebSocket, _req: IncomingMessage): void {
    const session: ClientSession = {
      ws,
      activeStreams: new Map(),
    };
    this.sessions.add(session);

    ws.on('message', (data: Buffer | string) => {
      let msg: IncomingWsMessage;
      try {
        const text = typeof data === 'string' ? data : data.toString('utf-8');
        msg = JSON.parse(text, binaryReviver) as IncomingWsMessage;
      } catch {
        // Malformed JSON — ignore silently (same as worker behavior)
        return;
      }
      this.onMessage(session, msg);
    });

    ws.on('close', () => {
      // Abort all streams for this connection
      for (const controller of session.activeStreams.values()) {
        controller.abort();
      }
      session.activeStreams.clear();
      this.sessions.delete(session);
    });

    ws.on('error', () => {
      // Error is followed by close — cleanup happens there
    });
  }

  private onMessage(session: ClientSession, msg: IncomingWsMessage): void {
    switch (msg.kind) {
      case 'ping':
        // Respond so the client's heartbeat timer resets.
        this.sendRaw(session, JSON.stringify({ kind: 'pong' }));
        break;
      case 'request': {
        const isStream = STREAM_METHODS.has(msg.method);
        if (isStream) {
          void this.runStream(session, msg);
        } else {
          void this.handleOneShot(session, msg);
        }
        break;
      }
      case 'stream_cancel': {
        const controller = session.activeStreams.get(msg.requestId);
        if (controller) {
          controller.abort();
        }
        break;
      }
    }
  }

  // ==========================================================================
  // One-shot dispatch
  // ==========================================================================

  private async handleOneShot(session: ClientSession, envelope: RequestEnvelope): Promise<void> {
    try {
      const result = await this.gremlinServer.handleRequest(
        envelope.method as keyof GremlinMethods,
        envelope.params
      );
      this.send(session, {
        kind: 'response',
        requestId: envelope.requestId,
        result,
      });
    } catch (err) {
      this.send(session, toErrorEnvelope(envelope.requestId, err));
      // Drop connection on authentication failure — prevents any post-init
      // RPCs from sneaking through on the same socket.
      if (
        envelope.method === 'init' &&
        err instanceof ProtocolError &&
        (err.code === 'CEK_MISMATCH' || err.code === 'CEK_REQUIRED')
      ) {
        session.ws.close(4001, 'authentication failed');
      }
    }
  }

  // ==========================================================================
  // Stream dispatch
  // ==========================================================================

  private async runStream(session: ClientSession, envelope: RequestEnvelope): Promise<void> {
    const controller = new AbortController();
    session.activeStreams.set(envelope.requestId, controller);
    let seq = 0;

    try {
      const gen = this.gremlinServer.handleStream(
        envelope.method as keyof GremlinMethods,
        envelope.params
      );
      for await (const event of gen) {
        if (controller.signal.aborted) break;
        if (session.ws.readyState !== WebSocket.OPEN) break;
        this.send(session, {
          kind: 'stream_event',
          requestId: envelope.requestId,
          seq: seq++,
          event,
        } as StreamEventEnvelope);
      }
      this.send(session, {
        kind: 'stream_end',
        requestId: envelope.requestId,
        status: controller.signal.aborted ? 'aborted' : 'complete',
      });
    } catch (err) {
      this.send(session, toErrorEnvelope(envelope.requestId, err));
      this.send(session, {
        kind: 'stream_end',
        requestId: envelope.requestId,
        status: 'error',
        detail: err instanceof Error ? err.message : String(err),
      });
    } finally {
      session.activeStreams.delete(envelope.requestId);
    }
  }

  // ==========================================================================
  // Wire helpers
  // ==========================================================================

  private send(
    session: ClientSession,
    envelope: ResponseEnvelope | StreamEventEnvelope | StreamEndEnvelope | ErrorEnvelope
  ): void {
    if (session.ws.readyState === WebSocket.OPEN) {
      session.ws.send(JSON.stringify(envelope, binaryReplacer));
    }
  }

  /** Send a pre-serialized string (used for pong responses). */
  private sendRaw(session: ClientSession, data: string): void {
    if (session.ws.readyState === WebSocket.OPEN) {
      session.ws.send(data);
    }
  }
}

function toErrorEnvelope(requestId: string, err: unknown): ErrorEnvelope {
  if (err instanceof ProtocolError) {
    return {
      kind: 'error',
      requestId,
      code: err.code,
      message: err.message,
      data: err.data,
    };
  }
  return {
    kind: 'error',
    requestId,
    code: 'INTERNAL_ERROR',
    message: err instanceof Error ? err.message : String(err),
  };
}
