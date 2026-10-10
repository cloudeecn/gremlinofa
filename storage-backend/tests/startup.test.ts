import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
// root reads a file whatever its mode, so a chmod 000 env file proves nothing there
const runningAsRoot = process.getuid?.() === 0;

function occupyPort(): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const blocker = net.createServer();
    blocker.once('error', reject);
    blocker.listen(0, () => resolve(blocker));
  });
}

/** Runs the server until it exits. An undefined value in `env` unsets that variable. */
async function runServer(
  env: NodeJS.ProcessEnv
): Promise<{ exitCode: number | null; output: string }> {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: packageRoot,
    env: { ...process.env, DB_PATH: ':memory:', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15_000,
  });
  let output = '';
  child.stdout.on('data', chunk => (output += chunk));
  child.stderr.on('data', chunk => (output += chunk));
  // 'close', not 'exit': only 'close' guarantees stderr has been read to the end.
  const exitCode = await new Promise<number | null>(resolve =>
    child.on('close', code => resolve(code))
  );
  return { exitCode, output };
}

describe('startup', () => {
  let blocker: net.Server;
  let takenPort: number;
  let envDir: string;

  beforeAll(async () => {
    blocker = await occupyPort();
    takenPort = (blocker.address() as net.AddressInfo).port;
    envDir = mkdtempSync(path.join(os.tmpdir(), 'storage-backend-env-'));
  });

  afterAll(() => {
    blocker.close();
    rmSync(envDir, { recursive: true, force: true });
  });

  it('exits 1 instead of claiming to listen when the port is taken', async () => {
    const { exitCode, output } = await runServer({ PORT: String(takenPort) });

    expect(exitCode).toBe(1);
    expect(output).toContain('EADDRINUSE');
    expect(output).not.toContain('listening on port');
  }, 20_000);

  it('loads the env file named by DOTENV_CONFIG_PATH', async () => {
    const envFile = path.join(envDir, 'readable.env');
    writeFileSync(envFile, `PORT=${takenPort}\n`);

    const { exitCode, output } = await runServer({ PORT: undefined, DOTENV_CONFIG_PATH: envFile });

    // The taken port can only have come from the file.
    expect(exitCode).toBe(1);
    expect(output).toContain(`failed to listen on port ${takenPort}`);
  }, 20_000);

  it('starts without an env file when DOTENV_CONFIG_PATH names a missing one', async () => {
    const { exitCode, output } = await runServer({
      PORT: String(takenPort),
      DOTENV_CONFIG_PATH: path.join(envDir, 'missing.env'),
    });

    // Got past config and as far as binding the port.
    expect(exitCode).toBe(1);
    expect(output).toContain('EADDRINUSE');
    expect(output).not.toContain('Cannot read env file');
  }, 20_000);

  it.skipIf(runningAsRoot)(
    'refuses to start when the env file is unreadable',
    async () => {
      const envFile = path.join(envDir, 'unreadable.env');
      writeFileSync(envFile, 'PORT=0\n');
      chmodSync(envFile, 0o000);

      const { exitCode, output } = await runServer({
        PORT: undefined,
        DOTENV_CONFIG_PATH: envFile,
      });

      expect(exitCode).toBe(1);
      expect(output).toContain(`Cannot read env file ${envFile} (EACCES)`);
      expect(output).not.toContain('listening on port');
    },
    20_000
  );
});
