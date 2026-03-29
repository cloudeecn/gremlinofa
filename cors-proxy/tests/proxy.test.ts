import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Readable } from 'node:stream';
import express from 'express';
import http from 'node:http';

// --- Mock target server ---

const targetApp = express();

// Echo endpoint: returns request details
targetApp.all('/echo', (req, res) => {
  let body = '';
  req.on('data', chunk => (body += chunk));
  req.on('end', () => {
    res.json({
      method: req.method,
      path: req.path,
      query: req.query,
      headers: req.headers,
      body: body || undefined,
    });
  });
});

// SSE endpoint: streams three events then closes
targetApp.post('/v1/chat/completions', (_req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  const chunks = [
    'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
    'data: [DONE]\n\n',
  ];

  let i = 0;
  const interval = setInterval(() => {
    if (i < chunks.length) {
      res.write(chunks[i]);
      i++;
    } else {
      clearInterval(interval);
      res.end();
    }
  }, 10);
});

// Error endpoint: returns 401
targetApp.get('/unauthorized', (_req, res) => {
  res.status(401).json({ error: 'Invalid API key' });
});

// Custom header echo
targetApp.get('/check-headers', (req, res) => {
  res.json({
    authorization: req.headers['authorization'],
    'x-proxy-target': req.headers['x-proxy-target'],
    host: req.headers['host'],
  });
});

// Burst endpoint: sends chunks with delays to simulate a slow upstream
targetApp.get('/burst', (_req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
  const chunks = ['chunk1|', 'chunk2|', 'chunk3|', 'chunk4|', 'chunk5'];
  let i = 0;
  const interval = setInterval(() => {
    if (i < chunks.length) {
      res.write(chunks[i]);
      i++;
    } else {
      clearInterval(interval);
      res.end();
    }
  }, 20);
});

// Streams indefinitely until client disconnects
targetApp.get('/slow-stream', (_req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
  const interval = setInterval(() => {
    if (!res.destroyed) {
      res.write('ping\n');
    } else {
      clearInterval(interval);
    }
  }, 50);
  res.on('close', () => clearInterval(interval));
});

// --- Proxy server (import app modules) ---
import { cors } from '../src/middleware.js';
import { proxyHandler } from '../src/proxy.js';

const proxyApp = express();
proxyApp.use(cors);
proxyApp.get('/health', (_req, res) => res.json({ status: 'ok' }));
proxyApp.use(proxyHandler);

// --- Test lifecycle ---

let targetServer: http.Server;
let proxyServer: http.Server;
let targetPort: number;
let proxyPort: number;

function proxyUrl(path: string): string {
  return `http://127.0.0.1:${proxyPort}${path}`;
}

function targetBase(): string {
  return `http://127.0.0.1:${targetPort}`;
}

