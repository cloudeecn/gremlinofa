/**
 * Startup plumbing for the Node server: CLI flag parsing and env-file
 * loading. Lives outside nodeEntry.ts so it can be unit-tested without
 * booting a WebSocket server.
 */

import fs from 'node:fs';
import { parseArgs } from 'node:util';

export interface CliOptions {
  envFile?: string;
  help: boolean;
}

export const USAGE = `Usage: node server.js [options]

Options:
  --instance-env <path>  Load environment from <path> instead of ./.env.
                         Relative STORAGE_PATH / VFS_BASE_PATH /
                         CLAUDE_AGENT_SESSION_DIR values resolve against
                         the file's directory, so one env file fully
                         describes one instance.
  -h, --help             Show this help and exit.

The flag is not called --env-file because Node claims that one for itself
(even after the script path on current Node) with its own parsing dialect
and error handling.
`;

/** Throws on unknown or malformed arguments (parseArgs strict mode). */
export function parseCliOptions(argv: string[]): CliOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      'instance-env': { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  return { envFile: values['instance-env'], help: values.help ?? false };
}

/**
 * Parse env-file content: '#' comments, first-'=' split, trimmed keys and
 * values, no unquoting or expansion. Per-line trim also strips the \r on
 * CRLF files.
 */
export function parseEnvFile(content: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    if (!key) continue;
    vars[key] = trimmed.slice(eqIdx + 1).trim();
  }
  return vars;
}

/**
 * Load `filePath` into `env` without clobbering keys already present —
 * the real environment always wins over env-file values. Returns true if
 * the file was loaded.
 *
 * `required: false` treats a missing file as a no-op (the implicit
 * ./.env); `required: true` turns any read failure (missing, EISDIR,
 * EACCES) into an error naming the file.
 */
export function applyEnvFile(
  filePath: string,
  env: NodeJS.ProcessEnv,
  opts: { required: boolean }
): boolean {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch (e) {
    if (!opts.required) return false;
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Cannot read env file "${filePath}": ${msg}`);
  }
  for (const [key, value] of Object.entries(parseEnvFile(content))) {
    if (!(key in env)) {
      env[key] = value;
    }
  }
  return true;
}
