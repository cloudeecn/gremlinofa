/**
 * Per-chat session adapter on the frontend.
 *
 * `GremlinSession` is the seam between the React `useChat` hook and the
 * backend's `runLoop` stream. One session lives per active chat view; it
 * owns the bookkeeping for the current loop run (loopId, in-flight stream
 * iterator) and exposes a small command surface — `send`, `resend`,
 * `retry`, `continueLoop`, `resolveContinue`, `softStop`, `abort` — that
 * mirrors the actions a user can take in the chat UI.
 *
 * Event delivery is push-based: the React hook calls `onEvent(handler)`
 * once at mount and the session pumps every `LoopEvent` from the underlying
 * stream into that handler. The hook is responsible for translating events
 * into React state updates (with throttling for streaming chunks). The
 * session itself is React-agnostic — it only deals in promises and
 * callbacks, which makes it equally usable from a Web Worker host or a
 * future test harness.
 *
 * Why a class instead of "iterate the stream from the hook"? Three reasons:
 *
 *   1. **Stable command surface across modes.** `send`, `resend`, `retry`,
 *      `continueLoop`, and `resolveContinue` all open the same `runLoop`
 *      stream with different `RunLoopParams`. The session lets the hook
 *      ask "are we already streaming?" without inspecting AsyncIterables
 *      directly.
 *   2. **Hard-abort needs `loopId`.** The session captures the `loopId`
 *      from the first `loop_started` event and forwards it to
 *      `gremlinClient.abortLoop` / `softStopLoop` regardless of which call
 *      site started the run. The hook doesn't have to thread the id
 *      through every closure.
 *   3. **Future Phase 2 attachment.** When `attachChat` lands as a real
 *      replay channel, the session is the place we'd swap in a different
 *      stream source without changing the React surface.
 */

import type {
  LoopEvent,
  LoopId,
  RunLoopParams,
  StreamEndEnvelope,
  StreamEndStatus,
  StreamEventEnvelope,
} from '../../shared/protocol/protocol';
import type { MessageAttachment } from '../../shared/protocol/types';
import type { GremlinClient } from './GremlinClient';

/**
 * Terminal status callback signature. The session forwards the `stream_end`
 * envelope's status field — useful for distinguishing between
 * `complete | error | aborted | soft_stopped | max_iterations`.
 */
export type SessionEndHandler = (status: StreamEndStatus, detail?: string) => void;

/**
 * Per-event callback signature. The hook receives every `LoopEvent` the
 * session pulls off the stream, in order. The handler is synchronous to
 * keep React state updates atomic per event.
 */
export type SessionEventHandler = (event: LoopEvent) => void;

export class GremlinSession {
  private readonly client: GremlinClient;
  private readonly chatId: string;

  /**
   * Loop id of the currently-running loop, or `null` when idle. Captured
   * from the first `loop_started` event of the active stream and cleared
   * when the stream terminates. The hard-abort and soft-stop methods read
   * this so they can route their RPC calls without the caller having to
   * pass the id back through.
   */
  private currentLoopId: LoopId | null = null;
  private eventHandler: SessionEventHandler | null = null;
  private endHandler: SessionEndHandler | null = null;
  private errorHandler: ((error: Error) => void) | null = null;

  /**
   * The active `attachChat` iterator (if any). The session opens this on
   * `attach()` and disposes it on `dispose()` so the consumer can cancel a
   * long-lived subscription. Stored as the iterator (not the iterable) so
   * we can call `return()` to wake the in-flight `next()` and unwind the
   * server-side generator's `finally` (which unsubscribes from the chat
   * pubsub).
   */
  private attachIterator: AsyncIterator<
    StreamEventEnvelope<'attachChat'> | StreamEndEnvelope
  > | null = null;
  private attachPromise: Promise<void> | null = null;

  constructor(client: GremlinClient, chatId: string) {
    this.client = client;
    this.chatId = chatId;
  }

  // ==========================================================================
  // Subscription
  // ==========================================================================

