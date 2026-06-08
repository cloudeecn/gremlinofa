/**
 * Project Import Utility — pure helpers only. The impure runtime
 * (creating the project + writing VFS records) lives in
 * `src/backend/projectBundle.ts` and is reachable via the
 * `gremlinClient.importProjectBundle` RPC.
 *
 * This file is import-safe from the frontend boundary because it has
 * no dependency on the storage / encryption / api singletons.
 */

import type { VfsTree, VfsNode } from '../protocol/types';
import { generateUniqueId } from './idGenerator';
import { normalizePath, getPathSegments } from '../lib/vfsPaths';
import type { BundleFileEntry, ProjectBundle } from './projectBundleSchema';

/**
 * Validate a parsed bundle and return typed result.
 * Throws descriptive errors for invalid bundles.
 */
export function validateBundle(data: unknown): ProjectBundle {
  if (!data || typeof data !== 'object') {
    throw new Error('Invalid bundle: expected a JSON object');
  }

  const obj = data as Record<string, unknown>;

  if (obj.version !== 1) {
    throw new Error(`Unsupported bundle version: ${obj.version ?? 'missing'}`);
  }

  if (!obj.project || typeof obj.project !== 'object') {
    throw new Error('Invalid bundle: missing "project" object');
  }

  const project = obj.project as Record<string, unknown>;
  if (typeof project.name !== 'string' || !project.name.trim()) {
    throw new Error('Invalid bundle: project.name must be a non-empty string');
  }

  if (!Array.isArray(obj.files)) {
    throw new Error('Invalid bundle: "files" must be an array');
  }

  return obj as unknown as ProjectBundle;
}

/**
 * Build a VFS tree from a flat list of file/directory entries.
 * Returns the tree and a list of file entries with generated fileIds.
 */
export function buildTreeFromEntries(entries: BundleFileEntry[]): {
  tree: VfsTree;
  fileEntries: Array<{ fileId: string; entry: BundleFileEntry }>;
} {
  const tree: VfsTree = { children: {}, orphans: [] };
  const fileEntries: Array<{ fileId: string; entry: BundleFileEntry }> = [];
  const now = Date.now();

  for (const entry of entries) {
    const normalized = normalizePath(entry.path);
    if (normalized === '/') continue; // skip root

    const segments = getPathSegments(normalized);
    if (segments.length === 0) continue;

    if (entry.type === 'directory') {
      // Create all segments as directories
      let current: VfsTree | VfsNode = tree;
      for (const seg of segments) {
        const children: Record<string, VfsNode> | undefined =
          'children' in current ? current.children : undefined;
        if (!children) break;

        if (!(seg in children)) {
          children[seg] = {
            type: 'dir',
            deleted: false,
            createdAt: now,
            updatedAt: now,
            children: {},
          };
        }
        current = children[seg];
      }
    } else {
      // File entry: create parent dirs, then file node
      const parentSegments = segments.slice(0, -1);
      const fileName = segments[segments.length - 1];

      // Ensure parent directories exist
      let current: VfsTree | VfsNode = tree;
      for (const seg of parentSegments) {
        const children: Record<string, VfsNode> | undefined =
          'children' in current ? current.children : undefined;
        if (!children) break;

        if (!(seg in children)) {
          children[seg] = {
            type: 'dir',
            deleted: false,
            createdAt: now,
            updatedAt: now,
            children: {},
          };
        }
        current = children[seg];
      }

      // Add file node
      const parentChildren: Record<string, VfsNode> | undefined =
        'children' in current ? current.children : undefined;
      if (parentChildren) {
        const fileId = generateUniqueId('vf');
        const fileNode: VfsNode = {
          type: 'file',
          fileId,
          deleted: false,
          createdAt: now,
          updatedAt: now,
        };
        if (entry.isBinary) fileNode.isBinary = true;
        if (entry.mime) fileNode.mime = entry.mime;

        parentChildren[fileName] = fileNode;
        fileEntries.push({ fileId, entry });
      }
    }
  }

  return { tree, fileEntries };
}
