import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigError, loadEnvFile, parseConfig } from '../src/config.js';

const BASE_ENV = { API_PASSWORD: 'api-secret', WEB_PASSWORD: 'web-secret' };

describe('parseConfig', () => {
  it('applies defaults', () => {
    const parsed = parseConfig(BASE_ENV);
    expect(parsed).toMatchObject({
      port: 3004,
      host: undefined,
      corsOrigins: null,
      dbPath: './data/touch-grass.db',
      apiPassword: 'api-secret',
      webPassword: 'web-secret',
      pollTimeoutMs: 30000,
      trustProxy: false,
      sessionRetentionDays: 30,
    });
  });

  it('warns that worker-mode clients are blocked when CORS_ORIGIN is empty', () => {
    const { warnings } = parseConfig(BASE_ENV);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/CORS_ORIGIN.*worker mode.*https:\/\/cloudeecn\.github\.io/s);
  });

  it.each(['API_PASSWORD', 'WEB_PASSWORD'])('refuses to boot without %s', name => {
    for (const value of [undefined, '', '   ', 'change-me']) {
      expect(() => parseConfig({ ...BASE_ENV, [name]: value })).toThrow(ConfigError);
      expect(() => parseConfig({ ...BASE_ENV, [name]: value })).toThrow(name);
    }
  });

  it.each(['999', '0', 'abc', '1.5', '-1000', '1e4', '2147483648', '3000000000'])(
    'rejects POLL_TIMEOUT_MS=%s',
    raw => {
      expect(() => parseConfig({ ...BASE_ENV, POLL_TIMEOUT_MS: raw })).toThrow(/POLL_TIMEOUT_MS/);
    }
  );

  it.each([1000, 2147483647])('accepts POLL_TIMEOUT_MS=%i at the edge of the range', value => {
    expect(parseConfig({ ...BASE_ENV, POLL_TIMEOUT_MS: String(value) }).pollTimeoutMs).toBe(value);
  });

  it.each(['-1', '70000', 'http'])('rejects PORT=%s', raw => {
    expect(() => parseConfig({ ...BASE_ENV, PORT: raw })).toThrow(/PORT/);
  });

  it('normalizes CORS_ORIGIN entries to bare origins and warns about each change', () => {
    const parsed = parseConfig({
      ...BASE_ENV,
      CORS_ORIGIN:
        'https://cloudeecn.github.io/, https://app.example/gremlin, http://localhost:5173',
    });
    expect(parsed.corsOrigins).toEqual([
      'https://cloudeecn.github.io',
      'https://app.example',
      'http://localhost:5173',
    ]);
    expect(parsed.warnings).toHaveLength(2);
    expect(parsed.warnings[0]).toContain("'https://cloudeecn.github.io/'");
  });

  it('accepts * for any origin without warnings', () => {
    const parsed = parseConfig({ ...BASE_ENV, CORS_ORIGIN: '*' });
    expect(parsed.corsOrigins).toBe('*');
    expect(parsed.warnings).toEqual([]);
  });

  it.each(['cloudeecn.github.io', 'ftp://files.example', 'https://a.example,*'])(
    'rejects CORS_ORIGIN=%s',
    raw => {
      expect(() => parseConfig({ ...BASE_ENV, CORS_ORIGIN: raw })).toThrow(/CORS_ORIGIN/);
    }
  );

  it.each([
    ['', false],
    ['false', false],
    ['true', true],
    ['TRUE', true],
    ['1', 1],
    ['loopback', 'loopback'],
    ['10.0.0.0/8, loopback', '10.0.0.0/8, loopback'],
  ])('parses TRUST_PROXY=%s', (raw, expected) => {
    expect(parseConfig({ ...BASE_ENV, TRUST_PROXY: raw }).trustProxy).toBe(expected);
  });

  it.each([
    ['lopback', 'invalid IP address: lopback'],
    ['10.0.0.0/33', 'invalid range on address: 10.0.0.0/33'],
    ['loopback, not-an-address', 'invalid IP address: not-an-address'],
  ])('refuses TRUST_PROXY=%s with a ConfigError instead of failing in createApp', (raw, reason) => {
    const parse = () => parseConfig({ ...BASE_ENV, TRUST_PROXY: raw });
    expect(parse).toThrow(ConfigError);
    expect(parse).toThrow(`TRUST_PROXY '${raw}' is not valid: ${reason}`);
  });

  it('warns that TRUST_PROXY=true makes forwarded headers spoofable', () => {
    const { warnings } = parseConfig({ ...BASE_ENV, CORS_ORIGIN: '*', TRUST_PROXY: 'true' });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/X-Forwarded-For.*login backoff.*Secure.*Host\/Origin.*loopback/s);
  });

  it.each(['loopback', '1', '10.0.0.0/8', 'false'])('does not warn for TRUST_PROXY=%s', raw => {
    expect(parseConfig({ ...BASE_ENV, CORS_ORIGIN: '*', TRUST_PROXY: raw }).warnings).toEqual([]);
  });

  it('reads HOST, DB_PATH and SESSION_RETENTION_DAYS', () => {
    const parsed = parseConfig({
      ...BASE_ENV,
      HOST: ' 127.0.0.1 ',
      DB_PATH: ':memory:',
      SESSION_RETENTION_DAYS: '0',
    });
    expect(parsed.host).toBe('127.0.0.1');
    expect(parsed.dbPath).toBe(':memory:');
    expect(parsed.sessionRetentionDays).toBe(0);
  });

  it.each(['-1', '36501', '100000000'])('rejects SESSION_RETENTION_DAYS=%s', raw => {
    expect(() => parseConfig({ ...BASE_ENV, SESSION_RETENTION_DAYS: raw })).toThrow(
      /SESSION_RETENTION_DAYS/
    );
  });

  it('accepts SESSION_RETENTION_DAYS up to a century', () => {
    expect(parseConfig({ ...BASE_ENV, SESSION_RETENTION_DAYS: '36500' }).sessionRetentionDays).toBe(
      36500
    );
  });
});

