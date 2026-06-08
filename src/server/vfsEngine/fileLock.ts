/**
 * Per-file promise-chain lock.
 *
 * All write operations on the same resolved file path serialize through this.
 * Reads are lock-free. Entries are cleaned up when no operations are pending.
 */

const locks = new Map<string, Promise<void>>();

export function withFileLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(filePath) ?? Promise.resolve();
  const next = prev.then(() => fn());
  const voidNext = next.then(
    () => {},
    () => {}
  );
  locks.set(filePath, voidNext);

  // Clean up if no one else queued behind us
  voidNext.then(() => {
    if (locks.get(filePath) === voidNext) {
      locks.delete(filePath);
    }
  });

  return next;
}

/** Visible for testing */
export function _lockMapSize(): number {
  return locks.size;
}
