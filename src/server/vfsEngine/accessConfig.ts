/**
 * VFS access config: symlink-follow toggle + extra-root allow-list.
 *
 * Loaded from env at startup so misconfig (missing path, malformed token)
 * aborts boot loudly instead of failing per-request later.
 *
 *   VFS_FOLLOW_SYMLINKS=true|false           default false
 *   VFS_EXTRA_ROOTS=/a:/b:projectId|/c       PATH-style, ':'-separated
 *       Bare absolute path  — allowed for all projects.
 *       projectId|absPath   — scoped to one project. projectId must match
 *                             /^[A-Za-z0-9_]+$/ (same as SAFE_SEGMENT).
 */

import fs from 'node:fs';
import path from 'node:path';

export interface VfsAccessConfig {
  followSymlinks: boolean;
  globalAllowedRoots: string[];
  projectAllowedRoots: Map<string, string[]>;
}

const PROJECT_ID_RE = /^[A-Za-z0-9_]+$/;

function parseBool(raw: string | undefined): boolean {
  if (!raw) return false;
  const v = raw.trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'yes';
}

export function loadVfsAccessConfig(env: NodeJS.ProcessEnv = process.env): VfsAccessConfig {
  const followSymlinks = parseBool(env.VFS_FOLLOW_SYMLINKS);

  const globalAllowedRoots: string[] = [];
  const projectAllowedRoots = new Map<string, string[]>();

  const raw = env.VFS_EXTRA_ROOTS ?? '';
  for (const token of raw.split(':')) {
    const trimmed = token.trim();
    if (!trimmed) continue;

    let projectId: string | undefined;
    let absPath: string;
    const pipeIdx = trimmed.indexOf('|');
    if (pipeIdx >= 0) {
      projectId = trimmed.slice(0, pipeIdx);
      absPath = trimmed.slice(pipeIdx + 1);
      if (!projectId || !PROJECT_ID_RE.test(projectId)) {
        throw new Error(
          `Invalid VFS_EXTRA_ROOTS entry "${trimmed}": projectId must match ${PROJECT_ID_RE}`
        );
      }
    } else {
      absPath = trimmed;
    }

    if (!absPath || !path.isAbsolute(absPath)) {
      throw new Error(`Invalid VFS_EXTRA_ROOTS entry "${trimmed}": path must be absolute`);
    }

    let canonical: string;
    try {
      canonical = fs.realpathSync(absPath);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`Invalid VFS_EXTRA_ROOTS entry "${trimmed}": ${msg}`);
    }

    if (projectId) {
      const existing = projectAllowedRoots.get(projectId) ?? [];
      if (!existing.includes(canonical)) existing.push(canonical);
      projectAllowedRoots.set(projectId, existing);
    } else {
      if (!globalAllowedRoots.includes(canonical)) {
        globalAllowedRoots.push(canonical);
      }
    }
  }

  return { followSymlinks, globalAllowedRoots, projectAllowedRoots };
}

/**
 * Build the allow-list for one project request. Always includes the project
 * root itself; canonical and deduped.
 */
export function getAllowedRootsForProject(
  cfg: VfsAccessConfig,
  projectId: string,
  projectRoot: string
): string[] {
  const out: string[] = [projectRoot];
  for (const r of cfg.globalAllowedRoots) {
    if (!out.includes(r)) out.push(r);
  }
  const scoped = cfg.projectAllowedRoots.get(projectId);
  if (scoped) {
    for (const r of scoped) {
      if (!out.includes(r)) out.push(r);
    }
  }
  return out;
}
