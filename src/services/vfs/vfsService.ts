/**
 * Virtual Filesystem (VFS) Service
 *
 * A versioned virtual filesystem with tree structure, soft-delete, and orphan tracking.
 * Replaces the flat memory system with SVN-style per-file versioning.
 *
 * Storage layout:
 * - vfs_meta: One row per project containing the entire tree structure
 * - vfs_files: Current content for each file (keyed by fileId)
 * - vfs_versions: Historical snapshots (keyed by fileId_vN)
 *
 * Binary file support:
 * - Binary files store base64-encoded content
 * - VfsNode.isBinary and VfsNode.mime track file type
 * - Text operations (strReplace, insert) blocked on binary files
 * - Changing isBinary or mime orphans the old file
 */

import type { VfsTree, VfsNode, VfsFile, VfsVersion } from '../../types';
import { encryptionService } from '../encryption/encryptionService';
import { storage } from '../storage';
import { Tables } from '../storage/StorageAdapter';
import { generateUniqueId } from '../../utils/idGenerator';
import { withTreeLock } from './treeLock';

// ============================================================================
// Path Utilities
// ============================================================================

/**
 * Normalize a path: resolve . and .., ensure leading slash, remove trailing slash
 */
export function normalizePath(path: string): string {
  // Handle empty or whitespace-only
  if (!path || !path.trim()) return '/';

  // Split and filter empty segments
  const segments = path.split('/').filter(s => s && s !== '.');
  const result: string[] = [];

  for (const seg of segments) {
    if (seg === '..') {
      result.pop(); // Go up one level
    } else {
      result.push(seg);
    }
  }

  return '/' + result.join('/');
}

/**
 * Get parent directory path
 */
export function getParentDir(path: string): string {
  const normalized = normalizePath(path);
  if (normalized === '/') return '/';

  const lastSlash = normalized.lastIndexOf('/');
  if (lastSlash <= 0) return '/';

  return normalized.slice(0, lastSlash);
}

/**
 * Get basename (last component of path)
 */
export function getBasename(path: string): string {
  const normalized = normalizePath(path);
  if (normalized === '/') return '';

  const lastSlash = normalized.lastIndexOf('/');
  return normalized.slice(lastSlash + 1);
}

/**
 * Split path into segments (excluding root)
 */
export function getPathSegments(path: string): string[] {
  const normalized = normalizePath(path);
  if (normalized === '/') return [];
  return normalized.slice(1).split('/');
}

/**
 * Check if a path is the root
 */
export function isRootPath(path: string): boolean {
  return normalizePath(path) === '/';
}

/**
 * Resolve a path within a namespace.
 * - No namespace → returns normalizePath(path)
 * - /share and /sharerw paths → bypass namespace, return normalizePath(path)
 * - Otherwise → normalizePath(namespace) + normalizePath(path)
 *
 * Path traversal is mitigated: both path and namespace are normalized
 * (which strips ..) before concatenation.
 */
export function resolveNamespacedPath(path: string, namespace?: string): string {
  const normalized = normalizePath(path);
  if (!namespace) return normalized;
  if (normalized === '/share' || normalized.startsWith('/share/')) return normalized;
  if (normalized === '/sharerw' || normalized.startsWith('/sharerw/')) return normalized;
  const normalizedNs = normalizePath(namespace);
  if (normalizedNs === '/') return normalized;
  // When path normalizes to '/', just return the namespace path
  if (normalized === '/') return normalizedNs;
  return normalizedNs + normalized;
}

/**
 * Check if a path is read-only due to namespace isolation.
 * /share paths are read-only when accessed from a namespace.
 */
export function isNamespacedReadonly(path: string, namespace?: string): boolean {
  if (!namespace) return false;
  const normalized = normalizePath(path);
  return normalized === '/share' || normalized.startsWith('/share/');
}

/** Mount roots that cannot be deleted or renamed */
const MOUNT_ROOTS = ['/share'];

/**
 * Throw if trying to write to a namespace-readonly path.
 * /share is read-only for namespaced callers; /sharerw is not.
 */
function assertWritable(path: string, namespace?: string): void {
  if (!namespace) return;
  const normalized = normalizePath(path);
  if (normalized === '/share' || normalized.startsWith('/share/')) {
    throw new VfsError(
      `Cannot write to ${normalized}: /share is read-only in namespaced context`,
      'READONLY'
    );
  }
}

/**
 * Throw if trying to delete or rename a structural mount root.
 * Expects a resolved (post-namespace) path.
 */
function assertNotMountRoot(resolvedPath: string): void {
  if (MOUNT_ROOTS.includes(resolvedPath)) {
    throw new VfsError(`Cannot delete or move mount root ${resolvedPath}`, 'INVALID_PATH');
  }
}

// ============================================================================
// Tree Navigation Helpers
// ============================================================================

/**
 * Navigate to a node in the tree by path
 * Returns the node and its parent (for mutation operations)
 */
function navigateToNode(
  tree: VfsTree,
  path: string
): { node: VfsNode | null; parent: VfsNode | VfsTree | null; name: string } {
  const segments = getPathSegments(path);

  if (segments.length === 0) {
    // Root path - tree itself is the "node"
    return { node: null, parent: null, name: '' };
  }

  let current: VfsNode | VfsTree = tree;
  let parent: VfsNode | VfsTree | null = null;

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const children: Record<string, VfsNode> | undefined =
      'children' in current ? current.children : undefined;

    if (!children || !(seg in children)) {
      return { node: null, parent: null, name: seg };
    }

    parent = current;
    const nextNode: VfsNode = children[seg];
    current = nextNode;

    // If we're not at the last segment, the current must be a directory
    if (i < segments.length - 1 && nextNode.type !== 'dir') {
      return { node: null, parent: null, name: seg };
    }
  }

  return {
    node: current as VfsNode,
    parent,
    name: segments[segments.length - 1],
  };
}

/**
 * Get or create parent directory path, creating intermediate dirs as needed
 * Returns the parent node or null if path component is a file
 */
function ensureParentExists(tree: VfsTree, path: string): VfsNode | VfsTree | null {
  const parentPath = getParentDir(path);
  if (parentPath === '/') return tree;

  const segments = getPathSegments(parentPath);
  let current: VfsNode | VfsTree = tree;
  const now = Date.now();

  for (const seg of segments) {
    const children: Record<string, VfsNode> | undefined =
      'children' in current ? current.children : (current as VfsNode).children;
    if (!children) return null;

    if (!(seg in children)) {
      // Create intermediate directory
      children[seg] = {
        type: 'dir',
        deleted: false,
        createdAt: now,
        updatedAt: now,
        children: {},
      };
    } else {
      // Restore deleted directory if using it as parent
      const existing = children[seg];
      if (existing.type === 'dir' && existing.deleted) {
        existing.deleted = false;
        existing.updatedAt = now;
      }
    }

    const next: VfsNode = children[seg];
    if (next.type !== 'dir') {
      return null; // Path component is a file, can't be parent
    }

    current = next;
  }

  return current;
}

