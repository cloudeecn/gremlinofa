/**
 * In-memory long-poll waiters, keyed by request id.
 *
 * A request can have several waiters at once (a retrying client whose old connection is still
 * draining, or two tabs), so each id maps to a set and every notification wakes all of them.
 * The database stays the source of truth: an outcome only says why a waiter woke up.
 */

import type { ExpireReason } from './types.js';

export type PollOutcome =
  | { kind: 'answered'; content: string }
  | { kind: 'expired'; reason: ExpireReason }
  /** The request was deleted along with its session. */
  | { kind: 'gone' }
  /** The hold time ran out with nothing happening. */
  | { kind: 'timeout' }
  /** The server is stopping; answer the client with the current state. */
  | { kind: 'shutdown' }
  /** The caller gave up (client disconnected) and will not read the outcome. */
  | { kind: 'detached' };

export interface PendingWait {
  promise: Promise<PollOutcome>;
  /** Stops waiting; the promise settles as `detached`. Safe to call more than once. */
  cancel: () => void;
}

export interface PollRegistry {
  /** Waits until the request is resolved, `timeoutMs` passes, or the registry shuts down. */
  waitForOutcome(requestId: string, timeoutMs: number): PendingWait;
  /** Each notify returns how many waiters it woke. */
  notifyAnswered(requestId: string, content: string): number;
  notifyExpired(requestId: string, reason: ExpireReason): number;
  notifyGone(requestId: string): number;
  /**
   * Shutdown: settles every waiter as `shutdown` so held polls answer instead of pinning their
   * connections open, and makes later waits settle immediately. There is no way back; the
   * server is about to close.
   */
  cancelAll(): number;
  /** Live waiter count for one request, or for all of them. */
  countWaiters(requestId?: string): number;
}

type Settle = (outcome: PollOutcome) => void;

/** One registry per app: the API router waits on it, the web router and shutdown wake it. */
export function createPollRegistry(): PollRegistry {
  const waitersByRequest = new Map<string, Set<Settle>>();
  let shuttingDown = false;

  function removeWaiter(requestId: string, settle: Settle): void {
    const waiters = waitersByRequest.get(requestId);
    if (!waiters) return;
    waiters.delete(settle);
    if (waiters.size === 0) {
      waitersByRequest.delete(requestId);
    }
  }

  function wake(requestId: string, outcome: PollOutcome): number {
    const waiters = waitersByRequest.get(requestId);
    if (!waiters) return 0;
    waitersByRequest.delete(requestId);
    for (const settle of waiters) {
      settle(outcome);
    }
    return waiters.size;
  }

  return {
    waitForOutcome(requestId, timeoutMs) {
      if (shuttingDown) {
        return { promise: Promise.resolve({ kind: 'shutdown' }), cancel: () => {} };
      }

      let settle!: Settle;
      const promise = new Promise<PollOutcome>(resolve => {
        const timer = setTimeout(() => settle({ kind: 'timeout' }), timeoutMs);
        settle = outcome => {
          clearTimeout(timer);
          removeWaiter(requestId, settle);
          resolve(outcome);
        };
      });

      let waiters = waitersByRequest.get(requestId);
      if (!waiters) {
        waiters = new Set();
        waitersByRequest.set(requestId, waiters);
      }
      waiters.add(settle);

      return { promise, cancel: () => settle({ kind: 'detached' }) };
    },

    notifyAnswered: (requestId, content) => wake(requestId, { kind: 'answered', content }),
    notifyExpired: (requestId, reason) => wake(requestId, { kind: 'expired', reason }),
    notifyGone: requestId => wake(requestId, { kind: 'gone' }),

    cancelAll() {
      shuttingDown = true;
      let woken = 0;
      for (const requestId of [...waitersByRequest.keys()]) {
        woken += wake(requestId, { kind: 'shutdown' });
      }
      return woken;
    },

    countWaiters(requestId) {
      if (requestId !== undefined) {
        return waitersByRequest.get(requestId)?.size ?? 0;
      }
      let total = 0;
      for (const waiters of waitersByRequest.values()) {
        total += waiters.size;
      }
      return total;
    },
  };
}
