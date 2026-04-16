import 'dotenv/config';

function parseCorsOrigin(): string[] | '*' | null {
  const corsOrigin = process.env.CORS_ORIGIN || '';

  if (!corsOrigin) {
    return null;
  }

  if (corsOrigin === '*') {
    return '*';
  }

  return corsOrigin
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean);
}

export const config = {
  port: parseInt(process.env.PORT || '3004', 10),
  corsOrigins: parseCorsOrigin(),
  dbPath: process.env.DB_PATH || './touch-grass.db',
  apiPassword: process.env.API_PASSWORD || '',
  webPassword: process.env.WEB_PASSWORD || '',
  /** Per-request long-poll hold time (ms) */
  pollTimeoutMs: parseInt(process.env.POLL_TIMEOUT_MS || '30000', 10),
} as const;
