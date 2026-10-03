import { describe, it, expect, vi, beforeEach } from 'vitest';

const client = vi.hoisted(() => ({
  configureWorker: vi.fn(async () => {}),
  init: vi.fn(async () => ({ ok: true })),
  deriveUserIdFromCEK: vi.fn(async () => 'derived-user'),
}));

vi.mock('../index', () => ({ gremlinClient: client }));

import { bootstrap, startBootstrap, type BootPhase } from '../bootstrapClient';
import { getStorageConfig, setCachedCEKString, setStorageConfig } from '../../lib/localStorageBoot';

/** A promise plus the function that settles it, for holding a call open. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('bootstrap', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  it('asks for OOBE without touching the backend when there is no CEK', async () => {
    await expect(bootstrap()).resolves.toEqual({ ready: false, needsOOBE: true });
    expect(client.init).not.toHaveBeenCalled();
    expect(client.configureWorker).not.toHaveBeenCalled();
  });

  it('configures the worker, then inits with the stored CEK', async () => {
    setCachedCEKString('cek-1');
    await expect(bootstrap()).resolves.toEqual({ ready: true, needsOOBE: false });
    expect(client.configureWorker).toHaveBeenCalledWith({ type: 'local' });
    expect(client.init).toHaveBeenCalledWith({ cek: 'cek-1' });
  });

  it('skips configureWorker in server mode', async () => {
    setCachedCEKString('cek-1');
    setStorageConfig({ type: 'server', wsUrl: 'wss://example.test/ws' });
    await bootstrap();
    expect(client.configureWorker).not.toHaveBeenCalled();
    expect(client.init).toHaveBeenCalled();
  });

  it('returns the error instead of throwing when the userId derivation fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    setCachedCEKString('cek-1');
    setStorageConfig({ type: 'remote', baseUrl: 'https://s.test', password: '', userId: '' });
    client.deriveUserIdFromCEK.mockRejectedValueOnce(new Error('Backend worker failed to start'));

    await expect(bootstrap()).resolves.toEqual({
      ready: false,
      needsOOBE: false,
      error: 'Backend worker failed to start',
    });
    expect(client.init).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('persists a derived userId so the next boot skips the derivation', async () => {
    setCachedCEKString('cek-1');
    setStorageConfig({ type: 'remote', baseUrl: 'https://s.test', password: 'pw', userId: '' });

    await bootstrap();
    expect(client.configureWorker).toHaveBeenCalledWith({
      type: 'remote',
      baseUrl: 'https://s.test',
      password: 'pw',
      userId: 'derived-user',
    });
    expect(getStorageConfig()).toMatchObject({ userId: 'derived-user' });

    await bootstrap();
    expect(client.deriveUserIdFromCEK).toHaveBeenCalledTimes(1);
  });
});

describe('startBootstrap', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    setCachedCEKString('cek-1');
  });

  it('reports backend → unlock → done to subscribers', async () => {
    const workerReady = deferred();
    const initDone = deferred<{ ok: boolean }>();
    client.configureWorker.mockReturnValueOnce(workerReady.promise);
    client.init.mockReturnValueOnce(initDone.promise);

    const boot = startBootstrap();
    const seen: BootPhase[] = [];
    boot.subscribe(() => seen.push(boot.getPhase()));
    expect(boot.getPhase()).toBe('backend');

    workerReady.resolve();
    await vi.waitFor(() => expect(boot.getPhase()).toBe('unlock'));

    initDone.resolve({ ok: true });
    await expect(boot.result).resolves.toMatchObject({ ready: true });
    expect(seen).toEqual(['unlock', 'done']);
  });

  it('stays on the phase that failed', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    client.init.mockRejectedValueOnce(new Error('CEK_MISMATCH'));

    const boot = startBootstrap();
    await expect(boot.result).resolves.toMatchObject({ error: 'CEK_MISMATCH' });
    expect(boot.getPhase()).toBe('unlock');
    consoleError.mockRestore();
  });

  it('stops notifying after unsubscribe', async () => {
    const boot = startBootstrap();
    const listener = vi.fn();
    boot.subscribe(listener)();
    await boot.result;
    expect(listener).not.toHaveBeenCalled();
  });
});
