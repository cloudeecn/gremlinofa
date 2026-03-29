/**
 * Project Export Utility
 * Exports a single project as a decrypted, portable .gremlin.json bundle.
 * Prunes orphans, deleted nodes, and version history — only live files exported.
 */

import type { VfsNode, VfsFile, Project } from '../types';
import { encryptionService } from '../services/encryption/encryptionService';
import { storage } from '../services/storage';
import { Tables } from '../services/storage/StorageAdapter';

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
interface LiveFileInfo {
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
function collectLiveEntries(
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

// Exported for testing
export { collectLiveEntries as _collectLiveEntries };

/**
 * Strip transient fields from a project for export.
 * Removes id, createdAt, lastUsedAt — these are regenerated on import.
 */
function stripProjectForExport(project: Project): Record<string, unknown> {
  const serialized = {
    ...project,
    createdAt: project.createdAt.toISOString(),
    lastUsedAt: project.lastUsedAt.toISOString(),
  };
  const { id: _id, createdAt: _ca, lastUsedAt: _lu, ...rest } = serialized;
  return rest;
}

// Exported for testing
export { stripProjectForExport as _stripProjectForExport };

/** Progress callback for export */
export type ExportProjectProgress = (filesLoaded: number, totalFiles: number) => void;

/** Result returned alongside the blob */
export interface ExportProjectResult {
  blob: Blob;
  fileCount: number;
  dirCount: number;
}

/**
 * Export a project as a ProjectBundle blob.
 */
export async function exportProject(
  projectId: string,
  onProgress?: ExportProjectProgress
): Promise<ExportProjectResult> {
  // 1. Load and strip project
  const project = await storage.getProject(projectId);
  if (!project) {
    throw new Error(`Project not found: ${projectId}`);
  }
  const strippedProject = stripProjectForExport(project);

  // 2. Load VFS tree
  const adapter = storage.getAdapter();
  const metaRecord = await adapter.get(Tables.VFS_META, `vfs_meta_${projectId}`);

  const files: BundleFileEntry[] = [];
  let dirCount = 0;

  if (metaRecord) {
    const treeJson = await encryptionService.decryptWithDecompression(metaRecord.encryptedData);
    const tree = JSON.parse(treeJson);

    if (tree.children && typeof tree.children === 'object') {
      // 3. Walk tree for live entries
      const { fileInfos, dirEntries } = collectLiveEntries(tree.children, '/');
      dirCount = dirEntries.length;

      // 4. Load file contents
      for (let i = 0; i < fileInfos.length; i++) {
        const info = fileInfos[i];
        onProgress?.(i, fileInfos.length);

        const fileRecord = await adapter.get(Tables.VFS_FILES, info.fileId);
        if (!fileRecord) {
          console.debug('[ProjectExport] Skipping missing file:', info.fileId);
          continue;
        }

        const fileJson = await encryptionService.decryptWithDecompression(fileRecord.encryptedData);
        const vfsFile: VfsFile = JSON.parse(fileJson);

        const entry: BundleFileEntry = {
          path: info.path,
          content: vfsFile.content,
        };
        if (info.isBinary) entry.isBinary = true;
        if (info.mime) entry.mime = info.mime;

        files.push(entry);
      }

      onProgress?.(fileInfos.length, fileInfos.length);

      // Add empty directory entries
      files.push(...dirEntries);
    }
  }

  // 5. Assemble bundle
  const bundle: ProjectBundle = {
    version: 1,
    exportedAt: new Date().toISOString(),
    project: strippedProject,
    files,
  };

  const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
  return { blob, fileCount: files.length - dirCount, dirCount };
}

/**
 * Trigger a browser download for the exported project blob.
 */
export function triggerProjectDownload(blob: Blob, projectName: string): void {
  const date = new Date().toISOString().split('T')[0];
  const safeName = projectName.replace(/[^a-zA-Z0-9_-]/g, '_');
  const filename = `${safeName}-export-${date}.gremlin.json`;

  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
