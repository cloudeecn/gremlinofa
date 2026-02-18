/**
 * Per-project promise chain for serializing VFS operations.
 *
 * Every VFS op (read or write) is chained per project so that no two
 * operations on the same project overlap. Different projects run freely
 * in parallel. Errors are isolated: a rejection doesn't break the chain.
 */

const chains = new Map<string, Promise<void>>();

export function withTreeLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(projectId) ?? Promise.resolve();
  const result = prev.then(fn);
  chains.set(
    projectId,
    result.then(
      () => {},
      () => {}
    )
  );
  return result;
}
