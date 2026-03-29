import 'dotenv/config';

function parseCorsOrigin(): string[] | '*' | null {
  const origin = process.env.CORS_ORIGIN;
  if (!origin) return null;
  if (origin.trim() === '*') return '*';
  return origin
    .split(',')
    .map(o => o.trim())
    .filter(Boolean);
}

function parseAllowedTargets(): string[] | null {
  const targets = process.env.ALLOWED_TARGETS || '';
  if (!targets.trim()) return null;
  return targets
    .split(',')
    .map(t => t.trim().toLowerCase())
    .filter(Boolean);
}

export const config = {
  port: parseInt(process.env.PORT || '3002', 10),
  corsOrigins: parseCorsOrigin(),
  allowedTargets: parseAllowedTargets(),
  proxyTimeout: parseInt(process.env.PROXY_TIMEOUT || '120000', 10),
  proxyBufferSize: parseInt(process.env.PROXY_BUFFER_SIZE || '16777216', 10),
} as const;