// ============================================================================
// Storage Helpers
// ============================================================================

/**
 * Load VFS tree for a project
 */
async function loadTree(projectId: string): Promise<VfsTree> {
  const metaId = `vfs_meta_${projectId}`;
  const adapter = storage.getAdapter();
  const record = await adapter.get(Tables.VFS_META, metaId);

  if (!record) {
    return { children: {}, orphans: [] };
  }

  try {
    const json = await encryptionService.decryptWithDecompression(record.encryptedData);
    const tree = JSON.parse(json) as VfsTree;

    // Validate structure
    if (!tree.children || typeof tree.children !== 'object') {
      console.error('[vfsService] Invalid tree structure, returning empty');
      return { children: {}, orphans: [] };
    }

    return tree;
  } catch (error) {
    console.error('[vfsService] Failed to load tree:', error);
    return { children: {}, orphans: [] };
  }
}

/**
 * Save VFS tree for a project
 */
async function saveTree(projectId: string, tree: VfsTree): Promise<void> {
  const metaId = `vfs_meta_${projectId}`;
  const adapter = storage.getAdapter();
  const encrypted = await encryptionService.encryptWithCompression(JSON.stringify(tree), true);

  await adapter.save(Tables.VFS_META, metaId, encrypted, {
    timestamp: new Date().toISOString(),
    parentId: projectId,
  });
}

/**
 * Load file content from vfs_files
 */
async function loadFile(fileId: string): Promise<VfsFile | null> {
  const adapter = storage.getAdapter();
  const record = await adapter.get(Tables.VFS_FILES, fileId);

  if (!record) return null;

  try {
    const json = await encryptionService.decryptWithDecompression(record.encryptedData);
    return JSON.parse(json) as VfsFile;
  } catch (error) {
    console.error('[vfsService] Failed to load file:', error);
    return null;
  }
}

/**
 * Save file content to vfs_files
 */
async function saveFile(fileId: string, file: VfsFile, projectId: string): Promise<void> {
  const adapter = storage.getAdapter();
  const encrypted = await encryptionService.encryptWithCompression(JSON.stringify(file), true);

  await adapter.save(Tables.VFS_FILES, fileId, encrypted, {
    timestamp: new Date().toISOString(),
    parentId: projectId,
  });
}

/**
 * Delete file content from vfs_files
 */
async function deleteFileContent(fileId: string): Promise<void> {
  const adapter = storage.getAdapter();
  await adapter.delete(Tables.VFS_FILES, fileId);
}

/**
 * Save a version snapshot
 */
async function saveVersion(
  fileId: string,
  version: number,
  content: string,
  createdAt: number
): Promise<void> {
  const versionId = `${fileId}_v${version}`;
  const adapter = storage.getAdapter();

  const versionData: VfsVersion = {
    content,
    version,
    createdAt,
  };

  const encrypted = await encryptionService.encryptWithCompression(
    JSON.stringify(versionData),
    true
  );

  await adapter.save(Tables.VFS_VERSIONS, versionId, encrypted, {
    timestamp: new Date(createdAt).toISOString(),
    parentId: fileId,
  });
}

/**
 * Load a version snapshot
 */
async function loadVersion(fileId: string, version: number): Promise<VfsVersion | null> {
  const versionId = `${fileId}_v${version}`;
  const adapter = storage.getAdapter();
  const record = await adapter.get(Tables.VFS_VERSIONS, versionId);

  if (!record) return null;

  try {
    const json = await encryptionService.decryptWithDecompression(record.encryptedData);
    return JSON.parse(json) as VfsVersion;
  } catch (error) {
    console.error('[vfsService] Failed to load version:', error);
    return null;
  }
}

// ============================================================================
// Directory Entry Type
// ============================================================================

export interface DirEntry {
  name: string;
  type: 'file' | 'dir';
  deleted: boolean;
  createdAt: number;
  updatedAt: number;
  size?: number; // For files: content length
}

// ============================================================================
// VFS Error Types
// ============================================================================

export type VfsErrorCode =
  | 'PATH_NOT_FOUND'
  | 'FILE_EXISTS'
  | 'DIR_EXISTS'
  | 'NOT_A_FILE'
  | 'NOT_A_DIRECTORY'
  | 'DIR_NOT_EMPTY'
  | 'IS_DELETED'
  | 'INVALID_PATH'
  | 'DESTINATION_EXISTS'
  | 'STRING_NOT_FOUND'
  | 'STRING_NOT_UNIQUE'
  | 'INVALID_LINE'
  | 'BINARY_FILE'
  | 'READONLY';

export class VfsError extends Error {
  code: VfsErrorCode;

  constructor(message: string, code: VfsErrorCode) {
    super(message);
    this.name = 'VfsError';
    this.code = code;
  }
}

// ============================================================================
// Binary File Support
// ============================================================================

/** Input type for write operations - string for text, ArrayBuffer/Uint8Array for binary */
export type FileContent = string | ArrayBuffer | Uint8Array;

/** Result of reading a file with metadata */
export interface ReadFileResult {
  content: string; // Text content or base64 for binary files
  isBinary: boolean; // Always defined (false for legacy/text)
  mime: string; // 'text/plain' for text, detected mime for binary
  buffer?: ArrayBuffer; // Only present for binary files
}

/** Magic bytes for common binary file types */
const MAGIC_BYTES: Array<{ bytes: number[]; mime: string }> = [
  { bytes: [0xff, 0xd8, 0xff], mime: 'image/jpeg' },
  { bytes: [0x89, 0x50, 0x4e, 0x47], mime: 'image/png' },
  { bytes: [0x47, 0x49, 0x46, 0x38], mime: 'image/gif' },
  { bytes: [0x52, 0x49, 0x46, 0x46], mime: 'image/webp' }, // RIFF header (check WEBP later)
  { bytes: [0x25, 0x50, 0x44, 0x46], mime: 'application/pdf' },
  { bytes: [0x50, 0x4b, 0x03, 0x04], mime: 'application/zip' },
];

/**
 * Detect MIME type from binary data using magic bytes
 */
export function detectMimeFromBuffer(data: ArrayBuffer | Uint8Array): string {
  const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data;

  for (const { bytes: magic, mime } of MAGIC_BYTES) {
    if (bytes.length >= magic.length) {
      let matches = true;
      for (let i = 0; i < magic.length; i++) {
        if (bytes[i] !== magic[i]) {
          matches = false;
          break;
        }
      }
      if (matches) {
        // Special case: RIFF header needs WEBP check at offset 8
        if (mime === 'image/webp' && bytes.length >= 12) {
          if (bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
            return 'image/webp';
          }
          // RIFF but not WEBP - could be WAV, AVI, etc.
          return 'application/octet-stream';
        }
        return mime;
      }
    }
  }

  return 'application/octet-stream';
}

