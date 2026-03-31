/**
 * VFS Facade — the sole public API for all VFS operations.
 *
 * Acquires the per-project tree lock once per call (including compound
 * multi-step operations), eliminating TOCTOU races that occur when
 * callers chain multiple independently-locked VFS calls.
 *
 * Architecture:
 *   callers → vfsFacade (lock) → vfsService (unlocked internals) → treeLock
 */

import { withTreeLock } from './treeLock';
import * as svc from './vfsService';
import type { FileContent } from './vfsService';
import type { VfsAdapter } from './vfsAdapter';
import type { Project } from '../../types';
import { RemoteVfsAdapter } from './remoteVfsAdapter';
import { LocalVfsAdapter } from './localVfsAdapter';

// ============================================================================
// Lock Wrapper Utility
// ============================================================================

/**
 * Wrap an async VFS function so the first argument (projectId) is used
 * to acquire the tree lock before the function body runs.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function wrapWithLock<F extends (...args: any[]) => Promise<any>>(fn: F): F {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wrapped = (...args: any[]) => {
    const projectId = args[0] as string;
    return withTreeLock(projectId, () => fn(...args));
  };
  return wrapped as unknown as F;
}

// ============================================================================
// Passthrough Wrappers (single VFS call under one lock)
// ============================================================================

export const createFile = wrapWithLock(svc.createFile);
export const readFile = wrapWithLock(svc.readFile);
export const updateFile = wrapWithLock(svc.updateFile);
export const writeFile = wrapWithLock(svc.writeFile);
export const readFileWithMeta = wrapWithLock(svc.readFileWithMeta);
export const deleteFile = wrapWithLock(svc.deleteFile);
export const mkdir = wrapWithLock(svc.mkdir);
export const rmdir = wrapWithLock(svc.rmdir);
export const readDir = wrapWithLock(svc.readDir);
export const rename = wrapWithLock(svc.rename);
export const exists = wrapWithLock(svc.exists);
export const isFile = wrapWithLock(svc.isFile);
export const isDirectory = wrapWithLock(svc.isDirectory);
export const restore = wrapWithLock(svc.restore);
export const purge = wrapWithLock(svc.purge);
export const clearVfs = wrapWithLock(svc.clearVfs);
export const hasVfs = wrapWithLock(svc.hasVfs);
export const stat = wrapWithLock(svc.stat);
export const getFileMeta = wrapWithLock(svc.getFileMeta);
export const getFileId = wrapWithLock(svc.getFileId);
export const getVersion = wrapWithLock(svc.getVersion);
export const listVersions = wrapWithLock(svc.listVersions);
export const dropOldVersions = wrapWithLock(svc.dropOldVersions);
export const listOrphans = wrapWithLock(svc.listOrphans);
export const restoreOrphan = wrapWithLock(svc.restoreOrphan);
export const purgeOrphan = wrapWithLock(svc.purgeOrphan);
export const strReplace = wrapWithLock(svc.strReplace);
export const insert = wrapWithLock(svc.insert);
export const compactProject = wrapWithLock(svc.compactProject);

// ============================================================================
// Compound Operations (multiple VFS steps under one lock)
// ============================================================================

/**
 * Append text to a file, creating it if it doesn't exist.
 * @returns Whether a new file was created
 */
export async function appendFile(
  projectId: string,
  path: string,
  text: string,
  namespace?: string
): Promise<{ created: boolean }> {
  return withTreeLock(projectId, async () => {
    const fileExists = await svc.exists(projectId, path, namespace);

    if (fileExists) {
      const fileStat = await svc.stat(projectId, path, namespace);
      if (fileStat.isBinary) {
        throw new svc.VfsError(`Cannot append to binary file: ${path}`, 'BINARY_FILE');
      }
      const content = await svc.readFile(projectId, path, namespace);
      await svc.updateFile(projectId, path, content + text, namespace);
      return { created: false };
    }

    await svc.writeFile(projectId, path, text, namespace);
    return { created: true };
  });
}

