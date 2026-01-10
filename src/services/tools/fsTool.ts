/**
 * Filesystem Tool
 *
 * Client-side tool that provides Claude with access to the project's virtual filesystem.
 * Similar to memory tool but operates from VFS root (/) with /memories as readonly.
 *
 * Commands: view, create, str_replace, insert, delete, rename
 */

import type { ClientSideTool, ToolResult } from '../../types';
import * as vfs from '../vfs/vfsService';
import { VfsError, VfsErrorCode, normalizePath } from '../vfs/vfsService';
import { toolRegistry } from './clientSideTools';

const MAX_LINE_COUNT = 999999;

/** Readonly paths - writes throw EROFS error */
const READONLY_PATHS = ['/memories'];

/** Check if path is readonly */
function isReadonly(path: string): boolean {
  const normalized = normalizePath(path);
  return READONLY_PATHS.some(
    roPath => normalized === roPath || normalized.startsWith(roPath + '/')
  );
}

/** Filesystem tool command input types */
interface ViewInput {
  command: 'view';
  path: string;
  view_range?: [number, number];
}

interface CreateInput {
  command: 'create';
  path: string;
  file_text: string;
}

interface StrReplaceInput {
  command: 'str_replace';
  path: string;
  old_str: string;
  new_str: string;
}

interface InsertInput {
  command: 'insert';
  path: string;
  insert_line: number;
  insert_text: string;
}

interface DeleteInput {
  command: 'delete';
  path: string;
}

interface RenameInput {
  command: 'rename';
  old_path: string;
  new_path: string;
}

type FsInput = ViewInput | CreateInput | StrReplaceInput | InsertInput | DeleteInput | RenameInput;

/**
 * Format file content with line numbers
 * Line numbers are 6 characters, right-aligned, followed by tab
 */
function formatFileWithLineNumbers(content: string, startLine = 1, endLine?: number): string {
  const lines = content.split('\n');
  const start = startLine - 1;
  const end = endLine !== undefined ? endLine : lines.length;
  const selectedLines = lines.slice(start, end);

  return selectedLines.map((line, i) => `${String(start + i + 1).padStart(6)}\t${line}`).join('\n');
}

/**
 * Format a snippet of content around edited lines for str_replace result
 */
function formatEditSnippet(content: string, editStartLine: number): string {
  const lines = content.split('\n');
  const contextLines = 3;
  const start = Math.max(0, editStartLine - contextLines);
  const end = Math.min(lines.length, editStartLine + contextLines + 1);
  const snippetLines = lines.slice(start, end);

  return snippetLines.map((line, i) => `${String(start + i + 1).padStart(6)}\t${line}`).join('\n');
}

/**
 * Find all line numbers where a string occurs
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
 * Count occurrences of a substring
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
 * Format file size in human-readable format
 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
}

/** Entry with full path for directory listing */
interface ListingEntry {
  path: string;
  size?: number;
}

/**
 * List directory contents up to 2 levels deep
 */
async function listTwoLevels(projectId: string, basePath: string): Promise<ListingEntry[]> {
  const entries: ListingEntry[] = [];

  // Level 1: direct children
  const level1 = await vfs.readDir(projectId, basePath);

  for (const entry of level1) {
    const entryPath = basePath === '/' ? `/${entry.name}` : `${basePath}/${entry.name}`;
    entries.push({ path: entryPath, size: entry.size });

    // Level 2: children of directories
    if (entry.type === 'dir') {
      try {
        const level2 = await vfs.readDir(projectId, entryPath);
        for (const child of level2) {
          entries.push({
            path: `${entryPath}/${child.name}`,
            size: child.size,
          });
        }
      } catch {
        // Directory might be empty or inaccessible
      }
    }
  }

  return entries;
}

/**
 * Filesystem Tool instance for a specific project.
 * Uses VfsService for persistent storage with versioning.
 */
export class FsToolInstance {
  private projectId: string;

  constructor(projectId: string) {
    this.projectId = projectId;
  }