/**
 * Check if content is binary (ArrayBuffer or Uint8Array)
 */
export function isBinaryContent(content: FileContent): content is ArrayBuffer | Uint8Array {
  return content instanceof ArrayBuffer || content instanceof Uint8Array;
}

/**
 * Convert ArrayBuffer/Uint8Array to base64 string
 */
function bufferToBase64(data: ArrayBuffer | Uint8Array): string {
  const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Convert base64 string to ArrayBuffer
 */
export function base64ToBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

// ============================================================================
// File Operations
// ============================================================================

/**
 * Create a new file
 * @throws VfsError if file exists or parent is not a directory
 */
export async function createFile(
  projectId: string,
  path: string,
  content: string,
  namespace?: string
): Promise<void> {
  assertWritable(path, namespace);
  return withTreeLock(projectId, async () => {
    const tree = await loadTree(projectId);
    const normalized = resolveNamespacedPath(path, namespace);
    const basename = getBasename(normalized);

    if (!basename) {
      throw new VfsError('Cannot create file at root path', 'INVALID_PATH');
    }

    // Check if file already exists
    const { node } = navigateToNode(tree, normalized);
    if (node && !node.deleted) {
      throw new VfsError(`File already exists: ${normalized}`, 'FILE_EXISTS');
    }

    // Ensure parent directory exists
    const parent = ensureParentExists(tree, normalized);
    if (!parent) {
      throw new VfsError(`Parent path is not a directory`, 'NOT_A_DIRECTORY');
    }

    const children = 'children' in parent ? parent.children : (parent as VfsNode).children;
    if (!children) {
      throw new VfsError(`Parent is not a directory`, 'NOT_A_DIRECTORY');
    }

    const now = Date.now();
    const fileId = generateUniqueId('vfs_file');

    // Create file node in tree
    children[basename] = {
      type: 'file',
      fileId,
      deleted: false,
      createdAt: now,
      updatedAt: now,
    };

    // Save file content (version 1)
    const fileData: VfsFile = {
      content,
      version: 1,
      createdAt: now,
      updatedAt: now,
    };

    await saveFile(fileId, fileData, projectId);
    await saveTree(projectId, tree);
  });
}

/**
 * Read file content
 * @throws VfsError if file not found or is deleted
 */
export async function readFile(
  projectId: string,
  path: string,
  namespace?: string
): Promise<string> {
  return withTreeLock(projectId, async () => {
    const tree = await loadTree(projectId);
    const normalized = resolveNamespacedPath(path, namespace);
    const { node } = navigateToNode(tree, normalized);

    if (!node) {
      throw new VfsError(`Path not found: ${normalized}`, 'PATH_NOT_FOUND');
    }

    if (node.type !== 'file') {
      throw new VfsError(`Not a file: ${normalized}`, 'NOT_A_FILE');
    }

    if (node.deleted) {
      throw new VfsError(`File is deleted: ${normalized}`, 'IS_DELETED');
    }

    const file = await loadFile(node.fileId!);
    if (!file) {
      throw new VfsError(`File content not found: ${normalized}`, 'PATH_NOT_FOUND');
    }

    return file.content;
  });
}

/**
 * Update file content (creates a new version)
 * @throws VfsError if file not found or is deleted
 */
export async function updateFile(
  projectId: string,
  path: string,
  content: string,
  namespace?: string
): Promise<void> {
  assertWritable(path, namespace);
  return withTreeLock(projectId, async () => {
    const tree = await loadTree(projectId);
    const normalized = resolveNamespacedPath(path, namespace);
    const { node } = navigateToNode(tree, normalized);

    if (!node) {
      throw new VfsError(`Path not found: ${normalized}`, 'PATH_NOT_FOUND');
    }

    if (node.type !== 'file') {
      throw new VfsError(`Not a file: ${normalized}`, 'NOT_A_FILE');
    }

    if (node.deleted) {
      throw new VfsError(`File is deleted: ${normalized}`, 'IS_DELETED');
    }

    const fileId = node.fileId!;
    const currentFile = await loadFile(fileId);
    if (!currentFile) {
      throw new VfsError(`File content not found: ${normalized}`, 'PATH_NOT_FOUND');
    }

    // Save current version to history before updating
    await saveVersion(fileId, currentFile.version, currentFile.content, currentFile.updatedAt);

    const now = Date.now();

    // Update file with new content and incremented version
    const newFile: VfsFile = {
      content,
      version: currentFile.version + 1,
      createdAt: currentFile.createdAt,
      updatedAt: now,
    };

    await saveFile(fileId, newFile, projectId);

    // Update node timestamp in tree
    node.updatedAt = now;
    await saveTree(projectId, tree);
  });
}

/**
 * Write file content - unified function supporting both text and binary.
 * Creates new file if not exists, updates if exists.
 * Orphans old file if isBinary or mime changes.
 * @param projectId Project ID
 * @param path File path
 * @param content Text string or binary data (ArrayBuffer/Uint8Array)
 * @throws VfsError if path issues
 */
export async function writeFile(
  projectId: string,
  path: string,
  content: FileContent,
  namespace?: string
): Promise<void> {
  assertWritable(path, namespace);
  return withTreeLock(projectId, async () => {
    const tree = await loadTree(projectId);
    const normalized = resolveNamespacedPath(path, namespace);
    const basename = getBasename(normalized);

    if (!basename) {
      throw new VfsError('Cannot write file at root path', 'INVALID_PATH');
    }

    const isBinary = isBinaryContent(content);
    const newMime = isBinary ? detectMimeFromBuffer(content) : 'text/plain';
    const storedContent = isBinary ? bufferToBase64(content) : content;

    const { node } = navigateToNode(tree, normalized);

    if (node && !node.deleted && node.type === 'file') {
      // File exists - check if we need to orphan due to type/mime change
      const oldIsBinary = node.isBinary ?? false;
      const oldMime = node.mime ?? 'text/plain';

      if (oldIsBinary !== isBinary || oldMime !== newMime) {
        // Type or mime changed - orphan the old file and create new
        if (node.fileId) {
          tree.orphans.push({
            fileId: node.fileId,
            originalPath: normalized,
            orphanedAt: Date.now(),
          });
        }

        // Create new file with new type
        const now = Date.now();
        const newFileId = generateUniqueId('vfs_file');

        node.fileId = newFileId;
        node.isBinary = isBinary;
        node.mime = newMime;
        node.updatedAt = now;

        const fileData: VfsFile = {
          content: storedContent,
          version: 1,
          createdAt: now,
          updatedAt: now,
        };

        await saveFile(newFileId, fileData, projectId);
        await saveTree(projectId, tree);
        return;
      }

      // Same type - normal update
      const fileId = node.fileId!;
      const currentFile = await loadFile(fileId);
      if (!currentFile) {
        throw new VfsError(`File content not found: ${normalized}`, 'PATH_NOT_FOUND');
      }

      await saveVersion(fileId, currentFile.version, currentFile.content, currentFile.updatedAt);

      const now = Date.now();
      const newFile: VfsFile = {
        content: storedContent,
        version: currentFile.version + 1,
        createdAt: currentFile.createdAt,
        updatedAt: now,
      };

      await saveFile(fileId, newFile, projectId);
      node.updatedAt = now;
      await saveTree(projectId, tree);
      return;
    }

    // File doesn't exist or is deleted - create new
    const parent = ensureParentExists(tree, normalized);
    if (!parent) {
      throw new VfsError(`Parent path is not a directory`, 'NOT_A_DIRECTORY');
    }

    const children = 'children' in parent ? parent.children : (parent as VfsNode).children;
    if (!children) {
      throw new VfsError(`Parent is not a directory`, 'NOT_A_DIRECTORY');
    }

    const now = Date.now();
    const fileId = generateUniqueId('vfs_file');

    children[basename] = {
      type: 'file',
      fileId,
      deleted: false,
      createdAt: now,
      updatedAt: now,
      isBinary,
      mime: newMime,
    };

    const fileData: VfsFile = {
      content: storedContent,
      version: 1,
      createdAt: now,
      updatedAt: now,
    };

    await saveFile(fileId, fileData, projectId);
    await saveTree(projectId, tree);
  });
}

/**
 * Read file with metadata including binary flag and mime type.
 * For binary files, returns base64 content and ArrayBuffer.
 * @throws VfsError if file not found or is deleted
 */
export async function readFileWithMeta(
  projectId: string,
  path: string,
  namespace?: string
): Promise<ReadFileResult> {
  return withTreeLock(projectId, async () => {
    const tree = await loadTree(projectId);
    const normalized = resolveNamespacedPath(path, namespace);
    const { node } = navigateToNode(tree, normalized);

    if (!node) {
      throw new VfsError(`Path not found: ${normalized}`, 'PATH_NOT_FOUND');
    }

    if (node.type !== 'file') {
      throw new VfsError(`Not a file: ${normalized}`, 'NOT_A_FILE');
    }

    if (node.deleted) {
      throw new VfsError(`File is deleted: ${normalized}`, 'IS_DELETED');
    }

    const file = await loadFile(node.fileId!);
    if (!file) {
      throw new VfsError(`File content not found: ${normalized}`, 'PATH_NOT_FOUND');
    }

    const isBinary = node.isBinary ?? false;
    const mime = node.mime ?? (isBinary ? 'application/octet-stream' : 'text/plain');

    if (isBinary) {
      return {
        content: file.content, // base64
        isBinary: true,
        mime,
        buffer: base64ToBuffer(file.content),
      };
    }

    return {
      content: file.content,
      isBinary: false,
      mime,
    };
  });
}

/**
 * Soft-delete a file (marks as deleted, content preserved)
 * @throws VfsError if file not found
 */
export async function deleteFile(
  projectId: string,
  path: string,
  namespace?: string
): Promise<void> {
  assertWritable(path, namespace);
  return withTreeLock(projectId, async () => {
    const tree = await loadTree(projectId);
    const normalized = resolveNamespacedPath(path, namespace);
    assertNotMountRoot(normalized);
    const { node } = navigateToNode(tree, normalized);

    if (!node) {
      throw new VfsError(`Path not found: ${normalized}`, 'PATH_NOT_FOUND');
    }

    if (node.type !== 'file') {
      throw new VfsError(`Not a file: ${normalized}`, 'NOT_A_FILE');
    }

    if (node.deleted) {
      // Already deleted - no-op
      return;
    }

    node.deleted = true;
    node.updatedAt = Date.now();

    await saveTree(projectId, tree);
  });
}

// ============================================================================
// Directory Operations
// ============================================================================

/**
 * Create a directory
 * @throws VfsError if path exists
 */
export async function mkdir(projectId: string, path: string, namespace?: string): Promise<void> {
  assertWritable(path, namespace);
  return withTreeLock(projectId, async () => {
    const tree = await loadTree(projectId);
    const normalized = resolveNamespacedPath(path, namespace);
    const basename = getBasename(normalized);

    if (!basename) {
      throw new VfsError('Cannot create directory at root', 'INVALID_PATH');
    }

    // Check if path already exists
    const { node } = navigateToNode(tree, normalized);
    if (node && !node.deleted) {
      if (node.type === 'dir') {
        throw new VfsError(`Directory already exists: ${normalized}`, 'DIR_EXISTS');
      } else {
        throw new VfsError(`File exists at path: ${normalized}`, 'FILE_EXISTS');
      }
    }

    // Ensure parent exists
    const parent = ensureParentExists(tree, normalized);
    if (!parent) {
      throw new VfsError(`Parent path is not a directory`, 'NOT_A_DIRECTORY');
    }

    const children = 'children' in parent ? parent.children : (parent as VfsNode).children;
    if (!children) {
      throw new VfsError(`Parent is not a directory`, 'NOT_A_DIRECTORY');
    }

    const now = Date.now();
    children[basename] = {
      type: 'dir',
      deleted: false,
      createdAt: now,
      updatedAt: now,
      children: {},
    };

    await saveTree(projectId, tree);
  });
}

/**
 * Remove a directory (soft-delete)
 * @param recursive If true, delete all contents. If false, error if not empty.
 * @throws VfsError if not a directory or (if not recursive) not empty
 */
export async function rmdir(
  projectId: string,
  path: string,
  recursive = false,
  namespace?: string
): Promise<void> {
  assertWritable(path, namespace);
  return withTreeLock(projectId, async () => {
    const tree = await loadTree(projectId);
    const normalized = resolveNamespacedPath(path, namespace);
    assertNotMountRoot(normalized);

    if (isRootPath(normalized)) {
      throw new VfsError('Cannot delete root directory', 'INVALID_PATH');
    }

    const { node } = navigateToNode(tree, normalized);

    if (!node) {
      throw new VfsError(`Path not found: ${normalized}`, 'PATH_NOT_FOUND');
    }

    if (node.type !== 'dir') {
      throw new VfsError(`Not a directory: ${normalized}`, 'NOT_A_DIRECTORY');
    }

    if (node.deleted) {
      // Already deleted
      return;
    }

    // Check if empty (only non-deleted children count)
    const children = node.children || {};
    const activeChildren = Object.values(children).filter(c => !c.deleted);

    if (activeChildren.length > 0 && !recursive) {
      throw new VfsError(`Directory not empty: ${normalized}`, 'DIR_NOT_EMPTY');
    }

    // Recursively mark all descendants as deleted
    const markDeleted = (n: VfsNode, now: number) => {
      n.deleted = true;
      n.updatedAt = now;
      if (n.children) {
        for (const child of Object.values(n.children)) {
          markDeleted(child, now);
        }
      }
    };

    markDeleted(node, Date.now());
    await saveTree(projectId, tree);
  });
}

/**
 * Read directory contents
 * @param includeDeleted If true, include soft-deleted entries
 * @throws VfsError if path not found or not a directory
 */
export async function readDir(
  projectId: string,
  path: string,
  includeDeleted = false,
  namespace?: string
): Promise<DirEntry[]> {
  return withTreeLock(projectId, async () => {
    const tree = await loadTree(projectId);
    const normalized = resolveNamespacedPath(path, namespace);

    let children: Record<string, VfsNode>;

    if (isRootPath(normalized)) {
      children = tree.children ?? {};
    } else {
      const { node } = navigateToNode(tree, normalized);

      if (!node) {
        throw new VfsError(`Path not found: ${normalized}`, 'PATH_NOT_FOUND');
      }

      if (node.type !== 'dir') {
        throw new VfsError(`Not a directory: ${normalized}`, 'NOT_A_DIRECTORY');
      }

      if (node.deleted) {
        throw new VfsError(`Directory is deleted: ${normalized}`, 'IS_DELETED');
      }

      children = node.children || {};
    }

    const entries: DirEntry[] = [];

    for (const [name, child] of Object.entries(children)) {
      if (!includeDeleted && child.deleted) continue;

      const entry: DirEntry = {
        name,
        type: child.type,
        deleted: child.deleted,
        createdAt: child.createdAt,
        updatedAt: child.updatedAt,
      };

      // For files, try to get content length
      if (child.type === 'file' && child.fileId) {
        const file = await loadFile(child.fileId);
        if (file && file.content) {
          entry.size = file.content.length;
        }
      }

      entries.push(entry);
    }

    // Sort: directories first, then by name
    entries.sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === 'dir' ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });

    return entries;
  });
}