/**
 * Copy a file from src to dst, handling binary and text files.
 * Checks that destination is not a directory and respects overwrite flag.
 */
export async function copyFile(
  projectId: string,
  src: string,
  dst: string,
  overwrite?: boolean,
  namespace?: string
): Promise<void> {
  return withTreeLock(projectId, async () => {
    const destIsDir = await svc.isDirectory(projectId, dst, namespace);
    if (destIsDir) {
      throw new svc.VfsError(`Destination is a directory: ${dst}`, 'NOT_A_FILE');
    }

    if (!overwrite) {
      const destExists = await svc.exists(projectId, dst, namespace);
      if (destExists) {
        throw new svc.VfsError(`Destination already exists: ${dst}`, 'DESTINATION_EXISTS');
      }
    }

    const source = await svc.readFileWithMeta(projectId, src, namespace);
    if (source.isBinary) {
      await svc.writeFile(projectId, dst, source.buffer!, namespace);
    } else {
      await svc.writeFile(projectId, dst, source.content, namespace);
    }
  });
}

/**
 * Delete a path (file or directory). Tries file first, falls back to recursive rmdir.
 */
export async function deletePath(
  projectId: string,
  path: string,
  namespace?: string
): Promise<void> {
  return withTreeLock(projectId, async () => {
    try {
      await svc.deleteFile(projectId, path, namespace);
    } catch (error) {
      if (error instanceof svc.VfsError && error.code === 'NOT_A_FILE') {
        await svc.rmdir(projectId, path, true, namespace);
      } else {
        throw error;
      }
    }
  });
}

/**
 * Create a file with overwrite and binary (dataUrl) support.
 * When content is a string starting with `data:<mime>;base64,`, it's treated as binary.
 */
export async function createFileGuarded(
  projectId: string,
  path: string,
  content: FileContent,
  overwrite?: boolean,
  namespace?: string
): Promise<void> {
  return withTreeLock(projectId, async () => {
    if (overwrite) {
      await svc.writeFile(projectId, path, content, namespace);
    } else {
      if (svc.isBinaryContent(content)) {
        // createFile doesn't support binary — guard with exists check
        const pathExists = await svc.exists(projectId, path, namespace);
        if (pathExists) {
          throw new svc.VfsError(`File already exists: ${path}`, 'FILE_EXISTS');
        }
        await svc.writeFile(projectId, path, content, namespace);
      } else {
        await svc.createFile(projectId, path, content, namespace);
      }
    }
  });
}

/**
 * Ensure a directory exists and write multiple files into it.
 */
export async function ensureDirAndWrite(
  projectId: string,
  dir: string,
  files: Array<{ name: string; content: string }>,
  namespace?: string
): Promise<void> {
  return withTreeLock(projectId, async () => {
    const dirExists = await svc.isDirectory(projectId, dir, namespace);
    if (!dirExists) {
      await svc.mkdir(projectId, dir, namespace);
    }
    for (const file of files) {
      const filePath = dir.endsWith('/') ? `${dir}${file.name}` : `${dir}/${file.name}`;
      await svc.writeFile(projectId, filePath, file.content, namespace);
    }
  });
}

// ============================================================================
// Adapter Factory
// ============================================================================

/**
 * Get a VfsAdapter for a project. If the project has remoteVfsUrl configured,
 * returns a RemoteVfsAdapter (no client-side tree lock — server handles it).
 * Otherwise returns a LocalVfsAdapter wrapping the existing vfsService with tree lock.
 */
export function getAdapter(project: Project, userId: string, namespace?: string): VfsAdapter {
  if (project.remoteVfsUrl) {
    return new RemoteVfsAdapter(
      project.remoteVfsUrl,
      userId,
      project.remoteVfsPassword ?? '',
      project.id,
      project.remoteVfsEncrypt ?? false,
      namespace
    );
  }
  return new LocalVfsAdapter(project.id, namespace);
}
