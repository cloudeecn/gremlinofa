/**
 * WebSocket URL normalization + reachability probe for the OOBE "Remote
 * Backend" flow. A wrong URL used to either hang OOBE forever (unreachable
 * host) or throw inside the transport constructor (malformed URL) — the
 * probe surfaces both as a normal, retryable error before any transport is
 * bound.
 */

/**
 * Normalize user input into a valid `ws://` / `wss://` URL.
 *
 * - trims whitespace
 * - `http`/`https` schemes are converted to `ws`/`wss`
 * - schemeless input gets `wss://` on secure pages, `ws://` otherwise
 *
 * Throws with a user-facing message when the result still isn't a valid
 * WebSocket URL.
 */
export function normalizeWsUrl(input: string): string {
  let url = input.trim();
  if (url === '') {
    throw new Error('Please enter the server WebSocket URL');
  }

  if (/^https?:\/\//i.test(url)) {
    url = url.replace(/^http/i, 'ws');
  } else if (!/^wss?:\/\//i.test(url)) {
    // A foreign scheme (ftp://, file://, ...) is a mistake, not something
    // to silently prefix into a ws:// URL.
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
      throw new Error(`'${input.trim()}' is not a valid WebSocket URL`);
    }
    const secure = typeof location !== 'undefined' && location.protocol === 'https:';
    url = `${secure ? 'wss' : 'ws'}://${url}`;
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`'${input.trim()}' is not a valid WebSocket URL`);
  }
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    throw new Error(`'${input.trim()}' is not a valid WebSocket URL`);
  }
  return parsed.toString();
}

/**
 * Probe a Gremlin server: open a raw WebSocket, send `{kind:'ping'}`, and
 * expect a `{kind:'pong'}` frame back. The server answers pings before
 * authentication, so this verifies both reachability and that the endpoint
 * speaks the Gremlin protocol — without touching CEKs or the transport
 * singleton. The probe socket is closed before resolving.
 */
export async function probeGremlinServer(
  wsUrl: string,
  timeoutMs = 5000
): Promise<{ ok: true } | { ok: false; error: string }> {
  return new Promise(resolve => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl);
    } catch (err) {
      resolve({
        ok: false,
        error: err instanceof Error ? err.message : 'invalid WebSocket URL',
      });
      return;
    }

    let settled = false;
    const settle = (result: { ok: true } | { ok: false; error: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        // already closed
      }
      resolve(result);
    };

    const timer = setTimeout(() => {
      settle({ ok: false, error: `no response within ${Math.round(timeoutMs / 1000)}s` });
    }, timeoutMs);

    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ kind: 'ping' }));
    });
    ws.addEventListener('message', ev => {
      try {
        const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)) as {
          kind?: string;
        };
        if (msg.kind === 'pong') {
          settle({ ok: true });
        }
      } catch {
        // Not a Gremlin frame — keep waiting; the timeout decides.
      }
    });
    ws.addEventListener('error', () => {
      settle({ ok: false, error: 'connection failed' });
    });
    ws.addEventListener('close', () => {
      settle({ ok: false, error: 'connection closed before responding' });
    });
  });
}
