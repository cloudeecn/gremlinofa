/**
 * Filesystem Tool
 *
 * Client-side tool that provides Claude with access to the project's virtual filesystem.
 * Similar to memory tool but operates from VFS root (/) with /memories as readonly.
 *
 * This is a stateless tool - all state is passed via toolOptions and context.
 * Commands: view, create, str_replace, insert, delete, rename, copy, mkdir, append
 */

import type {
  ClientSideTool,
  ToolContext,
  ToolOptions,
  ToolResult,
  ToolStreamEvent,
} from '../../protocol/types';
import type { VfsAdapter } from '../vfs/vfsAdapter';
import { VfsError, normalizePath, base64ToBuffer } from '../vfs';
import { formatFileWithLineNumbers } from '../../engine/lib/formatFileContent';

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
  file_text?: string;
  overwrite?: boolean;
}

interface StrReplaceInput {
  command: 'str_replace';
  path: string;
  old_str: string;
  new_str?: string;
}

interface InsertInput {
  command: 'insert';
  path: string;
  insert_line: number;
  insert_text?: string;
}

interface DeleteInput {
  command: 'delete';
  path: string;
}

interface RenameInput {
  command: 'rename';
  old_path: string;
  new_path: string;
  overwrite?: boolean;
}

interface CopyInput {
  command: 'copy';
  old_path: string;
  new_path: string;
  overwrite?: boolean;
}

interface MkdirInput {
  command: 'mkdir';
  path: string;
}

interface AppendInput {
  command: 'append';
  path: string;
  file_text?: string;
}

interface ViewAllInput {
  command: 'view-all';
  paths: string[];
}

