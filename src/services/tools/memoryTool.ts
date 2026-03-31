/**
 * Memory Tool
 *
 * Client-side tool that provides Claude with a persistent virtual filesystem.
 * Implements Anthropic's memory tool commands: view, create, str_replace, insert, delete, rename, copy, mkdir, append.
 *
 * Supports two modes:
 * - Native mode (Anthropic default): Uses memory_20250818 shorthand via getApiOverride()
 * - System prompt mode: Injects memory listing and README.md into system prompt
 *
 * This is a stateless tool - all state is passed via toolOptions and context.
 * Internally uses VfsAdapter for tree-structured storage with versioning.
 */

import type {
  APIType,
  ClientSideTool,
  SystemPromptContext,
  ToolContext,
  ToolOptions,
  ToolResult,
  ToolStreamEvent,
} from '../../types';
import type { VfsAdapter } from '../vfs/vfsAdapter';
import { VfsError } from '../vfs';
import { LocalVfsAdapter } from '../vfs/localVfsAdapter';
import { formatFileWithLineNumbers } from '../../utils/formatFileContent';

const MEMORIES_ROOT = '/memories';
const MAX_LINE_COUNT = 999999;
const README_MAX_CHARS = 32000; // 32k limit for README.md content

/** Memory tool command input types */
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

type MemoryInput =
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
 * Normalizes a user-provided path to a VFS path.
 * User paths like "/memories/file.md", "file.md", "/file.md" all become "/memories/file.md"
 */
