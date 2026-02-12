/**
 * Per-project async mutex for serializing VFS tree mutations.
 *
 * Every VFS write follows loadTree → modify → saveTree on a single JSON
 * document per project. Without serialization, parallel writes race and
 * the second save silently overwrites the first's changes (lost update).
 *
 * Properties: non-reentrant, FIFO, error-safe (release in finally).
 */

class AsyncMutex {
  private queue: Array<(release: () => void) => void> = [];
  private locked = false;

  async acquire(): Promise<() => void> {
    if (!this.locked) {
      this.locked = true;
      return () => this.release();
    }
    return new Promise(resolve => {
      this.queue.push(resolve);
    });
  }

  private release(): void {
    const next = this.queue.shift();
    if (next) {
      next(() => this.release());
    } else {
      this.locked = false;
    }
  }
}

const locks = new Map<string, AsyncMutex>();

export async function withTreeLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
  let mutex = locks.get(projectId);
  if (!mutex) {
    mutex = new AsyncMutex();
    locks.set(projectId, mutex);
  }
  const release = await mutex.acquire();
  try {
    return await fn();
  } finally {
    release();
  }
}
