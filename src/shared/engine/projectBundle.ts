/**
 * Project bundle export / import runtime + pure helpers.
 *
 * Phase 1.8 consolidation: the previous setup split this code across
 * three files — pure helpers in `src/utils/projectExport.ts` and
 * `src/utils/projectImport.ts`, types in the same files, and the
 * impure runtime here. The Phase 1.8 cleanup pulls all of it into one
 * place: types live on the protocol surface
 * (`src/shared/protocol/types/projectBundle.ts`), the DOM-touching
 * download trigger lives in `src/frontend/lib/projectExport.ts`, and
 * everything else is here so the worker has a single import target.
 */

import { Tables } from '../services/storage/StorageAdapter';
import { generateUniqueId } from '../protocol/idGenerator';
import { normalizePath, getPathSegments } from './lib/vfsPaths';
import type {
  BundleFileEntry,
  Project,
  ProjectBundle,
  VfsFile,
  VfsNode,
  VfsTree,
} from '../protocol/types';
import type { BackendDeps } from './backendDeps';
import type { ProjectExportEvent } from '../protocol/protocol';
import { ProtocolError } from './GremlinServer';

/**
 * Default values for optional Project fields. Mirrors the constant from
 * the previous `src/utils/projectImport.ts` so a hand-crafted bundle that
 * omits fields still produces a valid `Project`.
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
 * Stream a project's export bundle. Yields one `progress` event per file
 * loaded plus a terminal `done` event carrying the serialized bundle JSON
 * + counts. The frontend assembles the JSON into a `Blob` and triggers
 * the download anchor on the main thread.
 */
export async function* runProjectExport(
  deps: BackendDeps,
  projectId: string
): AsyncGenerator<ProjectExportEvent, void, void> {
  const { storage, encryption } = deps;

  const project = await storage.getProject(projectId);
  if (!project) {
    throw new ProtocolError('INVALID_PARAMS', `Project not found: ${projectId}`);
  }
  const strippedProject = stripProjectForExport(project);

  const adapter = storage.getAdapter();
  const metaRecord = await adapter.get(Tables.VFS_META, `vfs_meta_${projectId}`);

  const files: BundleFileEntry[] = [];
  let dirCount = 0;

  if (metaRecord) {
    const treeJson = await encryption.decryptWithDecompression(metaRecord.encryptedData);
    const tree = JSON.parse(treeJson);

    if (tree.children && typeof tree.children === 'object') {
      const { fileInfos, dirEntries } = collectLiveEntries(tree.children, '/');
      dirCount = dirEntries.length;

      for (let i = 0; i < fileInfos.length; i++) {
        const info = fileInfos[i];
        yield { type: 'progress', loaded: i, total: fileInfos.length };

        const fileRecord = await adapter.get(Tables.VFS_FILES, info.fileId);
        if (!fileRecord) {
          console.debug('[projectBundle] Skipping missing file:', info.fileId);
          continue;
        }

        const fileJson = await encryption.decryptWithDecompression(fileRecord.encryptedData);
        const vfsFile: VfsFile = JSON.parse(fileJson);

        const entry: BundleFileEntry = {
          path: info.path,
          content: vfsFile.content,
        };
        if (info.isBinary) entry.isBinary = true;
        if (info.mime) entry.mime = info.mime;

        files.push(entry);
      }

      yield { type: 'progress', loaded: fileInfos.length, total: fileInfos.length };
      files.push(...dirEntries);
    }
  }

  const bundle: ProjectBundle = {
    version: 1,
    exportedAt: new Date().toISOString(),
    project: strippedProject,
    files,
  };

  yield {
    type: 'done',
    bundleJson: JSON.stringify(bundle, null, 2),
    fileCount: files.length - dirCount,
    dirCount,
    projectName: project.name,
  };
}

/**
 * Import a project bundle. The frontend reads the uploaded `File` to a
 * UTF-8 string and posts it through; this function parses + validates,
 * mints fresh IDs, and writes the project + VFS records via the
 * per-server storage / encryption.
 */
export async function runProjectImport(
  deps: BackendDeps,
  bundleJson: string
): Promise<{ projectId: string; projectName: string }> {
  const { storage, encryption } = deps;

  let parsed: unknown;
  try {
    parsed = JSON.parse(bundleJson);
  } catch {
    throw new ProtocolError('INVALID_PARAMS', 'Invalid JSON file');
  }

  let bundle: ProjectBundle;
  try {
    bundle = validateBundle(parsed);
  } catch (err) {
    throw new ProtocolError(
      'INVALID_PARAMS',
      err instanceof Error ? err.message : 'Invalid bundle'
    );
  }
  const bundleProject = bundle.project as Record<string, unknown>;

  const projectId = generateUniqueId('proj');
  const projectName = `${bundleProject.name} (Imported)`;

  const now = new Date();
  const project: Project = {
    ...PROJECT_DEFAULTS,
    ...bundleProject,
    id: projectId,
    name: projectName,
    createdAt: now,
    lastUsedAt: now,
  } as Project;

  const { tree, fileEntries } = buildTreeFromEntries(bundle.files);

  const adapter = storage.getAdapter();

  if (fileEntries.length > 0 || bundle.files.some(f => f.type === 'directory')) {
    const treeEncrypted = await encryption.encryptWithCompression(JSON.stringify(tree), true);
    await adapter.save(Tables.VFS_META, `vfs_meta_${projectId}`, treeEncrypted, {
      timestamp: now.toISOString(),
      parentId: projectId,
    });
  }

  const fileNow = Date.now();
  for (const { fileId, entry } of fileEntries) {
    const vfsFile: VfsFile = {
      content: entry.content ?? '',
      version: 1,
      createdAt: fileNow,
      updatedAt: fileNow,
    };

    const encrypted = await encryption.encryptWithCompression(JSON.stringify(vfsFile), true);
    await adapter.save(Tables.VFS_FILES, fileId, encrypted, {
      timestamp: now.toISOString(),
      parentId: projectId,
    });
  }

  await storage.saveProject(project);

  return { projectId, projectName };
}