function normalizeToVfsPath(path: string): string {
  let normalized = path.trim();

  // Remove leading /memories/ or /memories prefix to get the relative part
  if (normalized.startsWith(MEMORIES_ROOT + '/')) {
    normalized = normalized.slice(MEMORIES_ROOT.length + 1);
  } else if (normalized === MEMORIES_ROOT) {
    return MEMORIES_ROOT;
  } else if (normalized.startsWith('/')) {
    normalized = normalized.slice(1);
  }

  // If empty, it's the root
  if (!normalized) {
    return MEMORIES_ROOT;
  }

  return `${MEMORIES_ROOT}/${normalized}`;
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
async function listTwoLevels(adapter: VfsAdapter, basePath: string): Promise<ListingEntry[]> {
  const entries: ListingEntry[] = [];

  // Level 1: direct children
  const level1 = await adapter.readDir(basePath);

  for (const entry of level1) {
    const entryPath = `${basePath}/${entry.name}`;
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
        // Directory might be empty or inaccessible, skip
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
  const vfsPath = normalizeToVfsPath(path);

  // Directory listing (root)
  if (vfsPath === MEMORIES_ROOT) {
    try {
      // Ensure the /memories directory exists
      const memoriesExists = await adapter.exists(MEMORIES_ROOT);
      if (!memoriesExists) {
        return {
          content: `Here're the files and directories up to 2 levels deep in ${MEMORIES_ROOT}, excluding hidden items and node_modules:\n(empty)`,
        };
      }

      const entries = await listTwoLevels(adapter, MEMORIES_ROOT);

      if (entries.length === 0) {
        return {
          content: `Here're the files and directories up to 2 levels deep in ${MEMORIES_ROOT}, excluding hidden items and node_modules:\n(empty)`,
        };
      }

      const listing = entries
        .map(entry => {
          const size = entry.size !== undefined ? formatSize(entry.size) : '0';
          return `${size}\t${entry.path}`;
        })
        .join('\n');

      return {
        content: `Here're the files and directories up to 2 levels deep in ${MEMORIES_ROOT}, excluding hidden items and node_modules:\n${listing}`,
      };
    } catch (error) {
      if (error instanceof VfsError && error.code === 'PATH_NOT_FOUND') {
        return {
          content: `Here're the files and directories up to 2 levels deep in ${MEMORIES_ROOT}, excluding hidden items and node_modules:\n(empty)`,
        };
      }
      throw error;
    }
  }

  // File content
  try {
    const content = await adapter.readFile(vfsPath);
    const lines = content.split('\n');

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
        formattedContent = content;
      }
    } else if (viewRange) {
      const [start, end] = viewRange;
      formattedContent = formatFileWithLineNumbers(content, start, end);
    } else {
      formattedContent = formatFileWithLineNumbers(content);
    }

    const label = noLineNumbers ? '' : ' with line numbers';
    return {
      content: `Here's the content of ${vfsPath}${label}:\n${formattedContent}`,
    };
  } catch (error) {
    if (error instanceof VfsError) {
      if (error.code === 'PATH_NOT_FOUND') {
        return {
          content: `The path ${vfsPath} does not exist. Please provide a valid path.`,
          isError: true,
        };
      }
      if (error.code === 'IS_DELETED') {
        return {
          content: `The path ${vfsPath} does not exist. Please provide a valid path.`,
          isError: true,
        };
      }
      if (error.code === 'NOT_A_FILE') {
        // It's a directory, list its contents (2 levels deep)
        const entries = await listTwoLevels(adapter, vfsPath);
        const listing = entries
          .map(entry => {
            const size = entry.size !== undefined ? formatSize(entry.size) : '0';
            return `${size}\t${entry.path}`;
          })
          .join('\n');

        return {
          content: `Here're the files and directories up to 2 levels deep in ${vfsPath}, excluding hidden items and node_modules:\n${listing || '(empty)'}`,
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
  const vfsPath = normalizeToVfsPath(path);

  if (vfsPath === MEMORIES_ROOT) {
    return {
      content: 'Error: Cannot create a file at the root path.',
      isError: true,
    };
  }

  try {
    if (overwrite) {
      await adapter.writeFile(vfsPath, fileText);
    } else {
      await adapter.createFile(vfsPath, fileText);
    }

    return {
      content: `File created successfully at: ${vfsPath}`,
    };
  } catch (error) {
    if (error instanceof VfsError && error.code === 'FILE_EXISTS') {
      return {
        content: `Error: File ${vfsPath} already exists`,
        isError: true,
      };
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
  const vfsPath = normalizeToVfsPath(path);

  if (vfsPath === MEMORIES_ROOT) {
    return {
      content: `Error: The path ${MEMORIES_ROOT} does not exist. Please provide a valid path.`,
      isError: true,
    };
  }

  try {
    const { snippet } = await adapter.strReplace(vfsPath, oldStr, newStr);

    return {
      content: `The memory file has been edited.\n${snippet}`,
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
        return {
          content: `No replacement was performed. Multiple occurrences of old_str \`${oldStr}\`. Please ensure it is unique`,
          isError: true,
        };
      }
      if (
        error.code === 'PATH_NOT_FOUND' ||
        error.code === 'IS_DELETED' ||
        error.code === 'NOT_A_FILE'
      ) {
        return {
          content: `Error: The path ${vfsPath} does not exist. Please provide a valid path.`,
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
  const vfsPath = normalizeToVfsPath(path);

  if (vfsPath === MEMORIES_ROOT) {
    return {
      content: `Error: The path ${MEMORIES_ROOT} does not exist`,
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
      if (error.code === 'INVALID_LINE') {
        return {
          content: `Error: Invalid \`insert_line\` parameter: ${insertLine}. It should be within the range of lines of the file.`,
          isError: true,
        };
      }
      if (
        error.code === 'PATH_NOT_FOUND' ||
        error.code === 'IS_DELETED' ||
        error.code === 'NOT_A_FILE'
      ) {
        return {
          content: `Error: The path ${vfsPath} does not exist`,
          isError: true,
        };
      }
    }
    throw error;
  }
}

/** Handle delete command */
async function handleDelete(adapter: VfsAdapter, path: string): Promise<ToolResult> {
  const vfsPath = normalizeToVfsPath(path);

  if (vfsPath === MEMORIES_ROOT) {
    return {
      content: `Error: The path ${MEMORIES_ROOT} does not exist`,
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
      if (error.code === 'PATH_NOT_FOUND' || error.code === 'IS_DELETED') {
        return {
          content: `Error: The path ${vfsPath} does not exist`,
          isError: true,
        };
      }
    }
    throw error;
  }
}

/** Handle rename command */
async function handleRename(
  adapter: VfsAdapter,
  oldPath: string,
  newPath: string,
  overwrite?: boolean
): Promise<ToolResult> {
  const oldVfsPath = normalizeToVfsPath(oldPath);
  const newVfsPath = normalizeToVfsPath(newPath);

  if (oldVfsPath === MEMORIES_ROOT) {
    return {
      content: `Error: The path ${MEMORIES_ROOT} does not exist`,
      isError: true,
    };
  }

  if (newVfsPath === MEMORIES_ROOT) {
    return {
      content: `Error: The destination ${MEMORIES_ROOT} already exists`,
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
      if (error.code === 'PATH_NOT_FOUND') {
        return {
          content: `Error: The path ${oldVfsPath} does not exist`,
          isError: true,
        };
      }
      if (error.code === 'IS_DELETED') {
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
  const srcVfsPath = normalizeToVfsPath(sourcePath);
  const dstVfsPath = normalizeToVfsPath(destPath);

  if (srcVfsPath === MEMORIES_ROOT) {
    return {
      content: `Error: The path ${MEMORIES_ROOT} is a directory, not a file.`,
      isError: true,
    };
  }

  if (dstVfsPath === MEMORIES_ROOT) {
    return {
      content: `Error: Cannot copy to the root path.`,
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
      if (error.code === 'NOT_A_FILE') {
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
    }
    throw error;
  }
}

/** Handle mkdir command */
async function handleMkdir(adapter: VfsAdapter, path: string): Promise<ToolResult> {
  const vfsPath = normalizeToVfsPath(path);

  if (vfsPath === MEMORIES_ROOT) {
    return {
      content: 'Error: Cannot create directory at the root path.',
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
  const vfsPath = normalizeToVfsPath(path);

  if (vfsPath === MEMORIES_ROOT) {
    return {
      content: 'Error: Cannot append to the root path.',
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
      const vfsPath = normalizeToVfsPath(path);
      sections.push(`=== ${vfsPath} [ERROR] ===\n${result.content}`);
    } else {
      const vfsPath = normalizeToVfsPath(path);
      sections.push(`=== ${vfsPath} ===\n${result.content}`);
    }
  }

  return {
    content: sections.join('\n\n'),
    isError: errorCount === paths.length,
  };
}

/** Execute a memory command */
// eslint-disable-next-line require-yield -- Simple tool: generator for interface compatibility, no streaming events
async function* executeMemoryCommand(
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
  const memoryInput = input as unknown as MemoryInput;

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

  switch (memoryInput.command) {
    case 'view':
      return handleView(adapter, memoryInput.path, memoryInput.view_range, context.noLineNumbers);
    case 'create':
      return handleCreate(
        adapter,
        memoryInput.path,
        memoryInput.file_text ?? '',
        memoryInput.overwrite
      );
    case 'str_replace':
      return handleStrReplace(
        adapter,
        memoryInput.path,
        memoryInput.old_str,
        memoryInput.new_str ?? ''
      );
    case 'insert':
      return handleInsert(
        adapter,
        memoryInput.path,
        memoryInput.insert_line,
        memoryInput.insert_text ?? ''
      );
    case 'delete':
      return handleDelete(adapter, memoryInput.path);
    case 'rename':
      return handleRename(
        adapter,
        memoryInput.old_path,
        memoryInput.new_path,
        memoryInput.overwrite
      );
    case 'copy':
      return handleCopy(adapter, memoryInput.old_path, memoryInput.new_path, memoryInput.overwrite);
    case 'mkdir':
      return handleMkdir(adapter, memoryInput.path);
    case 'append':
      return handleAppend(adapter, memoryInput.path, memoryInput.file_text ?? '');
    case 'view-all':
      return handleMultiView(adapter, memoryInput.paths, context.noLineNumbers);
    default:
      return {
        content: `Unknown memory command: ${(memoryInput as { command: string }).command}`,
        isError: true,
      };
  }
}

/** Render memory tool input for display */
function renderMemoryInput(input: Record<string, unknown>): string {
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
 * Generate the memory system prompt for a project.
 * Returns listing of /memories and content of /memories/README.md (if exists).
 *
 * Uses context.createVfsAdapter when available (routes to correct backend for remote VFS),
 * falls back to LocalVfsAdapter for standalone/test scenarios.
 */
async function getMemorySystemPrompt(
  context: SystemPromptContext,
  toolOptions: ToolOptions
): Promise<string> {
  const { projectId, apiType, namespace } = context;

  // System prompt injection rules:
  // - Anthropic with useSystemPrompt=false: NO injection (native tool handles it)
  // - Anthropic with useSystemPrompt=true: YES injection
  // - Non-Anthropic APIs: ALWAYS inject (they don't have native tool support)
  if (apiType === 'anthropic' && !toolOptions.useSystemPrompt) {
    return '';
  }

  const adapter: VfsAdapter = context.createVfsAdapter
    ? context.createVfsAdapter(namespace)
    : new LocalVfsAdapter(projectId, namespace);

  const parts: string[] = [];

  // Part 1: Description and file listing
  const description = toolOptions.noHandHolding
    ? ''
    : `\nYou have access to a persistent memory system under /memories with "memory" tool. Use it to record your progress, status, thoughts, and important information across conversations. Changes to README.md will immediately reflect in this system prompt on the next message.

Unless asked otherwise, as you make progress, record status / progress / thoughts etc in your memory and use README.md as an index.\n`;

  let fileListing: string;
  try {
    const memoriesExists = await adapter.exists(MEMORIES_ROOT);
    if (memoriesExists) {
      const entries = await listTwoLevels(adapter, MEMORIES_ROOT);

      if (entries.length > 0) {
        const listing = entries.map(entry => `\t${entry.path}`).join('\n');
        fileListing = `\n### Files

Here are the files and directories up to 2 levels deep in /memories:
<listing>
${listing}
</listing>`;
      } else {
        fileListing = '\nThe /memories directory is empty.';
      }
    } else {
      fileListing = '\nThe /memories directory is empty.';
    }
  } catch {
    fileListing = '\nThe /memories directory is empty.';
  }

  parts.push(`## Memory${description}${fileListing}`);

  // Part 2: Read /memories/README.md if it exists
  const readmePath = `${MEMORIES_ROOT}/README.md`;
  try {
    const readmeExists = await adapter.exists(readmePath);
    if (readmeExists) {
      const content = await adapter.readFile(readmePath);
      const lines = content.split('\n');
      const totalLines = lines.length;

      if (content.length > README_MAX_CHARS) {
        // Truncate and add note
        let charCount = 0;
        let displayedLines = 0;

        for (let i = 0; i < lines.length; i++) {
          charCount += lines[i].length + 1; // +1 for newline
          if (charCount > README_MAX_CHARS) break;
          displayedLines++;
        }

        const truncatedContent = lines.slice(0, displayedLines).join('\n');
        parts.push(`## /memories/README.md

<content>
${truncatedContent}
</content>

[Content truncated: showing lines 1-${displayedLines} of ${totalLines} total. Use the memory tool's view command with view_range to see more.]`);
      } else {
        parts.push(`## /memories/README.md

<content>
${content}
</content>`);
      }
    }
  } catch {
    // README.md doesn't exist or can't be read, skip
  }

  return parts.join('\n\n');
}

// Tool description per Anthropic spec
const MEMORY_TOOL_DESCRIPTION = `Tool for reading, writing, and managing files in a memory system that lives under /memories. This system records your own memory, and is initialized as an empty folder when the task started. This tool can only change files under /memories. This is your memory, you are free to structure this directory as you see fit.
* The view command supports the following cases:
  - Directories: Lists files and directories up to 2 levels deep, ignoring hidden items and node_modules
  - Text files: Displays numbered lines. Lines are determined from Python's .splitlines() method, which recognizes all standard line breaks. If the file contains more than 16000 characters, the output will be truncated.
* The create command creates a new text file with the content specified in the file_text parameter. It will fail if the file already exists. Set overwrite to true to replace existing files.
* The str_replace command replaces text in a file. Requires an exact, unique match of old_str (whitespace sensitive).
  - Will fail if old_str doesn't exist or appears multiple times
  - Omitting new_str deletes the matched text
* The insert command inserts the text insert_text at the line insert_line.
* The delete command deletes a file or directory (including all contents if a directory).
* The rename command renames a file or directory. Both old_path and new_path must be provided. Fails if destination exists unless overwrite is true.
* The copy command copies a file from old_path to new_path. Source must be a file. Fails if destination exists unless overwrite is true. Errors if destination is a directory.
* The mkdir command creates a new directory at the specified path.
* The append command appends text to an existing file, or creates the file if it does not exist.
* The view-all command reads multiple files in one call. Takes a paths array, returns concatenated content with === path === headers. No view_range support.
* All operations are restricted to files and directories within /memories.
* You cannot delete or rename /memories itself, only its contents.
* Note: when editing your memory folder, always try to keep the content up-to-date, coherent and organized. You can rename or delete files that are no longer relevant. Do not create new files unless necessary.`;

// Input schema per Anthropic spec
const MEMORY_INPUT_SCHEMA = {
  type: 'object' as const,
  properties: {
    command: {
      description:
        'The operation to perform. Choose from: view, create, str_replace, insert, delete, rename, copy, mkdir, append, view-all.',
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
      type: 'string',
    },
    file_text: {
      description:
        'Required for create and append commands. For create: complete text content to write. For append: text to append to the file.',
      type: 'string',
    },
    overwrite: {
      description:
        'If true, overwrite existing destination. Used with create, copy, and rename commands. Default: false.',
      type: 'boolean',
    },
    insert_line: {
      description:
        'Required parameter of insert command with line position for insertion: 0 places text at the beginning of the file, N places text after line N, and using the total number of lines in the file places text at the end.',
      type: 'integer',
    },
    insert_text: {
      description:
        'Required parameter of insert command, containing the text to insert. Must end with a newline character for the new text to appear on a separate line.',
      type: 'string',
    },
    new_path: {
      description: 'Required for rename and copy commands. The new path for the file or directory.',
      type: 'string',
    },
    new_str: {
      description:
        'Optional for str_replace command. The text that will replace old_str. If omitted, old_str will be deleted without replacement.',
      type: 'string',
    },
    old_path: {
      description:
        'Required for rename and copy commands. The current path of the file or directory.',
      type: 'string',
    },
    old_str: {
      description:
        'Required parameter of str_replace command, with string to be replaced. Must be an EXACT and UNIQUE match in the file.',
      type: 'string',
    },
    path: {
      description:
        'Required for view, create, str_replace, insert, and delete commands. Absolute path to file or directory.',
      type: 'string',
    },
    paths: {
      description: 'Required for view-all command. Array of file paths to read.',
      items: { type: 'string' },
      type: 'array',
    },
    view_range: {
      description:
        'Optional parameter for the view command (text files only). Format: [start_line, end_line]',
      items: { type: 'integer' },
      type: 'array',
    },
  },
  required: ['command'],
};

/**
 * Memory tool definition.
 * Stateless - all configuration passed via toolOptions and context.
 *
 * Two modes controlled by toolOptions.useSystemPrompt:
 * - false (default, Anthropic): Uses native memory_20250818 shorthand
 * - true (Anthropic) or any non-Anthropic API: Injects memory listing into system prompt
 */
export const memoryTool: ClientSideTool = {
  name: 'memory',
  displayName: 'Memory',
  displaySubtitle: 'Use a virtual FS to remember across conversations (Optimized for Anthropic)',
  optionDefinitions: [
    {
      type: 'boolean',
      id: 'useSystemPrompt',
      label: '(Anthropic) Use System Prompt Mode',
      subtitle:
        'Inject memory listing into system prompt instead of native tool. (Cannot disable for other providers.)',
      default: false,
    },
    {
      type: 'boolean',
      id: 'noHandHolding',
      label: 'No Hand Holding',
      subtitle: 'Only inject file listing and README into system prompt, skip the usage manual.',
      default: false,
    },
  ],
  description: MEMORY_TOOL_DESCRIPTION,
  iconInput: '🧠',
  renderInput: renderMemoryInput,
  inputSchema: MEMORY_INPUT_SCHEMA,

  /**
   * Dynamic API override.
   * Returns Anthropic native tool shorthand only when:
   * 1. API is Anthropic, AND
   * 2. NOT using system prompt mode
   */
  getApiOverride: (apiType: APIType, toolOptions: ToolOptions) => {
    if (apiType === 'anthropic' && !toolOptions.useSystemPrompt) {
      return { type: 'memory_20250818', name: 'memory' };
    }
    // All other cases: return undefined (use standard definition)
    return undefined;
  },

  /**
   * System prompt injection.
   * Returns memory listing when:
   * - Non-Anthropic API (they don't have native tool support)
   * - Anthropic with useSystemPrompt=true
   */
  systemPrompt: getMemorySystemPrompt,

  execute: executeMemoryCommand,
};