  /** Handle view command */
  async handleView(path: string, viewRange?: [number, number]): Promise<ToolResult> {
    const vfsPath = normalizePath(path);

    // Directory listing (root or any directory)
    try {
      // Check if it's a directory first
      const isDir = await vfs.isDirectory(this.projectId, vfsPath);

      if (isDir) {
        const entries = await listTwoLevels(this.projectId, vfsPath);

        if (entries.length === 0) {
          return {
            content: `Here're the files and directories up to 2 levels deep in ${vfsPath}, excluding hidden items:\n(empty)`,
          };
        }

        const listing = entries
          .map(entry => {
            const size = entry.size !== undefined ? formatSize(entry.size) : '0';
            return `${size}\t${entry.path}`;
          })
          .join('\n');

        return {
          content: `Here're the files and directories up to 2 levels deep in ${vfsPath}, excluding hidden items:\n${listing}`,
        };
      }

      // File content
      const content = await vfs.readFile(this.projectId, vfsPath);
      const lines = content.split('\n');

      if (lines.length > MAX_LINE_COUNT) {
        return {
          content: `File ${vfsPath} exceeds maximum line limit of ${MAX_LINE_COUNT} lines.`,
          isError: true,
        };
      }

      let numberedContent: string;
      if (viewRange) {
        const [start, end] = viewRange;
        numberedContent = formatFileWithLineNumbers(content, start, end);
      } else {
        numberedContent = formatFileWithLineNumbers(content);
      }

      return {
        content: `Here's the content of ${vfsPath} with line numbers:\n${numberedContent}`,
      };
    } catch (error) {
      if (error instanceof VfsError) {
        if (error.code === VfsErrorCode.PATH_NOT_FOUND || error.code === VfsErrorCode.IS_DELETED) {
          return {
            content: `The path ${vfsPath} does not exist. Please provide a valid path.`,
            isError: true,
          };
        }
      }
      throw error;
    }
  }

  /** Handle create command */
  async handleCreate(path: string, fileText: string): Promise<ToolResult> {
    const vfsPath = normalizePath(path);

    if (vfsPath === '/') {
      return {
        content: 'Error: Cannot create a file at the root path.',
        isError: true,
      };
    }

    // Check readonly
    if (isReadonly(vfsPath)) {
      return {
        content: `Error: Cannot write to readonly path ${vfsPath}. The /memories directory is managed by the memory tool.`,
        isError: true,
      };
    }

    try {
      await vfs.createFile(this.projectId, vfsPath, fileText);

      return {
        content: `File created successfully at: ${vfsPath}`,
      };
    } catch (error) {
      if (error instanceof VfsError && error.code === VfsErrorCode.FILE_EXISTS) {
        return {
          content: `Error: File ${vfsPath} already exists`,
          isError: true,
        };
      }
      throw error;
    }
  }

  /** Handle str_replace command */
  async handleStrReplace(path: string, oldStr: string, newStr: string): Promise<ToolResult> {
    const vfsPath = normalizePath(path);

    if (vfsPath === '/') {
      return {
        content: `Error: The path / is a directory, not a file.`,
        isError: true,
      };
    }

    // Check readonly
    if (isReadonly(vfsPath)) {
      return {
        content: `Error: Cannot write to readonly path ${vfsPath}. The /memories directory is managed by the memory tool.`,
        isError: true,
      };
    }

    try {
      const content = await vfs.readFile(this.projectId, vfsPath);

      const occurrences = countOccurrences(content, oldStr);

      if (occurrences === 0) {
        return {
          content: `No replacement was performed, old_str \`${oldStr}\` did not appear verbatim in ${vfsPath}.`,
          isError: true,
        };
      }

      if (occurrences > 1) {
        const lineNumbers = findOccurrenceLines(content, oldStr);
        return {
          content: `No replacement was performed. Multiple occurrences of old_str \`${oldStr}\` in lines: ${lineNumbers.join(', ')}. Please ensure it is unique`,
          isError: true,
        };
      }

      // Find line number where replacement occurs
      const beforeReplace = content.substring(0, content.indexOf(oldStr));
      const editLine = beforeReplace.split('\n').length;

      // Replace first (and only) occurrence
      const newContent = content.replace(oldStr, newStr);
      await vfs.updateFile(this.projectId, vfsPath, newContent);

      const snippet = formatEditSnippet(newContent, editLine);

      return {
        content: `The file has been edited.\n${snippet}`,
      };
    } catch (error) {
      if (error instanceof VfsError) {
        if (
          error.code === VfsErrorCode.PATH_NOT_FOUND ||
          error.code === VfsErrorCode.IS_DELETED ||
          error.code === VfsErrorCode.NOT_A_FILE
        ) {
          return {
            content: `Error: The path ${vfsPath} does not exist or is not a file.`,
            isError: true,
          };
        }
      }
      throw error;
    }
  }