// ============================================================================
// Rename / Move
// ============================================================================

/**
 * Rename or move a file/directory
 * Handles orphan creation when displacing a soft-deleted node
 * @throws VfsError if source not found or destination exists (and not deleted)
 */
export async function rename(
  projectId: string,
  oldPath: string,
  newPath: string,
  namespace?: string
): Promise<void> {
  assertWritable(oldPath, namespace);
  assertWritable(newPath, namespace);
  return withTreeLock(projectId, async () => {
    const tree = await loadTree(projectId);
    const oldNormalized = resolveNamespacedPath(oldPath, namespace);
    const newNormalized = resolveNamespacedPath(newPath, namespace);
    assertNotMountRoot(oldNormalized);
    assertNotMountRoot(newNormalized);

    if (oldNormalized === newNormalized) return; // No-op

    if (isRootPath(oldNormalized)) {
      throw new VfsError('Cannot rename root', 'INVALID_PATH');
    }

    // Get source node
    const {
      node: sourceNode,
      parent: sourceParent,
      name: sourceName,
    } = navigateToNode(tree, oldNormalized);

    if (!sourceNode) {
      throw new VfsError(`Source not found: ${oldNormalized}`, 'PATH_NOT_FOUND');
    }

    if (sourceNode.deleted) {
      throw new VfsError(`Source is deleted: ${oldNormalized}`, 'IS_DELETED');
    }

    // Check destination
    const {
      node: destNode,
      parent: _destParent,
      name: destName,
    } = navigateToNode(tree, newNormalized);

    // Ensure destination parent exists
    const actualDestParent = ensureParentExists(tree, newNormalized);
    if (!actualDestParent) {
      throw new VfsError(`Destination parent is not a directory`, 'NOT_A_DIRECTORY');
    }

    const destChildren =
      'children' in actualDestParent
        ? actualDestParent.children
        : (actualDestParent as VfsNode).children;
    if (!destChildren) {
      throw new VfsError(`Destination parent is not a directory`, 'NOT_A_DIRECTORY');
    }

    // Handle destination collision
    if (destNode) {
      if (!destNode.deleted) {
        throw new VfsError(`Destination already exists: ${newNormalized}`, 'DESTINATION_EXISTS');
      }

      // Destination is soft-deleted - move to orphans
      if (destNode.type === 'file' && destNode.fileId) {
        tree.orphans.push({
          fileId: destNode.fileId,
          originalPath: newNormalized,
          orphanedAt: Date.now(),
        });
      }
      // For directories, we'd need to orphan all file descendants
      // For now, just remove the deleted node from tree
      delete destChildren[destName];
    }

    // Remove from source parent
    const sourceChildren =
      sourceParent && 'children' in sourceParent
        ? sourceParent.children
        : sourceParent && (sourceParent as VfsNode).children;

    if (sourceChildren) {
      delete sourceChildren[sourceName];
    }

    // Add to destination
    sourceNode.updatedAt = Date.now();
    destChildren[getBasename(newNormalized)] = sourceNode;

    await saveTree(projectId, tree);
  });
}

