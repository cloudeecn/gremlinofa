import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadServerConfig } from '../config';

describe('loadServerConfig', () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    // Clear relevant env vars
    delete process.env.PORT;
    delete process.env.HOST;
    delete process.env.STORAGE_PATH;
    delete process.env.VFS_MODE;
    delete process.env.VFS_BASE_PATH;
    delete process.env.VFS_FOLLOW_SYMLINKS;
    delete process.env.VFS_EXTRA_ROOTS;
  });

  afterEach(() => {
    process.env = { ...origEnv };
  });

  it('should return defaults when no env vars set', () => {
    const config = loadServerConfig();
    expect(config).toEqual({
      port: 3100,
      host: '127.0.0.1',
      storagePath: './data/gremlin.db',
      vfsMode: 'filesystem',
      vfsBasePath: './data/vfs',
      vfsAccessConfig: {
        followSymlinks: false,
        globalAllowedRoots: [],
        projectAllowedRoots: new Map(),
      },
    });
  });

  it('should read custom values from env', () => {
    process.env.PORT = '8080';
    process.env.HOST = '0.0.0.0';
    process.env.STORAGE_PATH = '/tmp/test.db';
    process.env.VFS_MODE = 'encrypted';
    process.env.VFS_BASE_PATH = '/tmp/vfs';

    const config = loadServerConfig();
    expect(config.port).toBe(8080);
    expect(config.host).toBe('0.0.0.0');
    expect(config.storagePath).toBe('/tmp/test.db');
    expect(config.vfsMode).toBe('encrypted');
    expect(config.vfsBasePath).toBe('/tmp/vfs');
  });

  it('should throw on invalid PORT', () => {
    process.env.PORT = 'abc';
    expect(() => loadServerConfig()).toThrow('Invalid PORT');
  });

  it('should throw on port out of range', () => {
    process.env.PORT = '99999';
    expect(() => loadServerConfig()).toThrow('Invalid PORT');
  });

  it('should throw on invalid VFS_MODE', () => {
    process.env.VFS_MODE = 'memory';
    expect(() => loadServerConfig()).toThrow('Invalid VFS_MODE');
  });
});