  /** Handle insert command */
  async handleInsert(path: string, insertLine: number, insertText: string): Promise<ToolResult> {
    const vfsPath = normalizePath(path);

    if (vfsPath === '/') {
      return {
        content: `Error: The path / is a directory, not a file.`,
        isError: true,
      };
    }

    // Check readonly
    if (isReadonly(vfsPath)) {
      return {
        content: `Error: Cannot write to readonly path ${vfsPath}. The /memories directory is managed by the memory tool.`,
        isError: true,
      };
    }

    try {
      const content = await vfs.readFile(this.projectId, vfsPath);
      const lines = content.split('\n');
      const nLines = lines.length;

      // insert_line is 0-indexed for insertion: 0 means before first line
      if (insertLine < 0 || insertLine > nLines) {
        return {
          content: `Error: Invalid \`insert_line\` parameter: ${insertLine}. It should be within the range of lines of the file: [0, ${nLines}]`,
          isError: true,
        };
      }

      // Insert the text at the specified line
      const textLines = insertText.split('\n');
      lines.splice(insertLine, 0, ...textLines);
      const newContent = lines.join('\n');

      await vfs.updateFile(this.projectId, vfsPath, newContent);

      return {
        content: `The file ${vfsPath} has been edited.`,
      };
    } catch (error) {
      if (error instanceof VfsError) {
        if (
          error.code === VfsErrorCode.PATH_NOT_FOUND ||
          error.code === VfsErrorCode.IS_DELETED ||
          error.code === VfsErrorCode.NOT_A_FILE
        ) {
          return {
            content: `Error: The path ${vfsPath} does not exist or is not a file.`,
            isError: true,
          };
        }
      }
      throw error;
    }
  }

  /** Handle delete command */
  async handleDelete(path: string): Promise<ToolResult> {
    const vfsPath = normalizePath(path);

    if (vfsPath === '/') {
      return {
        content: `Error: Cannot delete root directory.`,
        isError: true,
      };
    }

    // Check readonly
    if (isReadonly(vfsPath)) {
      return {
        content: `Error: Cannot delete readonly path ${vfsPath}. The /memories directory is managed by the memory tool.`,
        isError: true,
      };
    }

    try {
      // Try as file first
      await vfs.deleteFile(this.projectId, vfsPath);
      return {
        content: `Successfully deleted ${vfsPath}`,
      };
    } catch (error) {
      if (error instanceof VfsError) {
        if (error.code === VfsErrorCode.PATH_NOT_FOUND || error.code === VfsErrorCode.IS_DELETED) {
          return {
            content: `Error: The path ${vfsPath} does not exist`,
            isError: true,
          };
        }
        if (error.code === VfsErrorCode.NOT_A_FILE) {
          // Try deleting as a directory
          try {
            await vfs.rmdir(this.projectId, vfsPath, true);
            return {
              content: `Successfully deleted ${vfsPath}`,
            };
          } catch {
            return {
              content: `Error: The path ${vfsPath} could not be deleted`,
              isError: true,
            };
          }
        }
      }
      throw error;
    }
  }

  /** Handle rename command */
  async handleRename(oldPath: string, newPath: string): Promise<ToolResult> {
    const oldVfsPath = normalizePath(oldPath);
    const newVfsPath = normalizePath(newPath);

    if (oldVfsPath === '/') {
      return {
        content: `Error: Cannot rename root directory.`,
        isError: true,
      };
    }

    // Check readonly for both source and destination
    if (isReadonly(oldVfsPath)) {
      return {
        content: `Error: Cannot move from readonly path ${oldVfsPath}. The /memories directory is managed by the memory tool.`,
        isError: true,
      };
    }
    if (isReadonly(newVfsPath)) {
      return {
        content: `Error: Cannot move to readonly path ${newVfsPath}. The /memories directory is managed by the memory tool.`,
        isError: true,
      };
    }

    try {
      await vfs.rename(this.projectId, oldVfsPath, newVfsPath);

      return {
        content: `Successfully renamed ${oldVfsPath} to ${newVfsPath}`,
      };
    } catch (error) {
      if (error instanceof VfsError) {
        if (error.code === VfsErrorCode.PATH_NOT_FOUND || error.code === VfsErrorCode.IS_DELETED) {
          return {
            content: `Error: The path ${oldVfsPath} does not exist`,
            isError: true,
          };
        }
        if (error.code === VfsErrorCode.DESTINATION_EXISTS) {
          return {
            content: `Error: The destination ${newVfsPath} already exists`,
            isError: true,
          };
        }
      }
      throw error;
    }
  }