// ============================================================================
// Existence Checks
// ============================================================================

/**
 * Check if a path exists (and is not deleted)
 */
export async function exists(
  projectId: string,
  path: string,
  namespace?: string
): Promise<boolean> {
  return withTreeLock(projectId, async () => {
    const tree = await loadTree(projectId);
    const normalized = resolveNamespacedPath(path, namespace);

    if (isRootPath(normalized)) return true;

    const { node } = navigateToNode(tree, normalized);
    return node !== null && !node.deleted;
  });
}

/**
 * Check if path is a file
 */
export async function isFile(
  projectId: string,
  path: string,
  namespace?: string
): Promise<boolean> {
  return withTreeLock(projectId, async () => {
    const tree = await loadTree(projectId);
    const normalized = resolveNamespacedPath(path, namespace);
    const { node } = navigateToNode(tree, normalized);
    return node !== null && node.type === 'file' && !node.deleted;
  });
}

/**
 * Check if path is a directory
 */
export async function isDirectory(
  projectId: string,
  path: string,
  namespace?: string
): Promise<boolean> {
  return withTreeLock(projectId, async () => {
    const tree = await loadTree(projectId);
    const normalized = resolveNamespacedPath(path, namespace);

    if (isRootPath(normalized)) return true;

    const { node } = navigateToNode(tree, normalized);
    return node !== null && node.type === 'dir' && !node.deleted;
  });
}

// ============================================================================
// Restore Operations
// ============================================================================

/**
 * Restore a soft-deleted file or directory
 * @throws VfsError if path not found or not deleted
 */
