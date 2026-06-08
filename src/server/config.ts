/**
 * Server configuration — reads from environment variables with sensible
 * defaults. Validates at startup so the server fails fast on misconfiguration.
 */

export interface ServerConfig {
  port: number;
  host: string;
  storagePath: string;
  vfsMode: 'encrypted' | 'filesystem';
  vfsBasePath: string;
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

  return { port, host, storagePath, vfsMode, vfsBasePath };
}
