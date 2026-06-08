/**
 * Node server entry point for GremlinOFA.
 *
 * Loads config from env, creates a `GremlinServer` in deferred mode,
 * registers SQLite/filesystem adapter factories, stashes a local storage
 * config, and starts the WebSocket listener. The first client
 * `init({cek})` over WebSocket builds the `BackendDeps` bundle exactly
 * like the worker path.
 */

import { loadServerConfig } from './config';
import { makeCreateStorageAdapter } from './adapters/createStorageAdapter';
import { makeCreateVfsAdapter } from './adapters/createVfsAdapter';
import { WebSocketTransportServer } from './websocketTransport';
import { GremlinServer } from '../shared/engine/GremlinServer';
import { RemoteVfsAdapter } from '../shared/services/vfs/RemoteVfsAdapter';
import { ClaudeAgentClient } from './claudeAgentClient';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// Load .env file if present (no external dependency needed).
// Only sets vars that aren't already in the environment so explicit
// env vars or systemd EnvironmentFile entries take precedence.
const envPath = path.resolve(process.cwd(), '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

const config = loadServerConfig();

// Ensure the data directory exists
const dataDir = path.dirname(config.storagePath);
fs.mkdirSync(dataDir, { recursive: true });
if (config.vfsMode === 'filesystem') {
  fs.mkdirSync(config.vfsBasePath, { recursive: true });
}

// Create deferred-mode server (same as worker)
const server = new GremlinServer(null);

// Register adapter factories (captured config via closure)
server.setBootstrapAdapterFactories({
  createStorageAdapter: makeCreateStorageAdapter(config),
  createVfsAdapter: makeCreateVfsAdapter(config),
  vfsMode: config.vfsMode,
  buildMigrationSourceAdapter: async (project, sourceEncryption) => {
    if (!project.remoteVfsUrl) throw new Error('Project has no remote VFS URL');
    const userId = await sourceEncryption.deriveUserId();
    return new RemoteVfsAdapter({
      baseUrl: project.remoteVfsUrl,
      userId,
      password: project.remoteVfsPassword ?? '',
      projectId: project.id,
    });
  },
});

// Stash storage config — Option A: always local, the SQLite factory
// ignores this and builds from ServerConfig via closure.
server.setBootstrapStorageConfig({ type: 'local' });

// Server-only: register the Claude Agent SDK client. Spawns the host
// `claude` CLI subprocess, so it can only run in Node. Worker entry
// never imports this file → SDK stays out of the worker bundle.
// Session dir resolved from ServerConfig (CLAUDE_AGENT_SESSION_DIR env
// overrides the default); created lazily on first use so a deploy that
// never uses claude-agent doesn't fail at startup on a missing dir.
let claudeAgentSessionDirReady = false;
server.setBootstrapClaudeAgentClientFactory(
  deps =>
    new ClaudeAgentClient(deps, {
      sessionDir: () => {
        if (!claudeAgentSessionDirReady) {
          fs.mkdirSync(config.claudeAgentSessionDir, { recursive: true });
          claudeAgentSessionDirReady = true;
        }
        return config.claudeAgentSessionDir;
      },
    })
);

// Best-effort: warn at startup if the host `claude` CLI is missing.
// The SDK fails at first use otherwise, with a less obvious error.
try {
  const probe = spawnSync('claude', ['--version'], { stdio: 'ignore' });
  if (probe.status !== 0) {
    console.warn(
      '[server] `claude` CLI not detected on PATH — claude-agent provider will fail until it is installed (see https://docs.anthropic.com/claude-code)'
    );
  }
} catch {
  console.warn('[server] `claude` CLI probe failed — claude-agent provider may not work');
}

// --------------------------------------------------------------------------
// WebSocket transport
// --------------------------------------------------------------------------

const wsTransport = new WebSocketTransportServer({
  port: config.port,
  host: config.host,
  server,
});

console.debug('GremlinOFA server listening', {
  port: config.port,
  host: config.host,
  storage: config.storagePath,
  vfsMode: config.vfsMode,
  vfsBasePath: config.vfsBasePath,
});

// --------------------------------------------------------------------------
// Graceful shutdown
// --------------------------------------------------------------------------

async function shutdown(signal: string) {
  console.debug('Received', signal, '— shutting down');

  // Abort all running loops
  for (const loop of server.registry.list()) {
    server.registry.abort(loop.loopId);
  }

  // Close the WebSocket server (aborts active streams + disconnects clients)
  await wsTransport.close();

  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

// Export for testing
export { server, config, wsTransport };