export async function restore(projectId: string, path: string, namespace?: string): Promise<void> {
  assertWritable(path, namespace);
  return withTreeLock(projectId, async () => {
    const tree = await loadTree(projectId);
    const normalized = resolveNamespacedPath(path, namespace);
    const { node } = navigateToNode(tree, normalized);

    if (!node) {
      throw new VfsError(`Path not found: ${normalized}`, 'PATH_NOT_FOUND');
    }

    if (!node.deleted) {
      // Not deleted - no-op
      return;
    }

    node.deleted = false;
    node.updatedAt = Date.now();

    // If it's a directory, we only restore the directory itself, not children
    // (children can be restored individually)

    await saveTree(projectId, tree);
  });
}

// ============================================================================
// Hard Delete (Permanent)
// ============================================================================

/**
 * Permanently delete a file/directory and all its versions
 * Only works on soft-deleted items
 * @throws VfsError if not deleted
 */
export async function purge(projectId: string, path: string, namespace?: string): Promise<void> {
  assertWritable(path, namespace);
  return withTreeLock(projectId, async () => {
    const tree = await loadTree(projectId);
    const normalized = resolveNamespacedPath(path, namespace);
    const { node, parent, name } = navigateToNode(tree, normalized);

    if (!node) {
      throw new VfsError(`Path not found: ${normalized}`, 'PATH_NOT_FOUND');
    }

    if (!node.deleted) {
      throw new VfsError(`Cannot purge non-deleted item: ${normalized}`, 'INVALID_PATH');
    }

    // Collect all fileIds to purge (including nested for directories)
    const fileIds: string[] = [];
    const collectFileIds = (n: VfsNode) => {
      if (n.type === 'file' && n.fileId) {
        fileIds.push(n.fileId);
      }
      if (n.children) {
        for (const child of Object.values(n.children)) {
          collectFileIds(child);
        }
      }
    };
    collectFileIds(node);

    // Delete file contents and versions
    const adapter = storage.getAdapter();
    for (const fileId of fileIds) {
      await deleteFileContent(fileId);
      // Delete all versions
      await adapter.deleteMany(Tables.VFS_VERSIONS, { parentId: fileId });
    }

    // Remove from tree
    const parentChildren =
      parent && 'children' in parent ? parent.children : parent && (parent as VfsNode).children;
    if (parentChildren && name) {
      delete parentChildren[name];
    }

    await saveTree(projectId, tree);
  });
}

// ============================================================================
// Project-level Operations
// ============================================================================

/**
 * Clear all VFS data for a project
 */
export async function clearVfs(projectId: string): Promise<void> {
  return withTreeLock(projectId, async () => {
    const adapter = storage.getAdapter();

    // Delete meta
    const metaId = `vfs_meta_${projectId}`;
    await adapter.delete(Tables.VFS_META, metaId);

    // Delete all files for this project
    await adapter.deleteMany(Tables.VFS_FILES, { parentId: projectId });

    // Note: vfs_versions have parentId = fileId, so we'd need to track those
    // For now, orphaned versions will be cleaned up by a future maintenance task
  });
}

/**
 * Check if a project has any VFS data
 */
export async function hasVfs(projectId: string): Promise<boolean> {
  return withTreeLock(projectId, async () => {
    const adapter = storage.getAdapter();
    const metaId = `vfs_meta_${projectId}`;
    const record = await adapter.get(Tables.VFS_META, metaId);
    return record !== null;
  });
}

// ============================================================================
// Stat Operation
// ============================================================================

export interface VfsStat {
  isFile: boolean;
  isDirectory: boolean;
  size: number; // Content length for files, 0 for directories
  createdAt: number; // Unix timestamp (ms)
  updatedAt: number; // Unix timestamp (ms)
  isBinary: boolean; // true for binary files, false for text/directories
  mime: string; // MIME type (text/plain for text, detected for binary)
}

/**
 * Get stat information for a path
 * @throws VfsError if path not found or is deleted
 */
export async function stat(projectId: string, path: string, namespace?: string): Promise<VfsStat> {
  return withTreeLock(projectId, async () => {
    const tree = await loadTree(projectId);
    const normalized = resolveNamespacedPath(path, namespace);

    // Handle root directory
    if (isRootPath(normalized)) {
      return {
        isFile: false,
        isDirectory: true,
        size: 0,
        createdAt: 0,
        updatedAt: 0,
        isBinary: false,
        mime: 'application/x-directory',
      };
    }

    const { node } = navigateToNode(tree, normalized);

    if (!node) {
      throw new VfsError(`Path not found: ${normalized}`, 'PATH_NOT_FOUND');
    }

    if (node.deleted) {
      throw new VfsError(`Path is deleted: ${normalized}`, 'IS_DELETED');
    }

    const isFileNode = node.type === 'file';
    const isDirectoryNode = node.type === 'dir';

    let size = 0;
    if (isFileNode && node.fileId) {
      const file = await loadFile(node.fileId);
      if (file) {
        size = file.content.length;
      }
    }

    const isBinary = isFileNode ? (node.isBinary ?? false) : false;
    const mime = isFileNode
      ? (node.mime ?? (isBinary ? 'application/octet-stream' : 'text/plain'))
      : 'application/x-directory';

    return {
      isFile: isFileNode,
      isDirectory: isDirectoryNode,
      size,
      createdAt: node.createdAt,
      updatedAt: node.updatedAt,
      isBinary,
      mime,
    };
  });
}

/**
 * Get file metadata (version, timestamps, minStoredVersion) without loading content
 */
export async function getFileMeta(
  projectId: string,
  path: string
): Promise<{
  version: number;
  createdAt: number;
  updatedAt: number;
  minStoredVersion: number;
  storedVersionCount: number;
} | null> {
  return withTreeLock(projectId, async () => {
    const tree = await loadTree(projectId);
    const normalized = normalizePath(path);
    const { node } = navigateToNode(tree, normalized);

    if (!node || node.type !== 'file' || node.deleted || !node.fileId) {
      return null;
    }

    const file = await loadFile(node.fileId);
    if (!file) return null;

    const minStoredVersion = file.minStoredVersion ?? 1;
    const storedVersionCount = file.version - minStoredVersion + 1;

    return {
      version: file.version,
      createdAt: file.createdAt,
      updatedAt: file.updatedAt,
      minStoredVersion,
      storedVersionCount,
    };
  });
}

/**
 * Get fileId for a path (internal use for versioning)
 */
export async function getFileId(projectId: string, path: string): Promise<string | null> {
  return withTreeLock(projectId, async () => {
    const tree = await loadTree(projectId);
    const normalized = normalizePath(path);
    const { node } = navigateToNode(tree, normalized);

    if (!node || node.type !== 'file' || !node.fileId) {
      return null;
    }

    return node.fileId;
  });
}

// ============================================================================
// Versioning Operations
// ============================================================================

