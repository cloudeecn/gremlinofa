/**
 * In-memory poll resolver map.
 *
 * When the minion tool long-polls for a human response, a resolver is stored here.
 * When the human submits a response via the web UI, the resolver is called immediately,
 * waking up the long-poll without any database polling.
 */

interface PollWaiter {
  resolve: (content: string) => void;
  timer: ReturnType<typeof setTimeout>;
}

const waiters = new Map<string, PollWaiter>();

/**
 * Wait for a response to a pending request.
 * Returns the human's response content, or null if timed out.
 */
export function waitForResponse(requestId: string, timeoutMs: number): Promise<string | null> {
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      waiters.delete(requestId);
      resolve(null);
    }, timeoutMs);

    waiters.set(requestId, {
      resolve: (content: string) => {
        clearTimeout(timer);
        waiters.delete(requestId);
        resolve(content);
      },
      timer,
    });
  });
}

/**
 * Notify that a request has been answered.
 * If a long-poll is waiting, it resolves immediately.
 * Returns true if a waiter was notified.
 */
export function notifyResponse(requestId: string, content: string): boolean {
  const waiter = waiters.get(requestId);
  if (waiter) {
    waiter.resolve(content);
    return true;
  }
  return false;
}

/**
 * Cancel a pending wait (e.g., on shutdown).
 */
export function cancelWait(requestId: string): void {
  const waiter = waiters.get(requestId);
  if (waiter) {
    clearTimeout(waiter.timer);
    waiters.delete(requestId);
  }
}

/**
 * Clear all pending waiters (for graceful shutdown).
 */
export function clearAll(): void {
  for (const [, waiter] of waiters) {
    clearTimeout(waiter.timer);
  }
  waiters.clear();
}