type FsInput =
  | ViewInput
  | CreateInput
  | StrReplaceInput
  | InsertInput
  | DeleteInput
  | RenameInput
  | CopyInput
  | MkdirInput
  | AppendInput
  | ViewAllInput;

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
async function listTwoLevels(adapter: VfsAdapter, basePath: string): Promise<ListingEntry[]> {
  const entries: ListingEntry[] = [];

  // Level 1: direct children
  const level1 = await adapter.readDir(basePath);

  for (const entry of level1) {
    const entryPath = basePath === '/' ? `/${entry.name}` : `${basePath}/${entry.name}`;
    entries.push({ path: entryPath, size: entry.size });

    // Level 2: children of directories
    if (entry.type === 'dir') {
      try {
        const level2 = await adapter.readDir(entryPath);
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
// Command Handlers (stateless - receive adapter explicitly)
// ============================================================================

/** Handle view command */
async function handleView(
  adapter: VfsAdapter,
  path: string,
  viewRange?: [number, number],
  noLineNumbers?: boolean
): Promise<ToolResult> {
  const vfsPath = normalizePath(path);

  // Directory listing (root or any directory)
  try {
    // Check if it's a directory first
    const isDir = await adapter.isDirectory(vfsPath);

    if (isDir) {
      const entries = await listTwoLevels(adapter, vfsPath);

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
    const result = await adapter.readFileWithMeta(vfsPath);

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

    let formattedContent: string;
    if (noLineNumbers) {
      if (viewRange) {
        const [start, end] = viewRange;
        formattedContent = lines.slice(start - 1, end).join('\n');
      } else {
        formattedContent = result.content;
      }
    } else if (viewRange) {
      const [start, end] = viewRange;
      formattedContent = formatFileWithLineNumbers(result.content, start, end);
    } else {
      formattedContent = formatFileWithLineNumbers(result.content);
    }

    const label = noLineNumbers ? '' : ' with line numbers';
    return {
      content: `Here's the content of ${vfsPath}${label}:\n${formattedContent}`,
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
  adapter: VfsAdapter,
  path: string,
  fileText: string,
  overwrite?: boolean
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
      const base64Data = dataUrlMatch[2];
      const buffer = base64ToBuffer(base64Data);
      await adapter.createFileGuarded(vfsPath, buffer, overwrite);
      return {
        content: `Binary file created successfully at: ${vfsPath}`,
      };
    }

    // Text file
    await adapter.createFileGuarded(vfsPath, fileText, overwrite);

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
  adapter: VfsAdapter,
  path: string,
  oldStr: string,
  newStr: string
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
    const { snippet } = await adapter.strReplace(vfsPath, oldStr, newStr);

    return {
      content: `The file has been edited.\n${snippet}`,
    };
  } catch (error) {
    if (error instanceof VfsError) {
      if (error.code === 'STRING_NOT_FOUND') {
        return {
          content: `No replacement was performed, old_str \`${oldStr}\` did not appear verbatim in ${vfsPath}.`,
          isError: true,
        };
      }
      if (error.code === 'STRING_NOT_UNIQUE') {
        // Extract "in lines: X, Y" from VfsError message
        const linesMatch = error.message.match(/in lines: (.+)$/);
        const linesPart = linesMatch ? linesMatch[1] : 'unknown';
        return {
          content: `No replacement was performed. Multiple occurrences of old_str \`${oldStr}\` in lines: ${linesPart}. Please ensure it is unique`,
          isError: true,
        };
      }
      if (error.code === 'BINARY_FILE') {
        return {
          content: `Error: Cannot use str_replace on binary file ${vfsPath}. Use create command with dataUrl to overwrite.`,
          isError: true,
        };
      }
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
  adapter: VfsAdapter,
  path: string,
  insertLine: number,
  insertText: string
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
    await adapter.insert(vfsPath, insertLine, insertText);

    return {
      content: `The file ${vfsPath} has been edited.`,
    };
  } catch (error) {
    if (error instanceof VfsError) {
      if (error.code === 'BINARY_FILE') {
        return {
          content: `Error: Cannot use insert on binary file ${vfsPath}. Use create command with dataUrl to overwrite.`,
          isError: true,
        };
      }
      if (error.code === 'INVALID_LINE') {
        return {
          content: `Error: Invalid \`insert_line\` parameter: ${insertLine}. It should be within the range of lines of the file: ${error.message.match(/Valid range: (.+)$/)?.[1] ?? 'unknown'}`,
          isError: true,
        };
      }
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
async function handleDelete(adapter: VfsAdapter, path: string): Promise<ToolResult> {
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
    await adapter.deletePath(vfsPath);
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
    }
    return {
      content: `Error: The path ${vfsPath} could not be deleted`,
      isError: true,
    };
  }
}

/** Handle rename command */
async function handleRename(
  adapter: VfsAdapter,
  oldPath: string,
  newPath: string,
  overwrite?: boolean
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
    await adapter.rename(oldVfsPath, newVfsPath, overwrite);

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
          content: `Error: The destination ${newVfsPath} already exists. Set overwrite to true to replace.`,
          isError: true,
        };
      }
    }
    throw error;
  }
}

/** Handle copy command */
async function handleCopy(
  adapter: VfsAdapter,
  sourcePath: string,
  destPath: string,
  overwrite?: boolean
): Promise<ToolResult> {
  const srcVfsPath = normalizePath(sourcePath);
  const dstVfsPath = normalizePath(destPath);

  if (srcVfsPath === '/') {
    return {
      content: `Error: The path / is a directory, not a file.`,
      isError: true,
    };
  }

  if (dstVfsPath === '/') {
    return {
      content: `Error: Cannot copy to the root path.`,
      isError: true,
    };
  }

  // Readonly check on destination only (source is a read)
  if (isReadonly(dstVfsPath)) {
    return {
      content: `Error: Cannot write to readonly path ${dstVfsPath}. The /memories directory is managed by the memory tool.`,
      isError: true,
    };
  }

  try {
    await adapter.copyFile(srcVfsPath, dstVfsPath, overwrite);

    return {
      content: `Successfully copied ${srcVfsPath} to ${dstVfsPath}`,
    };
  } catch (error) {
    if (error instanceof VfsError) {
      if (error.code === 'NOT_A_FILE' && error.message.includes('directory')) {
        return {
          content: `Error: The destination ${dstVfsPath} is a directory.`,
          isError: true,
        };
      }
      if (error.code === 'DESTINATION_EXISTS') {
        return {
          content: `Error: The destination ${dstVfsPath} already exists. Set overwrite to true to replace.`,
          isError: true,
        };
      }
      if (error.code === 'PATH_NOT_FOUND' || error.code === 'IS_DELETED') {
        return {
          content: `Error: The path ${srcVfsPath} does not exist.`,
          isError: true,
        };
      }
      if (error.code === 'NOT_A_FILE') {
        return {
          content: `Error: The path ${srcVfsPath} is a directory, not a file.`,
          isError: true,
        };
      }
      if (error.code === 'READONLY') {
        return { content: `Error: ${error.message}`, isError: true };
      }
    }
    throw error;
  }
}

/** Handle mkdir command */
async function handleMkdir(adapter: VfsAdapter, path: string): Promise<ToolResult> {
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
    await adapter.mkdir(vfsPath);

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
  adapter: VfsAdapter,
  path: string,
  fileText: string
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
    const { created } = await adapter.appendFile(vfsPath, fileText);

    if (created) {
      return {
        content: `File created successfully at: ${vfsPath}`,
      };
    }
    return {
      content: `Content appended to ${vfsPath}`,
    };
  } catch (error) {
    if (error instanceof VfsError) {
      if (error.code === 'BINARY_FILE') {
        return {
          content: `Error: Cannot append to binary file ${vfsPath}.`,
          isError: true,
        };
      }
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

/** Handle view-all command — batch multiple file reads into one result */
async function handleMultiView(
  adapter: VfsAdapter,
  paths: string[],
  noLineNumbers?: boolean
): Promise<ToolResult> {
  if (!paths || paths.length === 0) {
    return {
      content: 'Error: paths array is required and must not be empty.',
      isError: true,
    };
  }

  const sections: string[] = [];
  let errorCount = 0;

  for (const path of paths) {
    const result = await handleView(adapter, path, undefined, noLineNumbers);
    if (result.isError) {
      errorCount++;
      const vfsPath = normalizePath(path);
      sections.push(`=== ${vfsPath} [ERROR] ===\n${result.content}`);
    } else {
      const vfsPath = normalizePath(path);
      sections.push(`=== ${vfsPath} ===\n${result.content}`);
    }
  }

  return {
    content: sections.join('\n\n'),
    isError: errorCount === paths.length,
  };
}

/** Execute a filesystem command */
// eslint-disable-next-line require-yield -- Simple tool: generator for interface compatibility, no streaming events
async function* executeFsCommand(
  input: Record<string, unknown>,
  _toolOptions?: ToolOptions,
  context?: ToolContext
): AsyncGenerator<ToolStreamEvent, ToolResult, void> {
  if (!context?.vfsAdapter) {
    return {
      content: 'Error: vfsAdapter is required in context',
      isError: true,
    };
  }

  const adapter = context.vfsAdapter;
  const noLineNumbers = context.noLineNumbers;
  const fsInput = input as unknown as FsInput;

  // Validate required fields before dispatch — LLMs sometimes omit them
  const cmd = input.command;
  if (!cmd || typeof cmd !== 'string') {
    return { content: 'Error: command is required', isError: true };
  }

  const requirePath = ['view', 'create', 'str_replace', 'insert', 'delete', 'mkdir', 'append'];
  if (requirePath.includes(cmd) && (!input.path || typeof input.path !== 'string')) {
    return { content: `Error: path is required for ${cmd} command`, isError: true };
  }

  if (cmd === 'rename' || cmd === 'copy') {
    if (
      !input.old_path ||
      typeof input.old_path !== 'string' ||
      !input.new_path ||
      typeof input.new_path !== 'string'
    ) {
      return {
        content: `Error: old_path and new_path are required for ${cmd} command`,
        isError: true,
      };
    }
  }

  if (cmd === 'str_replace' && (input.old_str === undefined || typeof input.old_str !== 'string')) {
    return { content: 'Error: old_str is required for str_replace command', isError: true };
  }

  if (
    cmd === 'insert' &&
    (input.insert_line === undefined || typeof input.insert_line !== 'number')
  ) {
    return { content: 'Error: insert_line (number) is required for insert command', isError: true };
  }

  if (cmd === 'view-all' && !Array.isArray(input.paths)) {
    return { content: 'Error: paths (array) is required for view-all command', isError: true };
  }

  switch (fsInput.command) {
    case 'view':
      return handleView(adapter, fsInput.path, fsInput.view_range, noLineNumbers);
    case 'create':
      return handleCreate(adapter, fsInput.path, fsInput.file_text ?? '', fsInput.overwrite);
    case 'str_replace':
      return handleStrReplace(adapter, fsInput.path, fsInput.old_str, fsInput.new_str ?? '');
    case 'insert':
      return handleInsert(adapter, fsInput.path, fsInput.insert_line, fsInput.insert_text ?? '');
    case 'delete':
      return handleDelete(adapter, fsInput.path);
    case 'rename':
      return handleRename(adapter, fsInput.old_path, fsInput.new_path, fsInput.overwrite);
    case 'copy':
      return handleCopy(adapter, fsInput.old_path, fsInput.new_path, fsInput.overwrite);
    case 'mkdir':
      return handleMkdir(adapter, fsInput.path);
    case 'append':
      return handleAppend(adapter, fsInput.path, fsInput.file_text ?? '');
    case 'view-all':
      return handleMultiView(adapter, fsInput.paths, noLineNumbers);
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
The create command fails if the file already exists. Set overwrite to true to replace existing files.
The str_replace command replaces text in a file. Requires an exact, unique match of old_str. Omitting new_str deletes the matched text.
The mkdir command creates a new directory. The append command appends text to an existing file, or creates the file if it does not exist.
The rename command renames a file or directory. Fails if destination exists unless overwrite is true.
The copy command copies a file from old_path to new_path. Source must be a file. Fails if destination exists unless overwrite is true. Errors if destination is a directory.
The view-all command reads multiple files in one call. Takes a paths array, returns concatenated content with === path === headers. No view_range support.`,
  iconInput: '📁',
  renderInput: renderFsInput,
  inputSchema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        enum: [
          'view',
          'create',
          'str_replace',
          'insert',
          'delete',
          'rename',
          'copy',
          'mkdir',
          'append',
          'view-all',
        ],
        description: 'The command to execute',
      },
      path: {
        type: 'string',
        description: 'Path to the file or directory (absolute, e.g., /data/file.txt)',
      },
      paths: {
        type: 'array',
        items: { type: 'string' },
        description: 'Required for view-all command. Array of file paths to read.',
      },
      file_text: {
        type: 'string',
        description: 'Content for create and append commands',
      },
      overwrite: {
        type: 'boolean',
        description:
          'If true, overwrite existing destination. Used with create, copy, and rename commands. Default: false.',
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
        description: 'Source path for rename and copy commands',
      },
      new_path: {
        type: 'string',
        description: 'Destination path for rename and copy commands',
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
