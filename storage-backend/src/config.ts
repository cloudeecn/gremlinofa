/**
 * Configuration from environment variables
 */

import 'dotenv/config';

/**
 * Parse CORS_ORIGIN into an array of origins or '*' for allow-all
 */
function parseCorsOrigin(): string[] | '*' | null {
  const corsOrigin = process.env.CORS_ORIGIN || '';

  if (!corsOrigin) {
    return null; // Same-domain only
  }

  if (corsOrigin === '*') {
    return '*'; // Allow all
  }

  // Split by comma and trim whitespace
  return corsOrigin
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean);
}

export const config = {
  /** Server port */
  port: parseInt(process.env.PORT || '3001', 10),

  /** CORS origins (null = same-domain only, '*' = allow all, array = specific origins) */
  corsOrigins: parseCorsOrigin(),

  /** SQLite database file path */
  dbPath: process.env.DB_PATH || './data.db',
} as const;
