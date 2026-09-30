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
 *   - The Sidebar remounts on collapse/expand and on every drawer open; the
 *     stream, the snapshot and the resolved chat titles survive that.
 *
 * Chat titles: a loop without a `displayName` is labelled by its chat's
 * title. The store looks each title up once (`getChat`), dedupes in-flight
 * lookups, and remembers failed or empty ones so they aren't retried. A live
 * `chat_title_changed` title always wins over a fetched one. All of that is
 * kept only while the chat has a running loop: a manual rename doesn't reach
 * this stream, so the chat's next loop looks the title up again.
 *
 * Lifecycle:
 *   - `start()` opens the upstream stream. The app shell calls it once init
 *     succeeds, because `useChat` reads `getSnapshot()` without subscribing
 *     (soft-stop seeding) and the Sidebar isn't always mounted. The first
 *     `subscribe()` also starts it.
 *   - The stream is held open for the rest of the page's lifetime, and a
 *     reconnect reopens it even with no React subscriber: reopening every
 *     time the user collapses the sidebar would churn the event buffer and
 *     lose the snapshot.
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
  /** Set by `start()`; from then on a reconnect reopens the stream. */
  private wanted = false;
  private streamStarted = false;
  private abortStream: (() => void) | null = null;
  private unsubReconnect: (() => void) | null = null;
  /** Chat titles: live `chat_title_changed` events plus one-time lookups. */
  private chatTitles: Map<string, string> = new Map();
  private chatTitlesSnapshot: ReadonlyMap<string, string> = new Map();
  /**
   * In-flight title lookups by chat id. The token lets a lookup that
   * resolves after its chat went idle (or was looked up again) drop its
   * result.
   */
  private pendingTitles: Map<string, object> = new Map();
  private pendingTitlesSnapshot: ReadonlySet<string> = new Set();
  /** Chat ids already looked up, successful or not. */
  private attemptedTitles: Set<string> = new Set();

  constructor(client: GremlinClient) {
    this.client = client;
    this.unsubReconnect = this.client.onReconnect(() => {
      // After a WebSocket disconnect+reconnect the old stream is dead
      // (transport pushed stream_end, the for-await loop has unwound and
      // set streamStarted = false). Re-open it so the sidebar and useChat's
      // soft-stop seeding see running loops again.
      if (this.wanted) {
        this.abortStream?.();
        this.abortStream = null;
        this.streamStarted = true;
        void this.startStream();
      }
    });
  }

  /** Open the upstream stream unless it is already open. */
  start = (): void => {
    this.wanted = true;
    if (this.streamStarted) return;
    this.streamStarted = true;
    void this.startStream();
  };

  /**
   * `useSyncExternalStore` subscribe handler. Returns an unsubscribe
   * function. Opens the upstream stream if nothing has yet.
   */
  subscribe = (listener: ActiveLoopsListener): (() => void) => {
    this.listeners.add(listener);
    this.start();
    return () => {
      this.listeners.delete(listener);
    };
  };

  /**
   * `useSyncExternalStore` snapshot getter. Returns the same array
   * reference until the set of loops or one of their fields changes, so
   * title updates and no-op deltas don't re-render the loop rows.
   */
  getSnapshot = (): ActiveLoop[] => this.snapshot;

  /**
   * `useSyncExternalStore` snapshot of known chat titles. Returns the same
   * Map reference until a title arrives or changes.
   */
  getTitlesSnapshot = (): ReadonlyMap<string, string> => this.chatTitlesSnapshot;

  /** `useSyncExternalStore` snapshot of chat ids whose title is still loading. */
  getPendingTitlesSnapshot = (): ReadonlySet<string> => this.pendingTitlesSnapshot;

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
    this.unsubReconnect?.();
    this.unsubReconnect = null;
    this.abortStream?.();
    this.abortStream = null;
    this.wanted = false;
    this.streamStarted = false;
    this.loops.clear();
    this.snapshot = [];
    this.chatTitles.clear();
    this.chatTitlesSnapshot = new Map();
    this.pendingTitles.clear();
    this.pendingTitlesSnapshot = new Set();
    this.attemptedTitles.clear();
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
          // restart). Drop everything; a reconnect or the next subscriber
          // reopens it.
          if (this.loops.size > 0) {
            this.loops.clear();
            const forgot = this.forgetIdleChats();
            this.publish(true, forgot.titles, forgot.pending);
          }
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
    let loopsChanged = false;
    let titlesChanged = false;
    let pendingChanged = false;
    switch (change.type) {
      case 'snapshot':
        this.loops.clear();
        for (const loop of change.loops) {
          this.loops.set(loop.loopId, loop);
          pendingChanged = this.requestTitle(loop) || pendingChanged;
        }
        loopsChanged = true;
        break;
      case 'started':
        this.loops.set(change.loop.loopId, change.loop);
        pendingChanged = this.requestTitle(change.loop);
        loopsChanged = true;
        break;
      case 'updated': {
        const existing = this.loops.get(change.loopId);
        if (!existing) break;
        // Soft-stop is a one-way latch; a status-only delta (e.g. abort)
        // omits the field and must not clear a prior request.
        const softStopRequested = change.softStopRequested ?? existing.softStopRequested;
        if (existing.status === change.status && existing.softStopRequested === softStopRequested) {
          break;
        }
        this.loops.set(change.loopId, { ...existing, status: change.status, softStopRequested });
        loopsChanged = true;
        break;
      }
      case 'ended':
        loopsChanged = this.loops.delete(change.loopId);
        break;
      case 'chat_title_changed':
        if (this.chatTitles.get(change.chatId) !== change.title) {
          this.chatTitles.set(change.chatId, change.title);
          titlesChanged = true;
        }
        break;
    }
    if (loopsChanged) {
      const forgot = this.forgetIdleChats();
      titlesChanged ||= forgot.titles;
      pendingChanged ||= forgot.pending;
    }
    this.publish(loopsChanged, titlesChanged, pendingChanged);
  }

  /**
   * Start the one title lookup this loop's chat will get, if it needs one.
   * Returns whether a lookup started (the pending set changed).
   */
  private requestTitle(loop: ActiveLoop): boolean {
    const { chatId } = loop;
    // Minion sub-loops carry a minion chat id that getChat can't resolve,
    // and their row shows the displayName anyway.
    if (loop.displayName) return false;
    if (this.chatTitles.has(chatId) || this.attemptedTitles.has(chatId)) return false;
    const token = {};
    this.attemptedTitles.add(chatId);
    this.pendingTitles.set(chatId, token);
    void this.lookUpTitle(chatId, token);
    return true;
  }

  private async lookUpTitle(chatId: string, token: object): Promise<void> {
    let title: string | undefined;
    try {
      title = (await this.client.getChat(chatId))?.name;
    } catch (err) {
      console.debug('[ActiveLoopsStore] title lookup failed chatId=%s err=%o', chatId, err);
    }
    // The chat went idle, was looked up again, or dispose() ran meanwhile
    if (this.pendingTitles.get(chatId) !== token) return;
    this.pendingTitles.delete(chatId);
    // A live chat_title_changed that arrived meanwhile is newer
    let titlesChanged = false;
    if (title !== undefined && !this.chatTitles.has(chatId)) {
      this.chatTitles.set(chatId, title);
      titlesChanged = true;
    }
    this.publish(false, titlesChanged, true);
  }

  /**
   * Drop title state for chats with no running loop. Nothing keeps such a
   * title current (manual renames don't reach this stream), so the chat's
   * next loop looks it up again.
   */
  private forgetIdleChats(): { titles: boolean; pending: boolean } {
    const busyChats = new Set<string>();
    for (const loop of this.loops.values()) busyChats.add(loop.chatId);
    let titles = false;
    let pending = false;
    for (const chatId of this.chatTitles.keys()) {
      if (busyChats.has(chatId)) continue;
      this.chatTitles.delete(chatId);
      titles = true;
    }
    for (const chatId of this.pendingTitles.keys()) {
      if (busyChats.has(chatId)) continue;
      this.pendingTitles.delete(chatId);
      pending = true;
    }
    for (const chatId of this.attemptedTitles) {
      if (!busyChats.has(chatId)) this.attemptedTitles.delete(chatId);
    }
    return { titles, pending };
  }

  /** Rebuild the snapshots that changed and tell subscribers. */
  private publish(loops: boolean, titles: boolean, pending: boolean): void {
    if (loops) this.snapshot = Array.from(this.loops.values());
    if (titles) this.chatTitlesSnapshot = new Map(this.chatTitles);
    if (pending) this.pendingTitlesSnapshot = new Set(this.pendingTitles.keys());
    if (loops || titles || pending) this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}
