import dotenv from 'dotenv';
import express from 'express';
import path from 'path';

export type CorsOrigins = string[] | '*' | null;

/** Anything Express accepts for `trust proxy`: a boolean, a hop count, or an address list. */
export type TrustProxySetting = boolean | number | string;

export interface Config {
  port: number;
  /** Bind address; undefined listens on every interface. */
  host: string | undefined;
  /** null = no cross-origin access, '*' = any origin, otherwise exact origins. */
  corsOrigins: CorsOrigins;
  dbPath: string;
  apiPassword: string;
  webPassword: string;
  /** Upper bound on a single long-poll hold, in ms. */
  pollTimeoutMs: number;
  trustProxy: TrustProxySetting;
  /** Sessions idle longer than this are deleted; 0 keeps them forever. */
  sessionRetentionDays: number;
  /** Non-fatal problems for the operator, printed at startup. */
  warnings: string[];
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

/** The value older `.env.example` files shipped; treated as unset. */
const PLACEHOLDER_PASSWORD = 'change-me';
const DEFAULT_DB_PATH = './data/touch-grass.db';
const MIN_POLL_TIMEOUT_MS = 1000;
/** setTimeout's ceiling (2^31 - 1); Node fires anything longer after 1 ms. */
const MAX_POLL_TIMEOUT_MS = 2_147_483_647;
/** A century. Far beyond that, the retention cutoff falls outside the range Date can represent. */
const MAX_SESSION_RETENTION_DAYS = 36_500;

const EMPTY_CORS_WARNING =
  'CORS_ORIGIN is empty, so browsers refuse cross-origin calls: GremlinOFA in worker mode ' +
  '(the hosted web app) cannot reach this backend. Set it to the app origin, e.g. ' +
  'CORS_ORIGIN=https://cloudeecn.github.io. Server-mode GremlinOFA calls from Node and is unaffected.';

const TRUST_ALL_PROXIES_WARNING =
  'TRUST_PROXY=true trusts X-Forwarded-For/-Proto/-Host from any client, so anyone can spoof ' +
  'their address past the login backoff and fake the Secure cookie flag and the Host/Origin ' +
  'check. Set it to loopback, the proxy address, or a hop count of 1.';

type Env = Record<string, string | undefined>;

function readPassword(env: Env, name: string): string {
  const value = env[name] ?? '';
  const hint = 'Generate one with `openssl rand -hex 24`.';
  if (value.trim() === '') {
    throw new ConfigError(`${name} is not set; the server refuses to start without it. ${hint}`);
  }
  if (value === PLACEHOLDER_PASSWORD) {
    throw new ConfigError(`${name} is still the '${PLACEHOLDER_PASSWORD}' placeholder. ${hint}`);
  }
  return value;
}

function readInteger(
  env: Env,
  name: string,
  fallback: number,
  { min, max }: { min: number; max?: number }
): number {
  const raw = env[name]?.trim();
  if (!raw) {
    return fallback;
  }
  const parsed = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(parsed) || parsed < min || (max !== undefined && parsed > max)) {
    const range = max === undefined ? `>= ${min}` : `between ${min} and ${max}`;
    throw new ConfigError(`${name} must be an integer ${range}, got '${raw}'`);
  }
  return parsed;
}

function parseCorsOrigins(raw: string | undefined, warnings: string[]): CorsOrigins {
  const trimmed = raw?.trim() ?? '';
  if (trimmed === '*') {
    return '*';
  }

  const origins: string[] = [];
  for (const entry of trimmed.split(',').map(part => part.trim())) {
    if (!entry) continue;
    let url: URL;
    try {
      url = new URL(entry);
    } catch {
      throw new ConfigError(
        `CORS_ORIGIN entry '${entry}' is not a URL; use scheme and host, e.g. https://cloudeecn.github.io`
      );
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new ConfigError(`CORS_ORIGIN entry '${entry}' must start with http:// or https://`);
    }
    // Browsers send only scheme://host[:port] in Origin, so a path or trailing slash never matches.
    if (url.origin !== entry) {
      warnings.push(`CORS_ORIGIN entry '${entry}' was normalized to '${url.origin}'.`);
    }
    if (!origins.includes(url.origin)) {
      origins.push(url.origin);
    }
  }

  if (origins.length === 0) {
    warnings.push(EMPTY_CORS_WARNING);
    return null;
  }
  return origins;
}

function parseTrustProxy(raw: string | undefined): TrustProxySetting {
  const trimmed = raw?.trim() ?? '';
  if (trimmed === '' || /^false$/i.test(trimmed)) return false;
  if (/^true$/i.test(trimmed)) return true;
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  // Express compiles the address list when the setting is applied, so a typo such as 'lopback'
  // would otherwise surface from createApp as a stack trace. A throwaway app catches it here.
  try {
    express().set('trust proxy', trimmed);
  } catch (err) {
    throw new ConfigError(`TRUST_PROXY '${trimmed}' is not valid: ${(err as Error).message}`);
  }
  return trimmed;
}

/**
 * Loads the env file into `processEnv` without overriding what is already set: the file named by
 * DOTENV_CONFIG_PATH, else .env in the working directory. A missing file is fine, the variables
 * may come from the service manager. Any other read failure throws: dotenv on its own skips the
 * file silently, and the operator would chase "API_PASSWORD is not set" instead.
 */
export function loadEnvFile(processEnv: Env = process.env): void {
  const envPath = processEnv.DOTENV_CONFIG_PATH || undefined;
  const { error } = dotenv.config({ path: envPath, processEnv, quiet: true });
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (!error || code === 'ENOENT') return;
  const reason =
    code === 'EACCES'
      ? 'permission denied (EACCES); it must be readable by the user the server runs as'
      : error.message;
  throw new ConfigError(`Cannot read env file ${path.resolve(envPath ?? '.env')}: ${reason}`);
}

/** Builds the config from an env map. Throws ConfigError naming the variable on bad input. */
export function parseConfig(env: Env): Config {
  const warnings: string[] = [];
  const trustProxy = parseTrustProxy(env.TRUST_PROXY);
  if (trustProxy === true) {
    warnings.push(TRUST_ALL_PROXIES_WARNING);
  }
  return {
    port: readInteger(env, 'PORT', 3004, { min: 0, max: 65535 }),
    host: env.HOST?.trim() || undefined,
    corsOrigins: parseCorsOrigins(env.CORS_ORIGIN, warnings),
    dbPath: env.DB_PATH || DEFAULT_DB_PATH,
    apiPassword: readPassword(env, 'API_PASSWORD'),
    webPassword: readPassword(env, 'WEB_PASSWORD'),
    pollTimeoutMs: readInteger(env, 'POLL_TIMEOUT_MS', 30000, {
      min: MIN_POLL_TIMEOUT_MS,
      max: MAX_POLL_TIMEOUT_MS,
    }),
    trustProxy,
    sessionRetentionDays: readInteger(env, 'SESSION_RETENTION_DAYS', 30, {
      min: 0,
      max: MAX_SESSION_RETENTION_DAYS,
    }),
    warnings,
  };
}

/** Boot-time config. A ConfigError ends the process with its message instead of a stack trace. */
function loadConfig(): Config {
  try {
    loadEnvFile();
    return parseConfig(process.env);
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

export const config: Config = loadConfig();