describe('loadEnvFile', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'touch-grass-env-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('loads DOTENV_CONFIG_PATH without overriding variables that are already set', () => {
    const envFile = path.join(dir, 'custom.env');
    fs.writeFileSync(envFile, "API_PASSWORD='abc#def'\nPORT=4000\n");
    const processEnv: Record<string, string | undefined> = {
      DOTENV_CONFIG_PATH: envFile,
      PORT: '5000',
    };
    loadEnvFile(processEnv);
    expect(processEnv.API_PASSWORD).toBe('abc#def');
    expect(processEnv.PORT).toBe('5000');
  });

  it('carries on when the env file does not exist', () => {
    const processEnv: Record<string, string | undefined> = {
      DOTENV_CONFIG_PATH: path.join(dir, 'missing.env'),
    };
    expect(() => loadEnvFile(processEnv)).not.toThrow();
    expect(processEnv.API_PASSWORD).toBeUndefined();
  });

  it('refuses an env file it cannot read, naming the path', () => {
    expect(() => loadEnvFile({ DOTENV_CONFIG_PATH: dir })).toThrow(ConfigError);
    expect(() => loadEnvFile({ DOTENV_CONFIG_PATH: dir })).toThrow(`Cannot read env file ${dir}:`);
  });

  // root reads a mode-000 file anyway, so there is nothing to refuse there.
  it.skipIf(process.getuid?.() === 0)(
    'says who must be able to read an unreadable env file',
    () => {
      const envFile = path.join(dir, 'locked.env');
      fs.writeFileSync(envFile, 'API_PASSWORD=secret\n');
      fs.chmodSync(envFile, 0o000);
      expect(() => loadEnvFile({ DOTENV_CONFIG_PATH: envFile })).toThrow(
        /locked\.env: permission denied \(EACCES\); it must be readable by the user the server runs as/
      );
    }
  );
});
