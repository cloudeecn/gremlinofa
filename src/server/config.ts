/**
 * Server configuration — reads from environment variables with sensible
 * defaults. Validates at startup so the server fails fast on misconfiguration.
 */

import { loadVfsAccessConfig, type VfsAccessConfig } from './vfsEngine/accessConfig.js';

export interface ServerConfig {
  port: number;
  host: string;
  storagePath: string;
  vfsMode: 'encrypted' | 'filesystem';
  vfsBasePath: string;
  vfsAccessConfig: VfsAccessConfig;
  /**
   * Working directory for the spawned `claude` CLI when serving claude-agent
   * provider requests. Defaults to `<dirname(storagePath)>/claude-agent-sessions`
   * so it lands next to the SQLite DB. The SDK doesn't write its session JSONL
   * here (that goes to `$HOME/.claude/projects/...`) — but the dir does need
   * to exist and be writable so the subprocess can chdir into it.
   *
   * Override with `CLAUDE_AGENT_SESSION_DIR` when the storage parent is
   * read-only (typical for `/opt`-style deploys).
   */
  claudeAgentSessionDir: string;
}

export function loadServerConfig(): ServerConfig {
  const port = parseInt(process.env.PORT ?? '3100', 10);
  if (Number.isNaN(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT: ${process.env.PORT}`);
  }

  const host = process.env.HOST ?? '127.0.0.1';
  const storagePath = process.env.STORAGE_PATH ?? './data/gremlin.db';

  const vfsModeRaw = process.env.VFS_MODE ?? 'filesystem';
  if (vfsModeRaw !== 'encrypted' && vfsModeRaw !== 'filesystem') {
    throw new Error(`Invalid VFS_MODE: ${vfsModeRaw} (expected 'encrypted' or 'filesystem')`);
  }
  const vfsMode = vfsModeRaw;

  const vfsBasePath = process.env.VFS_BASE_PATH ?? './data/vfs';
  const vfsAccessConfig = loadVfsAccessConfig();

  // Default sits next to the SQLite DB so a single STORAGE_PATH override
  // also relocates claude-agent's working dir. CLAUDE_AGENT_SESSION_DIR
  // wins when set explicitly.
  const storageDir = storagePath.includes('/')
    ? storagePath.slice(0, storagePath.lastIndexOf('/'))
    : '.';
  const claudeAgentSessionDir =
    process.env.CLAUDE_AGENT_SESSION_DIR ?? `${storageDir}/claude-agent-sessions`;

  return {
    port,
    host,
    storagePath,
    vfsMode,
    vfsBasePath,
    vfsAccessConfig,
    claudeAgentSessionDir,
  };
}