export interface VersionInfo {
  version: number;
  createdAt: number;
}

/**
 * Get content of a specific version
 * @param _projectId Project ID (reserved for future use)
 * @param fileId The file's stable UUID
 * @param version Version number (1 = first version)
 * @returns Content string or null if version not found
 */
export async function getVersion(
  _projectId: string,
  fileId: string,
  version: number
): Promise<string | null> {
  return withTreeLock(_projectId, async () => {
    // Version 1 is the initial create, not stored in vfs_versions
    // Versions 2+ are stored in vfs_versions as the "before" state
    // Current version is in vfs_files

    // First, load the current file to get its version
    const currentFile = await loadFile(fileId);
    if (!currentFile) return null;

    // If requesting current version, return current content
    if (version === currentFile.version) {
      return currentFile.content;
    }

    // If requesting version beyond current, not found
    if (version > currentFile.version || version < 1) {
      return null;
    }

    // Look up historical version
    const versionData = await loadVersion(fileId, version);
    if (!versionData) return null;

    return versionData.content;
  });
}

/**
 * List all versions of a file
 * @param _projectId Project ID (reserved for future use)
 * @param fileId The file's stable UUID
 * @returns Array of version info, sorted by version (ascending)
 */
export async function listVersions(_projectId: string, fileId: string): Promise<VersionInfo[]> {
  return withTreeLock(_projectId, async () => {
    const currentFile = await loadFile(fileId);
    if (!currentFile) return [];

    const versions: VersionInfo[] = [];

    // Historical versions (1 to currentVersion - 1)
    for (let v = 1; v < currentFile.version; v++) {
      const versionData = await loadVersion(fileId, v);
      if (versionData) {
        versions.push({
          version: versionData.version,
          createdAt: versionData.createdAt,
        });
      }
    }

    // Current version
    versions.push({
      version: currentFile.version,
      createdAt: currentFile.updatedAt,
    });

    return versions;
  });
}

/**
 * Drop old versions of a file, keeping only the most recent N versions
 * @param projectId Project ID
 * @param fileId The file's stable UUID
 * @param keepCount Number of versions to keep (default: 10)
 * @returns Number of versions deleted
 */
export async function dropOldVersions(
  projectId: string,
  fileId: string,
  keepCount = 10
): Promise<number> {
  return withTreeLock(projectId, async () => {
    const currentFile = await loadFile(fileId);
    if (!currentFile) return 0;

    const totalVersions = currentFile.version;
    if (totalVersions <= keepCount) return 0;

    // Delete versions 1 to (totalVersions - keepCount)
    // Current version is in vfs_files, historical are in vfs_versions
    const deleteUpTo = totalVersions - keepCount;
    const newMinStoredVersion = deleteUpTo + 1;
    const adapter = storage.getAdapter();
    let deleted = 0;

    for (let v = 1; v <= deleteUpTo; v++) {
      const versionId = `${fileId}_v${v}`;
      try {
        await adapter.delete(Tables.VFS_VERSIONS, versionId);
        deleted++;
      } catch {
        // Version might not exist (e.g., already deleted)
      }
    }

    // Update minStoredVersion in the file metadata
    if (deleted > 0) {
      const updatedFile: VfsFile = {
        ...currentFile,
        minStoredVersion: newMinStoredVersion,
      };
      await saveFile(fileId, updatedFile, projectId);
    }

    return deleted;
  });
}

// ============================================================================
// Orphan Management
// ============================================================================

export interface OrphanInfo {
  fileId: string;
  originalPath: string;
  orphanedAt: number;
}

/**
 * List all orphaned files for a project
 * Orphans are files displaced by rename operations
 */
export async function listOrphans(projectId: string): Promise<OrphanInfo[]> {
  return withTreeLock(projectId, async () => {
    const tree = await loadTree(projectId);
    return tree.orphans.map(o => ({
      fileId: o.fileId,
      originalPath: o.originalPath,
      orphanedAt: o.orphanedAt,
    }));
  });
}

/**
 * Restore an orphaned file to a new path
 * @param projectId Project ID
 * @param fileId The orphan's fileId
 * @param targetPath Path to restore the file to
 * @throws VfsError if orphan not found, target exists, or target parent invalid
 */
export async function restoreOrphan(
  projectId: string,
  fileId: string,
  targetPath: string
): Promise<void> {
  return withTreeLock(projectId, async () => {
    const tree = await loadTree(projectId);

    // Find the orphan
    const orphanIndex = tree.orphans.findIndex(o => o.fileId === fileId);
    if (orphanIndex === -1) {
      throw new VfsError(`Orphan not found: ${fileId}`, 'PATH_NOT_FOUND');
    }

    const normalized = normalizePath(targetPath);
    const basename = getBasename(normalized);

    if (!basename) {
      throw new VfsError('Cannot restore to root path', 'INVALID_PATH');
    }

    // Check if target already exists
    const { node: existingNode } = navigateToNode(tree, normalized);
    if (existingNode && !existingNode.deleted) {
      throw new VfsError(`Target path already exists: ${normalized}`, 'DESTINATION_EXISTS');
    }

    // Ensure parent directory exists
    const parent = ensureParentExists(tree, normalized);
    if (!parent) {
      throw new VfsError(`Parent path is not a directory`, 'NOT_A_DIRECTORY');
    }

    const children = 'children' in parent ? parent.children : (parent as VfsNode).children;
    if (!children) {
      throw new VfsError(`Parent is not a directory`, 'NOT_A_DIRECTORY');
    }

    // Load the orphan's file data to get timestamps
    const file = await loadFile(fileId);
    if (!file) {
      throw new VfsError(`Orphan file data not found: ${fileId}`, 'PATH_NOT_FOUND');
    }

    const now = Date.now();

    // If there's a deleted node at target, remove it (it was already displaced or will be lost)
    if (existingNode && existingNode.deleted) {
      delete children[basename];
    }

    // Create new node pointing to the orphan's fileId
    children[basename] = {
      type: 'file',
      fileId,
      deleted: false,
      createdAt: file.createdAt,
      updatedAt: now,
    };

    // Remove from orphans list
    tree.orphans.splice(orphanIndex, 1);

    await saveTree(projectId, tree);
  });
}

/**
 * Permanently delete an orphaned file and all its versions
 * @param projectId Project ID
 * @param fileId The orphan's fileId
 * @throws VfsError if orphan not found
 */
export async function purgeOrphan(projectId: string, fileId: string): Promise<void> {
  return withTreeLock(projectId, async () => {
    const tree = await loadTree(projectId);

    // Find the orphan
    const orphanIndex = tree.orphans.findIndex(o => o.fileId === fileId);
    if (orphanIndex === -1) {
      throw new VfsError(`Orphan not found: ${fileId}`, 'PATH_NOT_FOUND');
    }

    // Delete file content
    await deleteFileContent(fileId);

    // Delete all versions
    const adapter = storage.getAdapter();
    await adapter.deleteMany(Tables.VFS_VERSIONS, { parentId: fileId });

    // Remove from orphans list
    tree.orphans.splice(orphanIndex, 1);

    await saveTree(projectId, tree);
  });
}

