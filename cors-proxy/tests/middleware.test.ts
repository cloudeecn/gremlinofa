import { describe, it, expect, vi, beforeEach } from 'vitest';

async function loadCors(corsOrigin: string) {
  vi.resetModules();
  process.env.CORS_ORIGIN = corsOrigin;
  const { cors, EXPOSED_RESPONSE_HEADERS } = await import('../src/middleware.js');
  return { cors, EXPOSED_RESPONSE_HEADERS };
}

function fakeReqRes(headers: Record<string, string>, method = 'GET') {
  const set: Record<string, string> = {};
  const req = { headers, method } as unknown as import('express').Request;
  const res = {
    setHeader: (name: string, value: string) => {
      set[name] = value;
    },
    status: () => res,
    end: () => undefined,
  } as unknown as import('express').Response;
  return { req, res, set };
}

describe('cors middleware exposed headers', () => {
  beforeEach(() => {
    delete process.env.CORS_ORIGIN;
  });

  it('exposes the x-codex-* quota headers on the wildcard branch', async () => {
    const { cors, EXPOSED_RESPONSE_HEADERS } = await loadCors('*');
    const { req, res, set } = fakeReqRes({ origin: 'http://localhost:5173' });
    cors(req, res, () => undefined);
    expect(set['Access-Control-Expose-Headers']).toBe(EXPOSED_RESPONSE_HEADERS);
    expect(EXPOSED_RESPONSE_HEADERS).toContain('x-codex-primary-used-percent');
  });

  it('exposes them on the allow-listed origin branch too', async () => {
    const { cors, EXPOSED_RESPONSE_HEADERS } = await loadCors('http://localhost:5173');
    const { req, res, set } = fakeReqRes({ origin: 'http://localhost:5173' });
    cors(req, res, () => undefined);
    expect(set['Access-Control-Allow-Credentials']).toBe('true');
    expect(set['Access-Control-Expose-Headers']).toBe(EXPOSED_RESPONSE_HEADERS);
  });
});