  /**
   * Register the LoopEvent handler. Replaces any previously-registered
   * handler — sessions are single-consumer by design (the React hook).
   */
  onEvent(handler: SessionEventHandler): void {
    this.eventHandler = handler;
  }

  /** Register the terminal status handler. */
  onEnd(handler: SessionEndHandler): void {
    this.endHandler = handler;
  }

  /**
   * Register an error handler for transport-level failures (one-shot RPC
   * errors and stream rejections). Protocol errors with stable `code`
   * fields surface as `Error` instances with `.code` set.
   */
  onError(handler: (error: Error) => void): void {
    this.errorHandler = handler;
  }

  /** True iff a loop is currently running on this chat (loop_started seen, loop_ended not yet). */
  get isRunning(): boolean {
    return this.currentLoopId !== null;
  }

  /** The id of the currently-running loop, or `null` when idle. */
  get loopId(): LoopId | null {
    return this.currentLoopId;
  }

  // ==========================================================================
  // Commands
  // ==========================================================================

  /**
   * Send a new user message and run the loop. Fires `startLoop` on the
   * backend, which spawns a background driver and broadcasts events via
   * the chat pubsub. The chat-view's active `attach()` subscription picks
   * up the live events. Resolves once the loop has been *started* — not
   * once it ends. Loop completion is signaled via the `loop_ended` event.
   */
  async send(content: string, attachments?: MessageAttachment[]): Promise<void> {
    await this.startLoop({ chatId: this.chatId, mode: 'send', content, attachments });
  }

  /**
   * Resend after editing — the caller is responsible for already having
   * deleted the messages past the edit point. Same fire-and-forget shape
   * as `send`: the loop runs in the background and events flow through
   * `attachChat`.
   */
  async resend(content: string, attachments?: MessageAttachment[]): Promise<void> {
    await this.startLoop({ chatId: this.chatId, mode: 'resend', content, attachments });
  }

  /**
   * Retry from an anchor message: messages strictly after `fromMessageId`
   * are deleted and the loop re-runs from the anchor. Used by the
   * "resend from message" context menu action.
   */
  async retry(fromMessageId: string): Promise<void> {
    await this.startLoop({ chatId: this.chatId, mode: 'retry', fromMessageId });
  }

  /**
   * Continue a soft-stopped or pending-tools loop without adding a new user
   * message. The backend uses the existing message history.
   */
  async continueLoop(): Promise<void> {
    await this.startLoop({ chatId: this.chatId, mode: 'continue' });
  }

  /**
   * "Continue tools" path of `resolvePendingToolCalls`: hand the loop a
   * pre-existing list of tool_use blocks (the unresolved tool calls from
   * the last assistant message) and an optional follow-up user message.
   * The backend's agentic loop executes the tool blocks, persists their
   * results, optionally injects the follow-up message, then continues to
   * the next iteration normally.
   */
  async resolveContinue(
    pendingToolUseBlocks: RunLoopParams['pendingToolUseBlocks'],
    trailingContent?: string,
    trailingAttachments?: MessageAttachment[]
  ): Promise<void> {
    await this.startLoop({
      chatId: this.chatId,
      mode: 'continue',
      pendingToolUseBlocks,
      pendingTrailingContent: trailingContent,
      pendingTrailingAttachments: trailingAttachments,
    });
  }

  /**
   * Soft-stop: ask the running loop to stop at the next tool boundary. The
   * loop unwinds with status `soft_stopped`. No-op if no loop is running.
   */
  async softStop(): Promise<void> {
    if (!this.currentLoopId) return;
    await this.client.softStopLoop(this.currentLoopId);
  }

  /**
   * Hard-abort: fire the loop's AbortController. The loop unwinds with
   * status `aborted`, synthesizes a partial assistant message marked
   * `incomplete: true`, and locks the chat from continuation until the
   * user resolves the tail. No-op if no loop is running.
   */
  async abort(): Promise<void> {
    if (!this.currentLoopId) return;
    await this.client.abortLoop(this.currentLoopId);
  }

