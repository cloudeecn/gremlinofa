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
import { parseCliOptions, applyEnvFile, USAGE, type CliOptions } from './envFile';
import { makeCreateStorageAdapter } from './adapters/createStorageAdapter';
import { makeCreateVfsAdapter } from './adapters/createVfsAdapter';
import { WebSocketTransportServer } from './websocketTransport';
import { GremlinServer } from '../shared/engine/GremlinServer';
import { RemoteVfsAdapter } from '../shared/services/vfs/RemoteVfsAdapter';
import { ClaudeAgentClient } from './claudeAgentClient';
import { installLogTimestamps } from './installLogTimestamps';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// Stamp every server log with an ISO timestamp before anything logs — lets
// interleaved request/turn lines be correlated. Server-only; worker untouched.
installLogTimestamps();

let cli: CliOptions;
try {
  cli = parseCliOptions(process.argv.slice(2));
} catch (e) {
  console.error(`[server] ${e instanceof Error ? e.message : String(e)}\n`);
  console.error(USAGE);
  process.exit(1);
}
if (cli.help) {
  console.log(USAGE);
  process.exit(0);
}

// Env-file loading only sets vars that aren't already in the environment,
// so explicit env vars or systemd EnvironmentFile entries take precedence.
// With --instance-env the explicit file replaces the implicit ./.env, and
// relative data paths in it resolve against the file's directory (via the
// baseDir passed to loadServerConfig) — one env file per instance lets the
// same build serve several instances on different ports/data roots.
let loadedEnvFile: string | undefined;
let configBaseDir: string | undefined;
if (cli.envFile !== undefined) {
  const resolved = path.resolve(cli.envFile);
  try {
    applyEnvFile(resolved, process.env, { required: true });
  } catch (e) {
    console.error(`[server] ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
  loadedEnvFile = resolved;
  configBaseDir = path.dirname(resolved);
} else {
  const implicit = path.resolve(process.cwd(), '.env');
  if (applyEnvFile(implicit, process.env, { required: false })) {
    loadedEnvFile = implicit;
  }
}

const config = loadServerConfig(process.env, configBaseDir);

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
  envFile: loadedEnvFile ?? '(none)',
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
