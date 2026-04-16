/**
 * Frontend store for the sidebar's "Running Loops" section.
 *
 * Subscribes to `gremlinClient.stream('subscribeActiveLoops', ...)` once at
 * app boot, maintains an in-memory map of `ActiveLoop` records keyed by
 * `loopId`, and exposes a React-friendly `useSyncExternalStore` API so the
 * sidebar component can re-render whenever the set of running loops
 * changes.
 *
 * Why a separate store instead of one `useChat` per running loop?
 *   - The Running Loops UI is project-agnostic — it has to render minion
 *     sub-loops that belong to a chat the user isn't currently viewing,
 *     and root loops the user navigated away from.
 *   - The store outlives any single `useChat` instance, so navigating
 *     between projects doesn't tear down the subscription.
 *   - Multiple sidebar instances (e.g. mobile + desktop layouts) can share
 *     the same upstream stream — the store fans out to N React subscribers
 *     from one backend RPC.
 *
 * Lifecycle:
 *   - First `subscribe()` call lazily opens the upstream stream.
 *   - The stream is held open for the rest of the page's lifetime; we don't
 *     unsubscribe when the React subscriber count drops to zero because
 *     reopening every time the user collapses the sidebar would churn the
 *     event buffer and lose the snapshot.
 *   - `dispose()` closes the upstream stream — call it from app teardown
 *     in tests so vitest doesn't leak open streams across files.
 */

import type { ActiveLoop, ActiveLoopsChange, LoopId } from '../../shared/protocol/protocol';
import type { GremlinClient } from './GremlinClient';

export type ActiveLoopsListener = () => void;

export class ActiveLoopsStore {
  private readonly client: GremlinClient;
  private loops: Map<LoopId, ActiveLoop> = new Map();
  private snapshot: ActiveLoop[] = [];
  private listeners: Set<ActiveLoopsListener> = new Set();
  private streamStarted = false;
  private abortStream: (() => void) | null = null;

  constructor(client: GremlinClient) {
    this.client = client;
  }

  /**
   * `useSyncExternalStore` subscribe handler. Returns an unsubscribe
   * function. The first subscriber lazily opens the upstream stream.
   */
  subscribe = (listener: ActiveLoopsListener): (() => void) => {
    this.listeners.add(listener);
    if (!this.streamStarted) {
      this.streamStarted = true;
      void this.startStream();
    }
    return () => {
      this.listeners.delete(listener);
    };
  };

  /**
   * `useSyncExternalStore` snapshot getter. Returns the same array
   * reference until the next change so React's identity check skips
   * re-renders when nothing has actually changed.
   */
  getSnapshot = (): ActiveLoop[] => this.snapshot;

  /**
   * Hard-abort a loop. Wraps `gremlinClient.abortLoop` so the sidebar UI
   * doesn't have to import the client directly. Errors are swallowed and
   * logged — the registry's `ended` broadcast removes the row regardless.
   */
  async abort(loopId: LoopId): Promise<void> {
    try {
      await this.client.abortLoop(loopId);
    } catch (err) {
      console.error('[ActiveLoopsStore] abort failed:', err);
    }
  }

  /** Tear down the upstream subscription. Used by tests. */
  dispose(): void {
    this.abortStream?.();
    this.abortStream = null;
    this.streamStarted = false;
    this.loops.clear();
    this.snapshot = [];
    this.listeners.clear();
  }

  // ==========================================================================
  // Internals
  // ==========================================================================

  private async startStream(): Promise<void> {
    let cancelled = false;
    this.abortStream = () => {
      cancelled = true;
    };
    try {
      const iter = this.client.stream('subscribeActiveLoops', {});
      for await (const env of iter) {
        if (cancelled) return;
        if (env.kind !== 'stream_event') {
          // The subscribeActiveLoops stream is open-ended; a `stream_end`
          // here means the backend tore down (worker reload, server
          // restart). Drop everything and let the next subscriber retry.
          this.loops.clear();
          this.publish();
          this.streamStarted = false;
          return;
        }
        this.applyChange(env.event);
      }
    } catch (err) {
      console.error('[ActiveLoopsStore] subscription failed:', err);
      this.streamStarted = false;
    }
  }

  private applyChange(change: ActiveLoopsChange): void {
    switch (change.type) {
      case 'snapshot':
        this.loops.clear();
        for (const loop of change.loops) {
          this.loops.set(loop.loopId, loop);
        }
        break;
      case 'started':
        this.loops.set(change.loop.loopId, change.loop);
        break;
      case 'updated': {
        const existing = this.loops.get(change.loopId);
        if (existing) {
          this.loops.set(change.loopId, { ...existing, status: change.status });
        }
        break;
      }
      case 'ended':
        this.loops.delete(change.loopId);
        break;
    }
    this.publish();
  }

  private publish(): void {
    // Materialize a fresh array — sidebar uses Array.map and the React
    // identity check needs a different reference to trigger a re-render.
    this.snapshot = Array.from(this.loops.values());
    for (const listener of this.listeners) {
      listener();
    }
  }
}
