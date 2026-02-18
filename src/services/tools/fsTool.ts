/**
 * Filesystem Tool
 *
 * Client-side tool that provides Claude with access to the project's virtual filesystem.
 * Similar to memory tool but operates from VFS root (/) with /memories as readonly.
 *
 * This is a stateless tool - all state is passed via toolOptions and context.
 * Commands: view, create, str_replace, insert, delete, rename, mkdir, append
 */

import type {
  ClientSideTool,
  ToolContext,
  ToolOptions,
  ToolResult,
  ToolStreamEvent,
} from '../../types';
import * as vfs from '../vfs/vfsService';
import { VfsError, normalizePath, base64ToBuffer } from '../vfs/vfsService';

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

interface MkdirInput {
  command: 'mkdir';
  path: string;
}

interface AppendInput {
  command: 'append';
  path: string;
  file_text: string;
}

type FsInput =
  | ViewInput
  | CreateInput
  | StrReplaceInput
  | InsertInput
  | DeleteInput
  | RenameInput
  | MkdirInput
  | AppendInput;

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
async function listTwoLevels(
  projectId: string,
  basePath: string,
  namespace?: string
): Promise<ListingEntry[]> {
  const entries: ListingEntry[] = [];

  // Level 1: direct children
  const level1 = await vfs.readDir(projectId, basePath, false, namespace);

  for (const entry of level1) {
    const entryPath = basePath === '/' ? `/${entry.name}` : `${basePath}/${entry.name}`;
    entries.push({ path: entryPath, size: entry.size });

    // Level 2: children of directories
    if (entry.type === 'dir') {
      try {
        const level2 = await vfs.readDir(projectId, entryPath, false, namespace);
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

// ============================================================================
// Command Handlers (stateless - receive projectId explicitly)
// ============================================================================

/** Handle view command */
async function handleView(
  projectId: string,
  path: string,
  viewRange?: [number, number],
  namespace?: string
): Promise<ToolResult> {
  const vfsPath = normalizePath(path);

  // Directory listing (root or any directory)
  try {
    // Check if it's a directory first
    const isDir = await vfs.isDirectory(projectId, vfsPath, namespace);

    if (isDir) {
      const entries = await listTwoLevels(projectId, vfsPath, namespace);

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

    // File content - use readFileWithMeta to handle binary files
    const result = await vfs.readFileWithMeta(projectId, vfsPath, namespace);

    // Binary files return as dataUrl
    if (result.isBinary) {
      const dataUrl = `data:${result.mime};base64,${result.content}`;
      return {
        content: `Binary file ${vfsPath} (${result.mime}):\n${dataUrl}`,
      };
    }

    // Text file
    const lines = result.content.split('\n');

    if (lines.length > MAX_LINE_COUNT) {
      return {
        content: `File ${vfsPath} exceeds maximum line limit of ${MAX_LINE_COUNT} lines.`,
        isError: true,
      };
    }

    let numberedContent: string;
    if (viewRange) {
      const [start, end] = viewRange;
      numberedContent = formatFileWithLineNumbers(result.content, start, end);
    } else {
      numberedContent = formatFileWithLineNumbers(result.content);
    }

    return {
      content: `Here's the content of ${vfsPath} with line numbers:\n${numberedContent}`,
    };
  } catch (error) {
    if (error instanceof VfsError) {
      if (error.code === 'PATH_NOT_FOUND' || error.code === 'IS_DELETED') {
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
async function handleCreate(
  projectId: string,
  path: string,
  fileText: string,
  namespace?: string
): Promise<ToolResult> {
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
    // Check for dataUrl format: data:<mime>;base64,<data>
    const dataUrlMatch = fileText.match(/^data:([^;]+);base64,(.+)$/s);
    if (dataUrlMatch) {
      // Binary file via dataUrl
      const base64Data = dataUrlMatch[2];
      const buffer = base64ToBuffer(base64Data);
      await vfs.writeFile(projectId, vfsPath, buffer, namespace);
      return {
        content: `Binary file created successfully at: ${vfsPath}`,
      };
    }

    // Text file
    await vfs.writeFile(projectId, vfsPath, fileText, namespace);

    return {
      content: `File created successfully at: ${vfsPath}`,
    };
  } catch (error) {
    if (error instanceof VfsError) {
      if (error.code === 'FILE_EXISTS') {
        return { content: `Error: File ${vfsPath} already exists`, isError: true };
      }
      if (error.code === 'READONLY') {
        return { content: `Error: ${error.message}`, isError: true };
      }
    }
    throw error;
  }
}

/** Handle str_replace command */
async function handleStrReplace(
  projectId: string,
  path: string,
  oldStr: string,
  newStr: string,
  namespace?: string
): Promise<ToolResult> {
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
    // Check if file is binary
    const fileStat = await vfs.stat(projectId, vfsPath, namespace);
    if (fileStat.isBinary) {
      return {
        content: `Error: Cannot use str_replace on binary file ${vfsPath}. Use create command with dataUrl to overwrite.`,
        isError: true,
      };
    }

    const content = await vfs.readFile(projectId, vfsPath, namespace);

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
    await vfs.updateFile(projectId, vfsPath, newContent, namespace);

    const snippet = formatEditSnippet(newContent, editLine);

    return {
      content: `The file has been edited.\n${snippet}`,
    };
  } catch (error) {
    if (error instanceof VfsError) {
      if (error.code === 'READONLY') {
        return { content: `Error: ${error.message}`, isError: true };
      }
      if (
        error.code === 'PATH_NOT_FOUND' ||
        error.code === 'IS_DELETED' ||
        error.code === 'NOT_A_FILE'
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
async function handleInsert(
  projectId: string,
  path: string,
  insertLine: number,
  insertText: string,
  namespace?: string
): Promise<ToolResult> {
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
    // Check if file is binary
    const fileStat = await vfs.stat(projectId, vfsPath, namespace);
    if (fileStat.isBinary) {
      return {
        content: `Error: Cannot use insert on binary file ${vfsPath}. Use create command with dataUrl to overwrite.`,
        isError: true,
      };
    }

    const content = await vfs.readFile(projectId, vfsPath, namespace);
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

    await vfs.updateFile(projectId, vfsPath, newContent, namespace);

    return {
      content: `The file ${vfsPath} has been edited.`,
    };
  } catch (error) {
    if (error instanceof VfsError) {
      if (error.code === 'READONLY') {
        return { content: `Error: ${error.message}`, isError: true };
      }
      if (
        error.code === 'PATH_NOT_FOUND' ||
        error.code === 'IS_DELETED' ||
        error.code === 'NOT_A_FILE'
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
async function handleDelete(
  projectId: string,
  path: string,
  namespace?: string
): Promise<ToolResult> {
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
    await vfs.deleteFile(projectId, vfsPath, namespace);
    return {
      content: `Successfully deleted ${vfsPath}`,
    };
  } catch (error) {
    if (error instanceof VfsError) {
      if (error.code === 'READONLY') {
        return { content: `Error: ${error.message}`, isError: true };
      }
      if (error.code === 'PATH_NOT_FOUND' || error.code === 'IS_DELETED') {
        return {
          content: `Error: The path ${vfsPath} does not exist`,
          isError: true,
        };
      }
      if (error.code === 'NOT_A_FILE') {
        // Try deleting as a directory
        try {
          await vfs.rmdir(projectId, vfsPath, true, namespace);
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
async function handleRename(
  projectId: string,
  oldPath: string,
  newPath: string,
  namespace?: string
): Promise<ToolResult> {
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
    await vfs.rename(projectId, oldVfsPath, newVfsPath, namespace);

    return {
      content: `Successfully renamed ${oldVfsPath} to ${newVfsPath}`,
    };
  } catch (error) {
    if (error instanceof VfsError) {
      if (error.code === 'READONLY') {
        return { content: `Error: ${error.message}`, isError: true };
      }
      if (error.code === 'PATH_NOT_FOUND' || error.code === 'IS_DELETED') {
        return {
          content: `Error: The path ${oldVfsPath} does not exist`,
          isError: true,
        };
      }
      if (error.code === 'DESTINATION_EXISTS') {
        return {
          content: `Error: The destination ${newVfsPath} already exists`,
          isError: true,
        };
      }
    }
    throw error;
  }
}

/** Handle mkdir command */
async function handleMkdir(
  projectId: string,
  path: string,
  namespace?: string
): Promise<ToolResult> {
  const vfsPath = normalizePath(path);

  if (vfsPath === '/') {
    return {
      content: 'Error: Cannot create directory at the root path.',
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
    await vfs.mkdir(projectId, vfsPath, namespace);

    return {
      content: `Directory created successfully at: ${vfsPath}`,
    };
  } catch (error) {
    if (error instanceof VfsError) {
      if (error.code === 'READONLY') {
        return { content: `Error: ${error.message}`, isError: true };
      }
      if (error.code === 'DIR_EXISTS') {
        return {
          content: `Error: Directory ${vfsPath} already exists`,
          isError: true,
        };
      }
      if (error.code === 'FILE_EXISTS') {
        return {
          content: `Error: A file already exists at ${vfsPath}`,
          isError: true,
        };
      }
    }
    throw error;
  }
}

/** Handle append command */
async function handleAppend(
  projectId: string,
  path: string,
  fileText: string,
  namespace?: string
): Promise<ToolResult> {
  const vfsPath = normalizePath(path);

  if (vfsPath === '/') {
    return {
      content: 'Error: Cannot append to the root path.',
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
    const fileExists = await vfs.exists(projectId, vfsPath, namespace);

    if (fileExists) {
      // Check if binary
      const fileStat = await vfs.stat(projectId, vfsPath, namespace);
      if (fileStat.isBinary) {
        return {
          content: `Error: Cannot append to binary file ${vfsPath}.`,
          isError: true,
        };
      }

      const content = await vfs.readFile(projectId, vfsPath, namespace);
      await vfs.updateFile(projectId, vfsPath, content + fileText, namespace);
      return {
        content: `Content appended to ${vfsPath}`,
      };
    }

    await vfs.writeFile(projectId, vfsPath, fileText, namespace);
    return {
      content: `File created successfully at: ${vfsPath}`,
    };
  } catch (error) {
    if (error instanceof VfsError) {
      if (error.code === 'READONLY') {
        return { content: `Error: ${error.message}`, isError: true };
      }
      if (error.code === 'NOT_A_FILE') {
        return {
          content: `Error: ${vfsPath} is a directory, not a file.`,
          isError: true,
        };
      }
    }
    throw error;
  }
}

/** Execute a filesystem command */
// eslint-disable-next-line require-yield -- Simple tool: generator for interface compatibility, no streaming events
async function* executeFsCommand(
  input: Record<string, unknown>,
  _toolOptions?: ToolOptions,
  context?: ToolContext
): AsyncGenerator<ToolStreamEvent, ToolResult, void> {
  if (!context?.projectId) {
    return {
      content: 'Error: projectId is required in context',
      isError: true,
    };
  }

  const projectId = context.projectId;
  const namespace = context.namespace;
  const fsInput = input as unknown as FsInput;

  switch (fsInput.command) {
    case 'view':
      return handleView(projectId, fsInput.path, fsInput.view_range, namespace);
    case 'create':
      return handleCreate(projectId, fsInput.path, fsInput.file_text, namespace);
    case 'str_replace':
      return handleStrReplace(projectId, fsInput.path, fsInput.old_str, fsInput.new_str, namespace);
    case 'insert':
      return handleInsert(
        projectId,
        fsInput.path,
        fsInput.insert_line,
        fsInput.insert_text,
        namespace
      );
    case 'delete':
      return handleDelete(projectId, fsInput.path, namespace);
    case 'rename':
      return handleRename(projectId, fsInput.old_path, fsInput.new_path, namespace);
    case 'mkdir':
      return handleMkdir(projectId, fsInput.path, namespace);
    case 'append':
      return handleAppend(projectId, fsInput.path, fsInput.file_text, namespace);
    default:
      return {
        content: `Unknown filesystem command: ${(fsInput as { command: string }).command}`,
        isError: true,
      };
  }
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
 * Filesystem tool definition.
 * Stateless - all configuration passed via toolOptions and context.
 */
export const fsTool: ClientSideTool = {
  name: 'filesystem',
  displayName: 'Filesystem Access',
  displaySubtitle: 'Read/write VFS files (/memories readonly)',
  // No options - just enable/disable
  description: `Access the project's virtual filesystem. Read/write files anywhere except /memories (readonly, managed by memory tool). Use for: storing code, data files, configuration, scripts.
Binary file support: view returns dataUrl format for binary files, create accepts dataUrl format (data:<mime>;base64,<data>) to write binary files. str_replace, insert, and append are blocked on binary files.
The mkdir command creates a new directory. The append command appends text to an existing file, or creates the file if it does not exist.`,
  iconInput: '📁',
  renderInput: renderFsInput,
  inputSchema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        enum: ['view', 'create', 'str_replace', 'insert', 'delete', 'rename', 'mkdir', 'append'],
        description: 'The command to execute',
      },
      path: {
        type: 'string',
        description: 'Path to the file or directory (absolute, e.g., /data/file.txt)',
      },
      file_text: {
        type: 'string',
        description: 'Content for create and append commands',
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
  execute: executeFsCommand,
};
