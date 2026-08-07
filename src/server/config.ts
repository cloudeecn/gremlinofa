/**
 * Server configuration — reads from environment variables with sensible
 * defaults. Validates at startup so the server fails fast on misconfiguration.
 */

import path from 'node:path';
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

/**
 * @param baseDir When set (server started with `--instance-env`), relative
 *   STORAGE_PATH / VFS_BASE_PATH / CLAUDE_AGENT_SESSION_DIR values resolve
 *   against it so the env file's directory acts as the instance root. When
 *   undefined, values pass through untouched (implicit cwd resolution —
 *   the single-instance behavior).
 */
export function loadServerConfig(
  env: NodeJS.ProcessEnv = process.env,
  baseDir?: string
): ServerConfig {
  const resolveMaybe = (p: string) => (baseDir !== undefined ? path.resolve(baseDir, p) : p);

  const port = parseInt(env.PORT ?? '3100', 10);
  if (Number.isNaN(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT: ${env.PORT}`);
  }

  const host = env.HOST ?? '127.0.0.1';
  const storagePath = resolveMaybe(env.STORAGE_PATH ?? './data/gremlin.db');

  const vfsModeRaw = env.VFS_MODE ?? 'filesystem';
  if (vfsModeRaw !== 'encrypted' && vfsModeRaw !== 'filesystem') {
    throw new Error(`Invalid VFS_MODE: ${vfsModeRaw} (expected 'encrypted' or 'filesystem')`);
  }
  const vfsMode = vfsModeRaw;

  const vfsBasePath = resolveMaybe(env.VFS_BASE_PATH ?? './data/vfs');
  const vfsAccessConfig = loadVfsAccessConfig(env);

  // Default sits next to the SQLite DB so a single STORAGE_PATH override
  // also relocates claude-agent's working dir. CLAUDE_AGENT_SESSION_DIR
  // wins when set explicitly. storagePath is already baseDir-resolved, so
  // the derived default lands next to the resolved DB.
  const storageDir = storagePath.includes('/')
    ? storagePath.slice(0, storagePath.lastIndexOf('/'))
    : '.';
  const claudeAgentSessionDir = resolveMaybe(
    env.CLAUDE_AGENT_SESSION_DIR ?? `${storageDir}/claude-agent-sessions`
  );

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
