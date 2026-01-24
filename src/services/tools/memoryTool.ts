/**
 * Memory Tool
 *
 * Client-side tool that provides Claude with a persistent virtual filesystem.
 * Implements Anthropic's memory tool commands: view, create, str_replace, insert, delete, rename.
 *
 * Supports two modes:
 * - Native mode (Anthropic): Uses memory_20250818 shorthand via apiOverrides
 * - System prompt mode: Injects memory listing and README.md into system prompt
 *
 * Internally uses VfsService for tree-structured storage with versioning.
 */

import { type ClientSideTool, type SystemPromptContext, type ToolResult } from '../../types';
import * as vfs from '../vfs/vfsService';
import { VfsError } from '../vfs/vfsService';
import { toolRegistry } from './clientSideTools';

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

type MemoryInput =
  | ViewInput
  | CreateInput
  | StrReplaceInput
  | InsertInput
  | DeleteInput
  | RenameInput;

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
    const entryPath = `${basePath}/${entry.name}`;
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
        // Directory might be empty or inaccessible, skip
      }
    }
  }

  return entries;
}

/**
 * Memory Tool instance for a specific project.
 * Uses VfsService for persistent storage with versioning.
 */
export class MemoryToolInstance {
  private projectId: string;

  constructor(projectId: string) {
    this.projectId = projectId;
  }

