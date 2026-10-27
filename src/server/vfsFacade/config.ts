/**
 * Configuration from environment variables for standalone VFS server.
 */

import dotenv from 'dotenv';
import express from 'express';
import path from 'node:path';
import { loadVfsAccessConfig, type VfsAccessConfig } from '../vfsEngine/accessConfig.js';

// Not `import 'dotenv/config'`: that skips an env file it can't read without a
// word, and the server would start in no-password dev mode.
// A missing file is fine (plain environment variables work too).
const envFilePath = process.env.DOTENV_CONFIG_PATH || undefined;
const envFileError: NodeJS.ErrnoException | undefined = dotenv.config({
  path: envFilePath,
  quiet: true,
}).error;
if (envFileError && envFileError.code !== 'ENOENT') {
  console.error(
    `Cannot read env file ${path.resolve(envFilePath ?? '.env')} (${envFileError.code ?? envFileError.message}). ` +
      'It must be readable by the user the server runs as; refusing to start without it.'
  );
  process.exit(1);
}

function parseCorsOrigin(): string[] | '*' | null {
  const corsOrigin = process.env.CORS_ORIGIN || '';

  if (!corsOrigin) return null;
  if (corsOrigin === '*') return '*';

  return corsOrigin
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean);
}

type TrustProxySetting = boolean | number | string;

/** Same values as touch-grass: empty or false, true, a hop count, or Express's address list. */
function parseTrustProxy(): TrustProxySetting {
  const raw = process.env.TRUST_PROXY?.trim() ?? '';
  if (raw === '' || /^false$/i.test(raw)) return false;
  if (/^true$/i.test(raw)) return true;
  if (/^\d+$/.test(raw)) return Number(raw);
  // Express compiles the list when createVfsApp applies it, so a typo would
  // surface there as a stack trace. A throwaway app catches it at boot instead.
  try {
    express().set('trust proxy', raw);
  } catch (err) {
    console.error(`TRUST_PROXY '${raw}' is not valid: ${(err as Error).message}`);
    process.exit(1);
  }
  return raw;
}

export interface VfsFacadeConfig {
  port: number;
  corsOrigins: string[] | '*' | null;
  trustProxy: TrustProxySetting;
  dataDir: string;
  authPassword: string;
  accessConfig: VfsAccessConfig;
}

export const config: VfsFacadeConfig = {
  /** Server port */
  port: parseInt(process.env.PORT || '3003', 10),

  /** CORS origins (null = same-domain only, '*' = allow all, array = specific origins) */
  corsOrigins: parseCorsOrigin(),

  /**
   * Express `trust proxy`. Behind a reverse proxy it lets the auth-failure
   * limiter tell clients apart instead of counting all of them as the proxy.
   */
  trustProxy: parseTrustProxy(),

  /** Root directory for all user files */
  dataDir: process.env.DATA_DIR || './data',

  /** Server-wide password for Basic Auth (empty/undefined = dev mode) */
  authPassword: process.env.AUTH_PASSWORD || '',

  /** Symlink-follow toggle + extra-root allow-list parsed at startup. */
  accessConfig: loadVfsAccessConfig(),
};