beforeAll(async () => {
  await new Promise<void>(resolve => {
    targetServer = targetApp.listen(0, () => {
      targetPort = (targetServer.address() as { port: number }).port;
      resolve();
    });
  });

  await new Promise<void>(resolve => {
    proxyServer = proxyApp.listen(0, () => {
      proxyPort = (proxyServer.address() as { port: number }).port;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>(resolve => proxyServer.close(() => resolve()));
  await new Promise<void>(resolve => targetServer.close(() => resolve()));
});

// --- Tests ---

describe('health check', () => {
  it('returns ok without X-Proxy-Target', async () => {
    const res = await fetch(proxyUrl('/health'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: 'ok' });
  });
});

describe('request validation', () => {
  it('returns 400 when X-Proxy-Target is missing', async () => {
    const res = await fetch(proxyUrl('/echo'));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('Missing');
  });

  it('returns 400 for invalid URL', async () => {
    const res = await fetch(proxyUrl('/echo'), {
      headers: { 'X-Proxy-Target': 'not-a-url' },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('Invalid');
  });

  it('returns 400 for non-http protocol', async () => {
    const res = await fetch(proxyUrl('/echo'), {
      headers: { 'X-Proxy-Target': 'ftp://example.com' },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('http or https');
  });
});

describe('basic proxying', () => {
  it('forwards GET request with correct path', async () => {
    const res = await fetch(proxyUrl('/echo'), {
      headers: { 'X-Proxy-Target': targetBase() },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.method).toBe('GET');
    expect(body.path).toBe('/echo');
  });

  it('forwards query string', async () => {
    const res = await fetch(proxyUrl('/echo?foo=bar&baz=qux'), {
      headers: { 'X-Proxy-Target': targetBase() },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.query).toEqual({ foo: 'bar', baz: 'qux' });
  });

  it('forwards POST body', async () => {
    const payload = JSON.stringify({ model: 'gpt-4', messages: [{ role: 'user', content: 'hi' }] });
    const res = await fetch(proxyUrl('/echo'), {
      method: 'POST',
      headers: {
        'X-Proxy-Target': targetBase(),
        'Content-Type': 'application/json',
      },
      body: payload,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.method).toBe('POST');
    expect(body.body).toBe(payload);
  });

  it('forwards target base path', async () => {
    // X-Proxy-Target has a path prefix
    const res = await fetch(proxyUrl('/echo'), {
      headers: { 'X-Proxy-Target': targetBase() + '/prefix' },
    });
    // Target sees /prefix/echo
    expect(res.status).toBe(404); // /prefix/echo doesn't exist on mock target
  });

  it('forwards response status from target', async () => {
    const res = await fetch(proxyUrl('/unauthorized'), {
      headers: { 'X-Proxy-Target': targetBase() },
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('Invalid API key');
  });
});

describe('header handling', () => {
  it('strips X-Proxy-Target from forwarded request', async () => {
    const res = await fetch(proxyUrl('/check-headers'), {
      headers: {
        'X-Proxy-Target': targetBase(),
        Authorization: 'Bearer sk-test-key',
      },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body['x-proxy-target']).toBeUndefined();
  });

  it('passes Authorization header through', async () => {
    const res = await fetch(proxyUrl('/check-headers'), {
      headers: {
        'X-Proxy-Target': targetBase(),
        Authorization: 'Bearer sk-test-key',
      },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.authorization).toBe('Bearer sk-test-key');
  });

  it('sets Host to target hostname', async () => {
    const res = await fetch(proxyUrl('/check-headers'), {
      headers: { 'X-Proxy-Target': targetBase() },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.host).toBe(`127.0.0.1:${targetPort}`);
  });
});

describe('SSE streaming', () => {
  it('streams all SSE chunks from target', async () => {
    const res = await fetch(proxyUrl('/v1/chat/completions'), {
      method: 'POST',
      headers: {
        'X-Proxy-Target': targetBase(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ stream: true }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');

    const text = await res.text();
    expect(text).toContain('data: {"choices":[{"delta":{"content":"Hello"}}]}');
    expect(text).toContain('data: {"choices":[{"delta":{"content":" world"}}]}');
    expect(text).toContain('data: [DONE]');
  });
});

describe('error handling', () => {
  it('returns 502 when target is unreachable', async () => {
    const res = await fetch(proxyUrl('/echo'), {
      headers: { 'X-Proxy-Target': 'http://127.0.0.1:1' },
    });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toContain('Failed to connect');
  });
});

describe('CORS', () => {
  it('handles preflight OPTIONS request', async () => {
    const res = await fetch(proxyUrl('/anything'), {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://localhost:5173',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'Content-Type, Authorization, X-Proxy-Target',
      },
    });
    // With default config (CORS_ORIGIN not set), no CORS headers
    // The test env doesn't set CORS_ORIGIN, so this verifies no crash on preflight
    expect(res.status).toBeLessThan(500);
  });
});

describe('response buffering', () => {
  it('delivers all data even when client reads slowly', async () => {
    const res = await fetch(proxyUrl('/burst'), {
      headers: { 'X-Proxy-Target': targetBase() },
    });
    expect(res.status).toBe(200);

    // Read the body slowly via a reader with artificial delays
    const reader = res.body!.getReader();
    const parts: Uint8Array[] = [];
    const decoder = new TextDecoder();
    let done = false;

    while (!done) {
      await new Promise(resolve => setTimeout(resolve, 50));
      const result = await reader.read();
      if (result.value) parts.push(result.value);
      done = result.done;
    }

    const fullBody = decoder.decode(Buffer.concat(parts));
    expect(fullBody).toBe('chunk1|chunk2|chunk3|chunk4|chunk5');
  });
});

describe('client disconnect', () => {
  it('aborts upstream cleanly when client disconnects mid-stream', async () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});

    await new Promise<void>((resolve, reject) => {
      const req = http.request(
        proxyUrl('/slow-stream'),
        { headers: { 'X-Proxy-Target': targetBase() } },
        res => {
          res.once('data', () => {
            // Got data — now kill the connection like iOS Safari would
            req.destroy();
            setTimeout(() => {
              try {
                const messages = debugSpy.mock.calls.map(c => String(c[0]));
                expect(messages.some(m => m.includes('Client disconnected'))).toBe(true);
                expect(messages.some(m => m.includes('Proxy request error'))).toBe(false);
                resolve();
              } catch (err) {
                reject(err);
              } finally {
                debugSpy.mockRestore();
              }
            }, 300);
          });
        }
      );
      req.on('error', () => {
        // Expected — we destroyed the request ourselves
      });
      req.end();
    });
  });
});
