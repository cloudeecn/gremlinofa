/**
 * Core proxy handler. Pipes requests to the target and streams responses back.
 * SSE works naturally because Node streams flow data as it arrives.
 */

import http from 'node:http';
import https from 'node:https';
import { PassThrough } from 'node:stream';
import type { Request, Response } from 'express';
import { config } from './config.js';
import { parseTarget } from './target.js';
import { filterRequestHeaders, filterResponseHeaders } from './headers.js';

export function proxyHandler(req: Request, res: Response): void {
  const target = parseTarget(req.headers['x-proxy-target'] as string | undefined);

  if (typeof target === 'string') {
    const status = target.startsWith('Target domain not allowed') ? 403 : 400;
    res.status(status).json({ error: target });
    return;
  }

  // Build full target path: basePath + request path + query string
  const queryIdx = req.originalUrl.indexOf('?');
  const queryString = queryIdx >= 0 ? req.originalUrl.slice(queryIdx) : '';
  const targetPath = target.basePath + req.path + queryString;

  const filteredHeaders = filterRequestHeaders(
    req.headers as Record<string, string | string[] | undefined>
  );

  // Set Host to target so the upstream server sees the right hostname
  const nonStandardPort =
    (target.protocol === 'https:' && target.port !== 443) ||
    (target.protocol === 'http:' && target.port !== 80);
  filteredHeaders['host'] = target.hostname + (nonStandardPort ? ':' + target.port : '');

  const transport = target.protocol === 'https:' ? https : http;

  let clientDisconnected = false;

  const proxyReq = transport.request(
    {
      hostname: target.hostname,
      port: target.port,
      path: targetPath,
      method: req.method,
      headers: filteredHeaders,
      timeout: config.proxyTimeout,
    },
    proxyRes => {
      const responseHeaders = filterResponseHeaders(
        proxyRes.headers as Record<string, string | string[] | undefined>
      );
      res.writeHead(proxyRes.statusCode ?? 502, responseHeaders);

      if (config.proxyBufferSize > 0) {
        const buffer = new PassThrough({ highWaterMark: config.proxyBufferSize });
        proxyRes.pipe(buffer).pipe(res);
      } else {
        proxyRes.pipe(res);
      }
    }
  );

  // Abort upstream when client disconnects mid-stream (iOS Safari background, etc.)
  res.on('close', () => {
    if (!res.writableFinished) {
      clientDisconnected = true;
      console.debug('Client disconnected, aborting upstream request');
      proxyReq.destroy();
    }
  });

  proxyReq.on('error', err => {
    if (clientDisconnected) {
      console.debug('Upstream aborted after client disconnect');
      return;
    }
    console.debug('Proxy request error:', err.message);
    if (!res.headersSent) {
      res.status(502).json({ error: 'Failed to connect to target', detail: err.message });
    } else {
      res.end();
    }
  });

  proxyReq.on('timeout', () => {
    console.debug('Proxy request timeout');
    proxyReq.destroy();
    if (!res.headersSent) {
      res.status(504).json({ error: 'Target request timed out' });
    }
  });

  // Pipe incoming body straight to the target — no buffering
  req.pipe(proxyReq);
}