  /**
   * Open a long-lived `attachChat` subscription on the backend. The first
   * batch of events delivers the chat snapshot (chat_updated +
   * message_created x N from persisted history); after that the session
   * pumps live events from any loop running on this chat — including loops
   * started elsewhere (e.g. by the project view's `startLoop` call before
   * navigation).
   *
   * Idempotent: calling `attach()` more than once is a no-op (the existing
   * subscription continues to deliver events).
   *
   * The returned promise resolves when the stream ends — typically only on
   * `dispose()` or transport error.
   */
  attach(): Promise<void> {
    if (this.attachPromise) return this.attachPromise;
    this.attachPromise = this.consumeAttach().finally(() => {
      this.attachPromise = null;
      this.attachIterator = null;
    });
    return this.attachPromise;
  }

  /**
   * Drop all subscribers and cancel the long-lived `attachChat` stream.
   * Called by the React hook on unmount so stale `setState` callbacks don't
   * fire after the component is gone. The in-flight loop on the backend
   * keeps running — that's by design, so navigating away and coming back
   * resumes the live stream.
   */
  dispose(): void {
    this.eventHandler = null;
    this.endHandler = null;
    this.errorHandler = null;
    if (this.attachIterator) {
      // `return()` rejects the in-flight `next()` with `done: true` and
      // runs the server generator's `finally` block (which unsubscribes
      // from the chat pubsub). Fire-and-forget — we don't need to await it.
      void this.attachIterator.return?.();
      this.attachIterator = null;
    }
  }

  // ==========================================================================
  // Internals
  // ==========================================================================

  /**
   * Trigger a one-shot `startLoop` RPC. Errors thrown synchronously by the
   * backend (CHAT_BUSY, CHAT_INCOMPLETE_TAIL, INVALID_PARAMS, etc.) are
   * forwarded to the error handler so the hook can transition out of the
   * pending state.
   */
  private async startLoop(params: RunLoopParams): Promise<void> {
    try {
      const { loopId } = await this.client.startLoop(params);
      this.currentLoopId = loopId;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.errorHandler?.(error);
      this.endHandler?.('error', error.message);
      throw error;
    }
  }

  /**
   * Pump events from the long-lived `attachChat` stream into the registered
   * handlers. Snapshot events arrive first (chat_updated +
   * message_created x N) followed by live events from any loop running on
   * this chat. The stream stays open until `dispose()` cancels the
   * iterator or the transport surfaces an error.
   *
   * `loop_started` / `loop_ended` events update `currentLoopId` and call
   * the registered `endHandler` so the hook's `loopPhase` state machine
   * stays in sync regardless of who started the loop (chat-view send vs.
   * project-view startLoop).
   */
  private async consumeAttach(): Promise<void> {
    try {
      const iterable = this.client.stream('attachChat', { chatId: this.chatId });
      const iterator = (
        iterable as AsyncIterable<StreamEventEnvelope<'attachChat'> | StreamEndEnvelope>
      )[Symbol.asyncIterator]() as AsyncIterator<
        StreamEventEnvelope<'attachChat'> | StreamEndEnvelope
      >;
      this.attachIterator = iterator;
      while (true) {
        const result = await iterator.next();
        if (result.done) break;
        const env = result.value;
        if (env.kind === 'stream_event') {
          const event = env.event;
          if (event.type === 'loop_started') {
            this.currentLoopId = event.loopId;
          } else if (event.type === 'loop_ended') {
            this.endHandler?.(event.status as StreamEndStatus, event.detail);
            this.currentLoopId = null;
          }
          this.eventHandler?.(event);
        }
        // attachChat is long-lived, so a `stream_end` envelope only arrives
        // when the consumer cancels via `dispose()` or the transport
        // disconnects — both cases unwind via the `result.done` branch above.
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.errorHandler?.(error);
    }
  }
}
