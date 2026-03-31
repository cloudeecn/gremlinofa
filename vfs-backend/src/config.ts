/**
 * Configuration from environment variables
 */

import 'dotenv/config';

function parseCorsOrigin(): string[] | '*' | null {
  const corsOrigin = process.env.CORS_ORIGIN || '';

  if (!corsOrigin) return null;
  if (corsOrigin === '*') return '*';

  return corsOrigin
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean);
}

export const config = {
  /** Server port */
  port: parseInt(process.env.PORT || '3003', 10),

  /** CORS origins (null = same-domain only, '*' = allow all, array = specific origins) */
  corsOrigins: parseCorsOrigin(),

  /** Root directory for all user files */
  dataDir: process.env.DATA_DIR || './data',

  /** Server-wide password for Basic Auth (empty/undefined = dev mode) */
  authPassword: process.env.AUTH_PASSWORD || '',
} as const;
