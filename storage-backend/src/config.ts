/**
 * Configuration from environment variables
 */

import dotenv from 'dotenv';
import path from 'node:path';

// Not `import 'dotenv/config'`: that skips an env file it can't read without a
// word, and the server would quietly start on defaults instead of your settings.
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