  /** Handle view command */
  async handleView(path: string, viewRange?: [number, number]): Promise<ToolResult> {
    const vfsPath = normalizeToVfsPath(path);

    // Directory listing (root)
    if (vfsPath === MEMORIES_ROOT) {
      try {
        // Ensure the /memories directory exists
        const memoriesExists = await vfs.exists(this.projectId, MEMORIES_ROOT);
        if (!memoriesExists) {
          return {
            content: `Here're the files and directories up to 2 levels deep in ${MEMORIES_ROOT}, excluding hidden items and node_modules:\n(empty)`,
          };
        }

        const entries = await listTwoLevels(this.projectId, MEMORIES_ROOT);

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
          const entries = await listTwoLevels(this.projectId, vfsPath);
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
  async handleCreate(path: string, fileText: string): Promise<ToolResult> {
    const vfsPath = normalizeToVfsPath(path);

    if (vfsPath === MEMORIES_ROOT) {
      return {
        content: 'Error: Cannot create a file at the root path.',
        isError: true,
      };
    }

    try {
      // Ensure /memories directory exists
      const memoriesExists = await vfs.exists(this.projectId, MEMORIES_ROOT);
      if (!memoriesExists) {
        await vfs.mkdir(this.projectId, MEMORIES_ROOT);
      }

      await vfs.createFile(this.projectId, vfsPath, fileText);

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
  async handleStrReplace(path: string, oldStr: string, newStr: string): Promise<ToolResult> {
    const vfsPath = normalizeToVfsPath(path);

    if (vfsPath === MEMORIES_ROOT) {
      return {
        content: `Error: The path ${MEMORIES_ROOT} does not exist. Please provide a valid path.`,
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
        content: `The memory file has been edited.\n${snippet}`,
      };
    } catch (error) {
      if (error instanceof VfsError) {
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
  async handleInsert(path: string, insertLine: number, insertText: string): Promise<ToolResult> {
    const vfsPath = normalizeToVfsPath(path);

    if (vfsPath === MEMORIES_ROOT) {
      return {
        content: `Error: The path ${MEMORIES_ROOT} does not exist`,
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
  async handleDelete(path: string): Promise<ToolResult> {
    const vfsPath = normalizeToVfsPath(path);

    if (vfsPath === MEMORIES_ROOT) {
      return {
        content: `Error: The path ${MEMORIES_ROOT} does not exist`,
        isError: true,
      };
    }

    try {
      await vfs.deleteFile(this.projectId, vfsPath);

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
        if (error.code === 'NOT_A_FILE') {
          // Try deleting as a directory
          try {
            await vfs.rmdir(this.projectId, vfsPath, true);
            return {
              content: `Successfully deleted ${vfsPath}`,
            };
          } catch {
            return {
              content: `Error: The path ${vfsPath} does not exist`,
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
      await vfs.rename(this.projectId, oldVfsPath, newVfsPath);

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
            content: `Error: The destination ${newVfsPath} already exists`,
            isError: true,
          };
        }
      }
      throw error;
    }
  }

  /** Execute a memory command */
  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const memoryInput = input as unknown as MemoryInput;

    switch (memoryInput.command) {
      case 'view':
        return this.handleView(memoryInput.path, memoryInput.view_range);
      case 'create':
        return this.handleCreate(memoryInput.path, memoryInput.file_text);
      case 'str_replace':
        return this.handleStrReplace(memoryInput.path, memoryInput.old_str, memoryInput.new_str);
      case 'insert':
        return this.handleInsert(
          memoryInput.path,
          memoryInput.insert_line,
          memoryInput.insert_text
        );
      case 'delete':
        return this.handleDelete(memoryInput.path);
      case 'rename':
        return this.handleRename(memoryInput.old_path, memoryInput.new_path);
      default:
        return {
          content: `Unknown memory command: ${(memoryInput as { command: string }).command}`,
          isError: true,
        };
    }
  }
}

// Active memory tool instances keyed by projectId
const instances = new Map<string, MemoryToolInstance>();

/**
 * Initialize memory tool for a project.
 * Creates a new instance for VFS-backed storage.
 * Also registers the memory tool with the global toolRegistry.
 */
export async function initMemoryTool(projectId: string): Promise<MemoryToolInstance> {
  const existing = instances.get(projectId);
  if (existing) {
    return existing;
  }

  const instance = new MemoryToolInstance(projectId);
  instances.set(projectId, instance);

  // Register memory tool with the global registry
  toolRegistry.register(createMemoryClientSideTool(projectId));

  return instance;
}

/**
 * Get active memory tool instance for a project.
 * Returns undefined if not initialized.
 */
export function getMemoryTool(projectId: string): MemoryToolInstance | undefined {
  return instances.get(projectId);
}

/**
 * Dispose memory tool for a project.
 * Should be called when chat closes.
 * Also unregisters the memory tool from the global toolRegistry.
 */
export function disposeMemoryTool(_projectId: string): void {
  toolRegistry.unregister('memory');
  instances.delete(_projectId);
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
 */
async function getMemorySystemPrompt(context: SystemPromptContext): Promise<string> {
  const { projectId } = context;

  const parts: string[] = [];

  // Part 1: Description and file listing
  const description = `You have access to a persistent memory system under /memories with "memory" tool. Use it to record your progress, status, thoughts, and important information across conversations. Changes to README.md will immediately reflect in this system prompt on the next message.

Unless asked otherwise, as you make progress, record status / progress / thoughts etc in your memory and use README.md as an index.`;

  try {
    const memoriesExists = await vfs.exists(projectId, MEMORIES_ROOT);
    if (memoriesExists) {
      const entries = await listTwoLevels(projectId, MEMORIES_ROOT);

      if (entries.length > 0) {
        const listing = entries
          .map(entry => {
            const size = entry.size !== undefined ? formatSize(entry.size) : '0';
            return `${size}\t${entry.path}`;
          })
          .join('\n');

        parts.push(`## Memory

${description}

### Files

Here are the files and directories up to 2 levels deep in /memories:
<listing>
${listing}
</listing>`);
      } else {
        parts.push(`## Memory

${description}

The /memories directory is empty.`);
      }
    } else {
      parts.push(`## Memory

${description}

The /memories directory is empty.`);
    }
  } catch {
    parts.push(`## Memory

${description}

The /memories directory is empty.`);
  }

  // Part 2: Read /memories/README.md if it exists
  const readmePath = `${MEMORIES_ROOT}/README.md`;
  try {
    const readmeExists = await vfs.exists(projectId, readmePath);
    if (readmeExists) {
      const content = await vfs.readFile(projectId, readmePath);
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
* The create command creates or overwrites text files with the content specified in the file_text parameter.
* The str_replace command replaces text in a file. Requires an exact, unique match of old_str (whitespace sensitive).
  - Will fail if old_str doesn't exist or appears multiple times
  - Omitting new_str deletes the matched text
* The insert command inserts the text insert_text at the line insert_line.
* The delete command deletes a file or directory (including all contents if a directory).
* The rename command renames a file or directory. Both old_path and new_path must be provided.
* All operations are restricted to files and directories within /memories.
* You cannot delete or rename /memories itself, only its contents.
* Note: when editing your memory folder, always try to keep the content up-to-date, coherent and organized. You can rename or delete files that are no longer relevant. Do not create new files unless necessary.`;

// Input schema per Anthropic spec
const MEMORY_INPUT_SCHEMA = {
  type: 'object' as const,
  properties: {
    command: {
      description:
        'The operation to perform. Choose from: view, create, str_replace, insert, delete, rename.',
      enum: ['view', 'create', 'str_replace', 'insert', 'delete', 'rename'],
      type: 'string',
    },
    file_text: {
      description:
        'Required for create command. Contains the complete text content to write to the file.',
      type: 'string',
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
      description: 'Required for rename command. The new path for the file or directory.',
      type: 'string',
    },
    new_str: {
      description:
        'Optional for str_replace command. The text that will replace old_str. If omitted, old_str will be deleted without replacement.',
      type: 'string',
    },
    old_path: {
      description:
        'Required for rename command. The current path of the file or directory to rename.',
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
    view_range: {
      description:
        'Optional parameter for the view command (text files only). Format: [start_line, end_line]',
      items: { type: 'integer' },
      type: 'array',
    },
  },
  required: ['command'],
};

// Track whether to use system prompt mode (set per project during init)
const projectUseSystemPrompt = new Map<string, boolean>();

/**
 * Set whether to use system prompt mode for a project.
 * Called during memory tool initialization based on project settings.
 */
export function setMemoryUseSystemPrompt(projectId: string, useSystemPrompt: boolean): void {
  projectUseSystemPrompt.set(projectId, useSystemPrompt);
}

/**
 * Create a ClientSideTool adapter for the memory tool.
 * The actual execution is delegated to the MemoryToolInstance.
 *
 * Two modes:
 * - Native mode (default for Anthropic): Uses memory_20250818 shorthand via apiOverrides
 * - System prompt mode: Injects memory listing into system prompt, no apiOverrides
 */
export function createMemoryClientSideTool(projectId: string): ClientSideTool {
  const useSystemPrompt = projectUseSystemPrompt.get(projectId) ?? false;

  const tool: ClientSideTool = {
    name: 'memory',
    description: MEMORY_TOOL_DESCRIPTION,
    iconInput: '🧠',
    renderInput: renderMemoryInput,
    inputSchema: MEMORY_INPUT_SCHEMA,
    execute: async (input: Record<string, unknown>): Promise<ToolResult> => {
      const instance = getMemoryTool(projectId);
      if (!instance) {
        return {
          content: 'Memory tool not initialized for this project',
          isError: true,
        };
      }
      return instance.execute(input);
    },
  };

  // Only add systemPrompt function if using system prompt mode
  if (useSystemPrompt) {
    tool.systemPrompt = getMemorySystemPrompt;
  } else {
    // Use Anthropic's native memory tool shorthand
    tool.apiOverrides = {
      ['anthropic']: {
        type: 'memory_20250818',
        name: 'memory',
      },
    };
  }

  return tool;
}

/**
 * Re-register the memory tool when settings change.
 * Called when project.memoryUseSystemPrompt changes.
 */
export function updateMemoryToolMode(projectId: string, useSystemPrompt: boolean): void {
  setMemoryUseSystemPrompt(projectId, useSystemPrompt);

  // Re-register if already initialized
  if (instances.has(projectId)) {
    toolRegistry.unregister('memory');
    toolRegistry.register(createMemoryClientSideTool(projectId));
  }
}