  /** Execute a filesystem command */
  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const fsInput = input as unknown as FsInput;

    switch (fsInput.command) {
      case 'view':
        return this.handleView(fsInput.path, fsInput.view_range);
      case 'create':
        return this.handleCreate(fsInput.path, fsInput.file_text);
      case 'str_replace':
        return this.handleStrReplace(fsInput.path, fsInput.old_str, fsInput.new_str);
      case 'insert':
        return this.handleInsert(fsInput.path, fsInput.insert_line, fsInput.insert_text);
      case 'delete':
        return this.handleDelete(fsInput.path);
      case 'rename':
        return this.handleRename(fsInput.old_path, fsInput.new_path);
      default:
        return {
          content: `Unknown filesystem command: ${(fsInput as { command: string }).command}`,
          isError: true,
        };
    }
  }
}

// Active filesystem tool instances keyed by projectId
const instances = new Map<string, FsToolInstance>();

/**
 * Initialize filesystem tool for a project.
 * Creates a new instance and registers with toolRegistry.
 */
export async function initFsTool(projectId: string): Promise<FsToolInstance> {
  const existing = instances.get(projectId);
  if (existing) {
    return existing;
  }

  const instance = new FsToolInstance(projectId);
  instances.set(projectId, instance);

  // Register filesystem tool with the global registry
  toolRegistry.register(createFsClientSideTool(projectId));

  return instance;
}

/**
 * Get active filesystem tool instance for a project.
 * Returns undefined if not initialized.
 */
export function getFsTool(projectId: string): FsToolInstance | undefined {
  return instances.get(projectId);
}

/**
 * Dispose filesystem tool for a project.
 * Should be called when chat closes.
 */
export function disposeFsTool(_projectId: string): void {
  toolRegistry.unregister('filesystem');
  instances.delete(_projectId);
}

/** Render filesystem tool input for display */
function renderFsInput(input: Record<string, unknown>): string {
  const lines: string[] = [];
  const longFields = ['file_text', 'old_str', 'new_str', 'insert_text'];

  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;

    if (longFields.includes(key) && typeof value === 'string') {
      lines.push(`${key}:`);
      lines.push(value);
    } else {
      lines.push(`${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
    }
  }

  return lines.join('\n');
}

/**
 * Create a ClientSideTool adapter for the filesystem tool.
 */
export function createFsClientSideTool(projectId: string): ClientSideTool {
  return {
    name: 'filesystem',
    description: `Access the project's virtual filesystem. Read/write files anywhere except /memories (readonly, managed by memory tool). Use for: storing code, data files, configuration, scripts.`,
    iconInput: '📁',
    renderInput: renderFsInput,
    inputSchema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          enum: ['view', 'create', 'str_replace', 'insert', 'delete', 'rename'],
          description: 'The command to execute',
        },
        path: {
          type: 'string',
          description: 'Path to the file or directory (absolute, e.g., /data/file.txt)',
        },
        file_text: {
          type: 'string',
          description: 'Content for create command',
        },
        old_str: {
          type: 'string',
          description: 'String to find for str_replace command',
        },
        new_str: {
          type: 'string',
          description: 'Replacement string for str_replace command',
        },
        insert_line: {
          type: 'number',
          description: 'Line number to insert at for insert command (0-indexed)',
        },
        insert_text: {
          type: 'string',
          description: 'Text to insert for insert command',
        },
        old_path: {
          type: 'string',
          description: 'Source path for rename command',
        },
        new_path: {
          type: 'string',
          description: 'Destination path for rename command',
        },
        view_range: {
          type: 'array',
          items: { type: 'number' },
          description: 'Optional line range [start, end] for view command',
        },
      },
      required: ['command'],
    },
    execute: async (input: Record<string, unknown>): Promise<ToolResult> => {
      const instance = getFsTool(projectId);
      if (!instance) {
        return {
          content: 'Filesystem tool not initialized for this project',
          isError: true,
        };
      }
      return instance.execute(input);
    },
  };
}
