// @vitest-environment node
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// root reads a file whatever its mode, so a chmod 000 env file proves nothing there
const runningAsRoot = process.getuid?.() === 0;

/** Evaluates config.ts afresh, as a new server process would. */
async function loadConfig() {
  vi.resetModules();
  const { config } = await import('../config.js');
  return config;
}

describe('VFS server env file loading', () => {
  let envDir: string;

  beforeAll(() => {
    envDir = mkdtempSync(path.join(os.tmpdir(), 'vfs-facade-env-'));
  });

  afterAll(() => {
    rmSync(envDir, { recursive: true, force: true });
  });

  afterEach(() => {
    // Also drops whatever dotenv wrote into process.env during the test.
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('loads the env file named by DOTENV_CONFIG_PATH', async () => {
    const envFile = path.join(envDir, 'readable.env');
    writeFileSync(envFile, 'PORT=4567\nAUTH_PASSWORD=from-the-file\n');
    vi.stubEnv('DOTENV_CONFIG_PATH', envFile);
    vi.stubEnv('PORT', undefined);
    vi.stubEnv('AUTH_PASSWORD', undefined);

    const config = await loadConfig();

    expect(config.port).toBe(4567);
    expect(config.authPassword).toBe('from-the-file');
  });

  it('falls back to plain environment variables when the env file is missing', async () => {
    vi.stubEnv('DOTENV_CONFIG_PATH', path.join(envDir, 'missing.env'));
    vi.stubEnv('AUTH_PASSWORD', 'from-the-environment');

    const config = await loadConfig();

    expect(config.authPassword).toBe('from-the-environment');
  });

  it.skipIf(runningAsRoot)(
    'exits 1 instead of starting in dev mode when the env file is unreadable',
    async () => {
      const envFile = path.join(envDir, 'unreadable.env');
      writeFileSync(envFile, 'AUTH_PASSWORD=never-read\n');
      chmodSync(envFile, 0o000);
      vi.stubEnv('DOTENV_CONFIG_PATH', envFile);
      vi.stubEnv('AUTH_PASSWORD', undefined);
      const exit = vi.spyOn(process, 'exit').mockImplementation(code => {
        throw new Error(`process.exit(${code})`);
      });
      const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});

      await expect(loadConfig()).rejects.toThrow('process.exit(1)');

      expect(exit).toHaveBeenCalledWith(1);
      expect(errorLog).toHaveBeenCalledWith(
        expect.stringContaining(`Cannot read env file ${envFile} (EACCES)`)
      );
    }
  );
});