// ============================================================================
// Text Editing Operations (for LLM-style edits)
// ============================================================================

/**
 * Count occurrences of a substring in content
 */
function countOccurrences(content: string, searchStr: string): number {
  let count = 0;
  let pos = 0;
  while ((pos = content.indexOf(searchStr, pos)) !== -1) {
    count++;
    pos += 1;
  }
  return count;
}

/**
 * Find all line numbers where a string starts (1-indexed)
 */
function findOccurrenceLines(content: string, searchStr: string): number[] {
  const lines: number[] = [];
  let pos = 0;
  while ((pos = content.indexOf(searchStr, pos)) !== -1) {
    const lineNum = content.substring(0, pos).split('\n').length;
    lines.push(lineNum);
    pos += 1;
  }
  return lines;
}

/**
 * Format a snippet of content around a line for display (with line numbers)
 */
export function formatSnippet(content: string, centerLine: number, contextLines = 3): string {
  const lines = content.split('\n');
  const start = Math.max(0, centerLine - 1 - contextLines);
  const end = Math.min(lines.length, centerLine + contextLines);
  const snippetLines = lines.slice(start, end);

  return snippetLines.map((line, i) => `${String(start + i + 1).padStart(6)}\t${line}`).join('\n');
}

export interface StrReplaceResult {
  editLine: number;
  snippet: string;
}

/**
 * Replace a unique string in a file (LLM-style str_replace)
 * Requires exactly one occurrence of oldStr - ensures precise edits.
 * @param projectId Project ID
 * @param path File path
 * @param oldStr String to find (must be unique)
 * @param newStr Replacement string
 * @returns Edit location info with snippet
 * @throws VfsError if string not found, not unique, or file issues
 */
export async function strReplace(
  projectId: string,
  path: string,
  oldStr: string,
  newStr: string,
  namespace?: string
): Promise<StrReplaceResult> {
  assertWritable(path, namespace);
  return withTreeLock(projectId, async () => {
    const tree = await loadTree(projectId);
    const normalized = resolveNamespacedPath(path, namespace);
    const { node } = navigateToNode(tree, normalized);

    if (!node) {
      throw new VfsError(`Path not found: ${normalized}`, 'PATH_NOT_FOUND');
    }
    if (node.type !== 'file') {
      throw new VfsError(`Not a file: ${normalized}`, 'NOT_A_FILE');
    }
    if (node.deleted) {
      throw new VfsError(`File is deleted: ${normalized}`, 'IS_DELETED');
    }

    const fileId = node.fileId!;
    const currentFile = await loadFile(fileId);
    if (!currentFile) {
      throw new VfsError(`File content not found: ${normalized}`, 'PATH_NOT_FOUND');
    }

    const content = currentFile.content;
    const occurrences = countOccurrences(content, oldStr);

    if (occurrences === 0) {
      throw new VfsError(
        `String not found in ${normalized}: "${oldStr.slice(0, 50)}${oldStr.length > 50 ? '...' : ''}"`,
        'STRING_NOT_FOUND'
      );
    }

    if (occurrences > 1) {
      const lineNumbers = findOccurrenceLines(content, oldStr);
      throw new VfsError(
        `Multiple occurrences (${occurrences}) found in lines: ${lineNumbers.join(', ')}`,
        'STRING_NOT_UNIQUE'
      );
    }

    // Find line where replacement occurs
    const replacePos = content.indexOf(oldStr);
    const editLine = content.substring(0, replacePos).split('\n').length;

    // Perform replacement
    const newContent = content.replace(oldStr, newStr);

    // Save current version to history, then update file
    await saveVersion(fileId, currentFile.version, currentFile.content, currentFile.updatedAt);

    const now = Date.now();
    const newFile: VfsFile = {
      content: newContent,
      version: currentFile.version + 1,
      createdAt: currentFile.createdAt,
      updatedAt: now,
    };

    await saveFile(fileId, newFile, projectId);
    node.updatedAt = now;
    await saveTree(projectId, tree);

    return {
      editLine,
      snippet: formatSnippet(newContent, editLine),
    };
  });
}

export interface InsertResult {
  insertedAt: number;
}

/**
 * Insert text at a specific line (LLM-style insert)
 * @param projectId Project ID
 * @param path File path
 * @param insertLine Line number to insert at (0-indexed: 0 = before first line)
 * @param insertText Text to insert
 * @returns Insert location info
 * @throws VfsError if line invalid or file issues
 */
export async function insert(
  projectId: string,
  path: string,
  insertLine: number,
  insertText: string,
  namespace?: string
): Promise<InsertResult> {
  assertWritable(path, namespace);
  return withTreeLock(projectId, async () => {
    const tree = await loadTree(projectId);
    const normalized = resolveNamespacedPath(path, namespace);
    const { node } = navigateToNode(tree, normalized);

    if (!node) {
      throw new VfsError(`Path not found: ${normalized}`, 'PATH_NOT_FOUND');
    }
    if (node.type !== 'file') {
      throw new VfsError(`Not a file: ${normalized}`, 'NOT_A_FILE');
    }
    if (node.deleted) {
      throw new VfsError(`File is deleted: ${normalized}`, 'IS_DELETED');
    }

    const fileId = node.fileId!;
    const currentFile = await loadFile(fileId);
    if (!currentFile) {
      throw new VfsError(`File content not found: ${normalized}`, 'PATH_NOT_FOUND');
    }

    const content = currentFile.content;
    const lines = content.split('\n');
    const nLines = lines.length;

    // insertLine is 0-indexed for insertion: 0 means before first line
    if (insertLine < 0 || insertLine > nLines) {
      throw new VfsError(
        `Invalid line ${insertLine} in ${normalized}. Valid range: [0, ${nLines}]`,
        'INVALID_LINE'
      );
    }

    // Insert the text at the specified line
    const textLines = insertText.split('\n');
    lines.splice(insertLine, 0, ...textLines);
    const newContent = lines.join('\n');

    // Save current version to history, then update file
    await saveVersion(fileId, currentFile.version, currentFile.content, currentFile.updatedAt);

    const now = Date.now();
    const newFile: VfsFile = {
      content: newContent,
      version: currentFile.version + 1,
      createdAt: currentFile.createdAt,
      updatedAt: now,
    };

    await saveFile(fileId, newFile, projectId);
    node.updatedAt = now;
    await saveTree(projectId, tree);

    return {
      insertedAt: insertLine,
    };
  });
}
