/**
 * Configuration from environment variables
 */

import 'dotenv/config';

export const config = {
  /** Server port */
  port: parseInt(process.env.PORT || '3001', 10),

  /** CORS origin (empty = same-domain only) */
  corsOrigin: process.env.CORS_ORIGIN || '',

  /** SQLite database file path */
  dbPath: process.env.DB_PATH || './data.db',
} as const;
