/**
 * Configuration from environment variables for standalone VFS server.
 */

import 'dotenv/config';
import { loadVfsAccessConfig, type VfsAccessConfig } from '../vfsEngine/accessConfig.js';

function parseCorsOrigin(): string[] | '*' | null {
  const corsOrigin = process.env.CORS_ORIGIN || '';

  if (!corsOrigin) return null;
  if (corsOrigin === '*') return '*';

  return corsOrigin
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean);
}

export interface VfsFacadeConfig {
  port: number;
  corsOrigins: string[] | '*' | null;
  dataDir: string;
  authPassword: string;
  accessConfig: VfsAccessConfig;
}

export const config: VfsFacadeConfig = {
  /** Server port */
  port: parseInt(process.env.PORT || '3003', 10),

  /** CORS origins (null = same-domain only, '*' = allow all, array = specific origins) */
  corsOrigins: parseCorsOrigin(),

  /** Root directory for all user files */
  dataDir: process.env.DATA_DIR || './data',

  /** Server-wide password for Basic Auth (empty/undefined = dev mode) */
  authPassword: process.env.AUTH_PASSWORD || '',

  /** Symlink-follow toggle + extra-root allow-list parsed at startup. */
  accessConfig: loadVfsAccessConfig(),
};
