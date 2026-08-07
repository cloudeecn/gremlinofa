import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseCliOptions, parseEnvFile, applyEnvFile } from '../envFile';

describe('parseCliOptions', () => {
  it('parses --instance-env with a separate value', () => {
    expect(parseCliOptions(['--instance-env', '/etc/gremlin.env'])).toEqual({
      envFile: '/etc/gremlin.env',
      help: false,
    });
  });

  it('parses --instance-env=value form', () => {
    expect(parseCliOptions(['--instance-env=/etc/gremlin.env'])).toEqual({
      envFile: '/etc/gremlin.env',
      help: false,
    });
  });

  // --env-file belongs to Node itself (and current Node intercepts it even
  // after the script path) — we reject it so the collision surfaces loudly.
  it('rejects --env-file as unknown', () => {
    expect(() => parseCliOptions(['--env-file', '/etc/gremlin.env'])).toThrow();
  });

  it('returns no envFile for empty argv', () => {
    expect(parseCliOptions([])).toEqual({ envFile: undefined, help: false });
  });

  it('parses -h and --help', () => {
    expect(parseCliOptions(['-h']).help).toBe(true);
    expect(parseCliOptions(['--help']).help).toBe(true);
  });

  it('throws on unknown flags', () => {
    expect(() => parseCliOptions(['--port', '9999'])).toThrow();
  });

  it('throws on positional arguments', () => {
    expect(() => parseCliOptions(['instance1.env'])).toThrow();
  });
});

describe('parseEnvFile', () => {
  it('parses key=value pairs with trimming', () => {
    expect(parseEnvFile('PORT=3100\n  HOST = 0.0.0.0  \n')).toEqual({
      PORT: '3100',
      HOST: '0.0.0.0',
    });
  });

  it('skips comments, blank lines, and lines without =', () => {
    expect(parseEnvFile('# comment\n\nPORT=3100\nnot a pair\n')).toEqual({ PORT: '3100' });
  });

  it('splits on the first = only', () => {
    expect(parseEnvFile('TOKEN=abc=def==')).toEqual({ TOKEN: 'abc=def==' });
  });

  it('handles CRLF line endings', () => {
    expect(parseEnvFile('PORT=3100\r\nHOST=::1\r\n')).toEqual({ PORT: '3100', HOST: '::1' });
  });

  it('preserves quotes literally (no unquoting)', () => {
    expect(parseEnvFile('GREETING="hello world"')).toEqual({ GREETING: '"hello world"' });
  });

  it('skips empty keys', () => {
    expect(parseEnvFile('=orphan\n  =another\nPORT=1')).toEqual({ PORT: '1' });
  });
});

describe('applyEnvFile', () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  const writeEnvFile = (content: string): string => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gremlin-envfile-'));
    const filePath = path.join(tmpDir, 'instance.env');
    fs.writeFileSync(filePath, content);
    return filePath;
  };

  it('loads vars without clobbering existing keys', () => {
    const filePath = writeEnvFile('PORT=9999\nSTORAGE_PATH=./data/gremlin.db\n');
    const env: NodeJS.ProcessEnv = { PORT: '3100' };
    expect(applyEnvFile(filePath, env, { required: false })).toBe(true);
    expect(env.PORT).toBe('3100'); // real environment wins
    expect(env.STORAGE_PATH).toBe('./data/gremlin.db');
  });

  it('returns false for a missing file when not required', () => {
    const env: NodeJS.ProcessEnv = {};
    expect(applyEnvFile('/nonexistent/gremlin.env', env, { required: false })).toBe(false);
    expect(env).toEqual({});
  });

  it('throws for a missing required file, naming the path', () => {
    expect(() => applyEnvFile('/nonexistent/gremlin.env', {}, { required: true })).toThrow(
      '/nonexistent/gremlin.env'
    );
  });

  it('throws when the required path is a directory', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gremlin-envfile-'));
    expect(() => applyEnvFile(tmpDir!, {}, { required: true })).toThrow('Cannot read env file');
  });
});
