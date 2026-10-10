import type { Express } from 'express';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import type { PollRegistry } from './pollManager.js';

export interface StartServerOptions {
  app: Express;
  port: number;
  /** Bind address; undefined listens on every interface. */
  host?: string;
  onListening?: (address: AddressInfo) => void;
  /** Bind failures (EADDRINUSE, EACCES, bad HOST) land here instead of crashing the process. */
  onListenError: (err: NodeJS.ErrnoException) => void;
}

export function startServer({
  app,
  port,
  host,
  onListening,
  onListenError,
}: StartServerOptions): Server {
  // Express 5 hands a bind error to the listen callback instead of emitting it unhandled.
  const onListenResult = (err?: Error) => {
    if (err) {
      onListenError(err);
      return;
    }
    onListening?.(server.address() as AddressInfo);
  };
  const server =
    host === undefined ? app.listen(port, onListenResult) : app.listen(port, host, onListenResult);
  return server;
}

/**
 * A connection whose response finishes after close() goes idle but stays open (keep-alive),
 * and close() only reaps the connections that were idle when it ran. Sweeping keeps the
 * graceful path from always running into the hard deadline.
 */
const IDLE_SWEEP_INTERVAL_MS = 100;

export interface ShutdownOptions {
  server: Server;
  /** The registry the app was built with; its held polls are released first. */
  polls: PollRegistry;
  /** Runs exactly once, after the server closed or the deadline forced it closed. */
  onClosed: () => void;
  /** How long held connections get to finish before they are cut. */
  forceCloseAfterMs?: number;
}

/**
 * Returns the signal handler. Held long-polls are answered with their current state (so
 * clients see `pending` and retry against the restarted server), idle keep-alive sockets are
 * closed, and anything still open after the deadline is cut. Repeat signals are ignored.
 */
export function createShutdownHandler({
  server,
  polls,
  onClosed,
  forceCloseAfterMs = 5000,
}: ShutdownOptions): (signal: string) => void {
  let shuttingDown = false;
  let closed = false;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let idleSweep: ReturnType<typeof setInterval> | undefined;

  const finish = () => {
    if (closed) return;
    closed = true;
    clearTimeout(deadline);
    clearInterval(idleSweep);
    onClosed();
  };

  return signal => {
    if (shuttingDown) {
      console.log(`${signal} received, shutdown already in progress`);
      return;
    }
    shuttingDown = true;
    console.log(`${signal} received, shutting down...`);

    const releasedPolls = polls.cancelAll();
    if (releasedPolls > 0) {
      console.log(`Released ${releasedPolls} held poll(s)`);
    }
    server.close(finish);
    server.closeIdleConnections();
    idleSweep = setInterval(() => server.closeIdleConnections(), IDLE_SWEEP_INTERVAL_MS);
    idleSweep.unref();

    deadline = setTimeout(() => {
      console.warn(`Connections still open after ${forceCloseAfterMs} ms, closing them`);
      server.closeAllConnections();
      finish();
    }, forceCloseAfterMs);
    deadline.unref();
  };
}
