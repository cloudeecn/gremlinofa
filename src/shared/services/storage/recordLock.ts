/**
 * Per-record promise chain for serializing read-modify-write storage ops.
 *
 * Surgical patches (`patchChat`, `patchProject`, `patchMinionChat`) read the
 * latest record, overlay a few fields, and write it back. Without
 * serialization, two patches to the same row each read the same base, overlay
 * disjoint fields, and the second write still drops the first's changes — the
 * exact lost-update the patches are meant to prevent. Chaining every op for a
 * given `key` (e.g. `chats:<id>`) closes that window. Different keys run freely
 * in parallel. Errors are isolated: a rejection doesn't break the chain.
 *
 * The chain is NOT reentrant — a locked op must not, while holding the lock,
 * call another op that locks the same key, or it self-deadlocks. Patches write
 * via private unlocked helpers for this reason.
 *
 * Same shape as VFS's `withTreeLock`, generalized over an arbitrary key.
 */

const chains = new Map<string, Promise<void>>();

export function withKeyedLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve();
  const result = prev.then(fn);
  chains.set(
    key,
    result.then(
      () => {},
      () => {}
    )
  );
  return result;
}
