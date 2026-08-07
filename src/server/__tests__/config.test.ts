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
    delete process.env.CLAUDE_AGENT_SESSION_DIR;
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
      claudeAgentSessionDir: './data/claude-agent-sessions',
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
    // STORAGE_PATH override moves the default claude-agent session dir alongside it.
    expect(config.claudeAgentSessionDir).toBe('/tmp/claude-agent-sessions');
  });

  it('CLAUDE_AGENT_SESSION_DIR overrides the STORAGE_PATH-derived default', () => {
    process.env.STORAGE_PATH = '/opt/gremlinofa-server/data/gremlin.db';
    process.env.CLAUDE_AGENT_SESSION_DIR = '/var/lib/gremlinofa/claude-agent';
    const config = loadServerConfig();
    expect(config.claudeAgentSessionDir).toBe('/var/lib/gremlinofa/claude-agent');
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

  // These pass explicit env objects instead of mutating process.env —
  // loadServerConfig(env, baseDir) makes that possible now.
  describe('baseDir resolution (--instance-env)', () => {
    it('resolves relative paths against baseDir', () => {
      const config = loadServerConfig(
        { STORAGE_PATH: './data/gremlin.db', VFS_BASE_PATH: './data/vfs' },
        '/srv/inst1'
      );
      expect(config.storagePath).toBe('/srv/inst1/data/gremlin.db');
      expect(config.vfsBasePath).toBe('/srv/inst1/data/vfs');
    });

    it('resolves defaults against baseDir, including the derived session dir', () => {
      const config = loadServerConfig({}, '/srv/inst1');
      expect(config.storagePath).toBe('/srv/inst1/data/gremlin.db');
      expect(config.vfsBasePath).toBe('/srv/inst1/data/vfs');
      expect(config.claudeAgentSessionDir).toBe('/srv/inst1/data/claude-agent-sessions');
    });

    it('leaves absolute paths untouched and derives the session dir from them', () => {
      const config = loadServerConfig({ STORAGE_PATH: '/var/db/gremlin.db' }, '/srv/inst1');
      expect(config.storagePath).toBe('/var/db/gremlin.db');
      expect(config.claudeAgentSessionDir).toBe('/var/db/claude-agent-sessions');
    });

    it('resolves a relative explicit CLAUDE_AGENT_SESSION_DIR against baseDir', () => {
      const config = loadServerConfig({ CLAUDE_AGENT_SESSION_DIR: './sessions' }, '/srv/inst1');
      expect(config.claudeAgentSessionDir).toBe('/srv/inst1/sessions');
    });

    it('passes relative paths through verbatim without baseDir', () => {
      const config = loadServerConfig({});
      expect(config.storagePath).toBe('./data/gremlin.db');
      expect(config.vfsBasePath).toBe('./data/vfs');
      expect(config.claudeAgentSessionDir).toBe('./data/claude-agent-sessions');
    });
  });
});
