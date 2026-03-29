/**
 * Target URL parsing and domain allowlist validation.
 */

import { config } from './config.js';

export interface ParsedTarget {
  protocol: 'http:' | 'https:';
  hostname: string;
  port: number;
  basePath: string;
}

/**
 * Parse and validate the X-Proxy-Target header.
 * Returns a ParsedTarget on success, or an error string on failure.
 */
export function parseTarget(targetHeader: string | undefined): ParsedTarget | string {
  if (!targetHeader) {
    return 'Missing X-Proxy-Target header';
  }

  let url: URL;
  try {
    url = new URL(targetHeader);
  } catch {
    return 'Invalid X-Proxy-Target URL';
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return 'X-Proxy-Target must use http or https';
  }

  if (config.allowedTargets) {
    const hostname = url.hostname.toLowerCase();
    const allowed = config.allowedTargets.some(
      domain => hostname === domain || hostname.endsWith('.' + domain)
    );
    if (!allowed) {
      return `Target domain not allowed: ${url.hostname}`;
    }
  }

  const defaultPort = url.protocol === 'https:' ? 443 : 80;

  return {
    protocol: url.protocol as 'http:' | 'https:',
    hostname: url.hostname,
    port: url.port ? parseInt(url.port, 10) : defaultPort,
    basePath: url.pathname.replace(/\/$/, ''),
  };
}
