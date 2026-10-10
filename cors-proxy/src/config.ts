import dotenv from 'dotenv';
import path from 'node:path';

// Not `import 'dotenv/config'`: that skips an env file it can't read without a
// word, and the proxy would start open (no PROXY_AUTH_TOKEN, no ALLOWED_TARGETS).
// A missing file is fine (plain environment variables work too).
const envFilePath = process.env.DOTENV_CONFIG_PATH || undefined;
const envFileError: NodeJS.ErrnoException | undefined = dotenv.config({
  path: envFilePath,
  quiet: true,
}).error;
if (envFileError && envFileError.code !== 'ENOENT') {
  console.error(
    `Cannot read env file ${path.resolve(envFilePath ?? '.env')} (${envFileError.code ?? envFileError.message}). ` +
      'It must be readable by the user the proxy runs as; refusing to start without it.'
  );
  process.exit(1);
}

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
  // Optional shared secret. When set, every proxied request must carry a
  // matching X-Proxy-Auth header. Unset = open proxy (relies on the operator
  // putting it behind an authenticating reverse proxy / private network).
  proxyAuthToken: process.env.PROXY_AUTH_TOKEN || undefined,
} as const;
