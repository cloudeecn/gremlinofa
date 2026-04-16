import { describe, it, expect } from 'vitest';

import { createStorageAdapter } from '../createStorageAdapter';
import { CachedStorageAdapter } from '../../../shared/services/storage/adapters/CachedStorageAdapter';

describe('createStorageAdapter', () => {
  it('returns a CachedStorageAdapter wrapping IndexedDBAdapter for type=local', () => {
    const adapter = createStorageAdapter({ type: 'local' });

    expect(adapter).toBeInstanceOf(CachedStorageAdapter);
  });

  it('returns a CachedStorageAdapter wrapping RemoteStorageAdapter for type=remote', () => {
    const adapter = createStorageAdapter({
      type: 'remote',
      baseUrl: 'https://example.com/storage',
      password: 'test-password',
      userId: 'test-user-id-64-chars-abcdef1234567890abcdef1234567890abcdef',
    });

    expect(adapter).toBeInstanceOf(CachedStorageAdapter);
  });

  it('handles arbitrary remote URLs and credentials', () => {
    const adapter = createStorageAdapter({
      type: 'remote',
      baseUrl: 'https://my-server.com/api',
      password: 'secret123',
      userId: 'user123456789012345678901234567890123456789012345678901234567890',
    });

    expect(adapter).toBeInstanceOf(CachedStorageAdapter);
  });

  it('handles empty baseUrl for same-origin remote storage', () => {
    const adapter = createStorageAdapter({
      type: 'remote',
      baseUrl: '',
      password: '',
      userId: 'test-user-id-64-chars-abcdef1234567890abcdef1234567890abcdef',
    });

    expect(adapter).toBeInstanceOf(CachedStorageAdapter);
  });

  it('mints independent instances on each call', () => {
    const a = createStorageAdapter({ type: 'local' });
    const b = createStorageAdapter({ type: 'local' });
    expect(a).not.toBe(b);
  });
});
