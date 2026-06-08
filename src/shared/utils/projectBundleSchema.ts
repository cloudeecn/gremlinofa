/**
 * Pure schema + helpers for the .gremlin.json project bundle format. Both
 * the worker-side `engine/projectBundle.ts` (which builds bundles from
 * encrypted storage) and the import path (`utils/projectImport.ts`) need
 * these helpers, so they live in shared.
 *
 * Phase 1.8 split: this file used to be `src/utils/projectExport.ts`. The
 * browser-only download trigger moved to `src/frontend/utils/projectDownload.ts`.
 */

import type { VfsNode, Project } from '../protocol/types';

/** Entry in the exported files array */
export interface BundleFileEntry {
  path: string;
  type?: 'directory'; // omitted for files
  content?: string;
  isBinary?: boolean;
  mime?: string;
}

/** The exported project bundle */
export interface ProjectBundle {
  version: 1;
  exportedAt: string;
  project: Record<string, unknown>;
  files: BundleFileEntry[];
}

/**
 * Intermediate structure for collecting live file info from the VFS tree.
 * Content is loaded separately after tree walking.
 */
export interface LiveFileInfo {
  path: string;
  fileId: string;
  isBinary?: boolean;
  mime?: string;
}

/**
 * Recursively walk the VFS tree and collect live entries.
 * - File nodes (not deleted) → LiveFileInfo for content loading
 * - Dir nodes with no live children after pruning → empty directory entry
 * - Deleted nodes are skipped entirely
 */
export function collectLiveEntries(
  children: Record<string, VfsNode>,
  parentPath: string
): { fileInfos: LiveFileInfo[]; dirEntries: BundleFileEntry[] } {
  const fileInfos: LiveFileInfo[] = [];
  const dirEntries: BundleFileEntry[] = [];

  for (const [name, node] of Object.entries(children)) {
    if (node.deleted) continue;

    const fullPath = parentPath === '/' ? `/${name}` : `${parentPath}/${name}`;

    if (node.type === 'file' && node.fileId) {
      fileInfos.push({
        path: fullPath,
        fileId: node.fileId,
        isBinary: node.isBinary,
        mime: node.mime,
      });
    } else if (node.type === 'dir' && node.children) {
      const nested = collectLiveEntries(node.children, fullPath);
      fileInfos.push(...nested.fileInfos);
      dirEntries.push(...nested.dirEntries);

      // If this dir has no live children at all, emit it as an empty directory
      if (nested.fileInfos.length === 0 && nested.dirEntries.length === 0) {
        dirEntries.push({ path: fullPath, type: 'directory' });
      }
    }
  }

  return { fileInfos, dirEntries };
}

/**
 * Strip transient fields from a project for export.
 * Removes id, createdAt, lastUsedAt — these are regenerated on import.
 */
export function stripProjectForExport(project: Project): Record<string, unknown> {
  const serialized = {
    ...project,
    createdAt: project.createdAt.toISOString(),
    lastUsedAt: project.lastUsedAt.toISOString(),
  };
  const { id: _id, createdAt: _ca, lastUsedAt: _lu, ...rest } = serialized;
  return rest;
}
