/**
 * Project Import Utility
 * Imports a .gremlin.json bundle, creating a new project with fresh IDs.
 * Rebuilds VFS tree from the flat file list.
 */

import type { Project, VfsTree, VfsNode, VfsFile } from '../types';
import { encryptionService } from '../services/encryption/encryptionService';
import { storage } from '../services/storage';
import { Tables } from '../services/storage/StorageAdapter';
import { generateUniqueId } from './idGenerator';
import { normalizePath, getPathSegments } from '../services/vfs/vfsService';
import type { BundleFileEntry, ProjectBundle } from './projectExport';

/**
 * Default values for optional Project fields.
 * Used when importing a hand-crafted bundle that omits some fields.
 */
const PROJECT_DEFAULTS: Partial<Project> = {
  systemPrompt: '',
  preFillResponse: '',
  apiDefinitionId: null,
  modelId: null,
  webSearchEnabled: false,
  temperature: null,
  maxOutputTokens: 16384,
  enableReasoning: false,
  reasoningBudgetTokens: 10000,
};

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

/**
 * Import a .gremlin.json bundle file.
 * Creates a new project with randomized IDs and "(Imported)" suffix.
 */
export async function importProject(
  file: File
): Promise<{ projectId: string; projectName: string }> {
  // 1. Parse and validate
  const text = await file.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Invalid JSON file');
  }

  const bundle = validateBundle(parsed);
  const bundleProject = bundle.project as Record<string, unknown>;

  // 2. Generate new project ID
  const projectId = generateUniqueId('proj');
  const projectName = `${bundleProject.name} (Imported)`;

  // 3. Build Project object
  const now = new Date();
  const project: Project = {
    ...PROJECT_DEFAULTS,
    ...bundleProject,
    id: projectId,
    name: projectName,
    createdAt: now,
    lastUsedAt: now,
  } as Project;

  // 4. Build VFS tree from flat entries
  const { tree, fileEntries } = buildTreeFromEntries(bundle.files);

  // 5. Save VFS data first (before project, so a failed project save doesn't leave a visible broken project)
  const adapter = storage.getAdapter();

  // Save VFS tree
  if (fileEntries.length > 0 || bundle.files.some(f => f.type === 'directory')) {
    const treeEncrypted = await encryptionService.encryptWithCompression(
      JSON.stringify(tree),
      true
    );
    await adapter.save(Tables.VFS_META, `vfs_meta_${projectId}`, treeEncrypted, {
      timestamp: now.toISOString(),
      parentId: projectId,
    });
  }

  // Save VFS files
  const fileNow = Date.now();
  for (const { fileId, entry } of fileEntries) {
    const vfsFile: VfsFile = {
      content: entry.content ?? '',
      version: 1,
      createdAt: fileNow,
      updatedAt: fileNow,
    };

    const encrypted = await encryptionService.encryptWithCompression(JSON.stringify(vfsFile), true);
    await adapter.save(Tables.VFS_FILES, fileId, encrypted, {
      timestamp: now.toISOString(),
      parentId: projectId,
    });
  }

  // 6. Save project
  await storage.saveProject(project);

  return { projectId, projectName };
}
