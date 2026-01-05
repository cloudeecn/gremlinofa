/**
 * Memory Tool
 *
 * Client-side tool that provides Claude with a persistent virtual filesystem.
 * Implements Anthropic's memory tool commands: view, create, str_replace, insert, delete, rename.
 */

import { APIType, type ClientSideTool, type ToolResult } from '../../types';
import {
  loadMemory,
  saveMemory,
  saveJournalEntry,
  type MemoryFileSystem,
  type MemoryFile,
  createEmptyFileSystem,
} from '../memory/memoryStorage';
import { toolRegistry } from './clientSideTools';

const MEMORIES_ROOT = '/memories';
const MAX_LINE_COUNT = 999999;

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
 * Normalizes a path to be relative to /memories root.
 * Examples:
 *   "/memories/file.md" -> "file.md"
 *   "/memories" -> ""
 *   "file.md" -> "file.md"
 */
function normalizePath(path: string): string {
  let normalized = path.trim();

  // Remove leading /memories/ or /memories
  if (normalized.startsWith(MEMORIES_ROOT + '/')) {
    normalized = normalized.slice(MEMORIES_ROOT.length + 1);
  } else if (normalized === MEMORIES_ROOT) {
    normalized = '';
  } else if (normalized.startsWith('/')) {
    normalized = normalized.slice(1);
  }

  return normalized;
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
  const lines = content.split('\n');
  const occurrenceLines: number[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(searchStr)) {
      occurrenceLines.push(i + 1);
    }
  }

  // Also check for multi-line matches
  let pos = 0;
  let count = 0;
  while ((pos = content.indexOf(searchStr, pos)) !== -1) {
    count++;
    pos += 1;
  }

  // If we found more occurrences than lines containing it, there are multiple per line
  // or multi-line matches - return lines where matches start
  if (count > 1 && occurrenceLines.length === 0) {
    // Multi-line string that doesn't appear on a single line
    pos = 0;
    while ((pos = content.indexOf(searchStr, pos)) !== -1) {
      const lineNum = content.substring(0, pos).split('\n').length;
      occurrenceLines.push(lineNum);
      pos += 1;
    }
  }

  return occurrenceLines;
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

/**
 * Memory Tool instance for a specific project.
 * Holds the filesystem state in memory during the chat session.
 */
export class MemoryToolInstance {
  private fs: MemoryFileSystem;
  private dirty = false;
  private projectId: string;

  constructor(projectId: string, initialFs?: MemoryFileSystem) {
    this.projectId = projectId;
    this.fs = initialFs ?? createEmptyFileSystem();
  }

  /** Get current filesystem state */
  getFileSystem(): MemoryFileSystem {
    return this.fs;
  }

  /** Check if there are unsaved changes */
  isDirty(): boolean {
    return this.dirty;
  }

  /** Persist changes to storage */
  async save(): Promise<void> {
    if (this.dirty) {
      await saveMemory(this.projectId, this.fs);
      this.dirty = false;
    }
  }

  /** Handle view command */
  handleView(path: string, viewRange?: [number, number]): ToolResult {
    const normalized = normalizePath(path);

    // Directory listing (root)
    if (normalized === '') {
      const fileNames = Object.keys(this.fs.files).sort();
      if (fileNames.length === 0) {
        return {
          content: `Here're the files and directories up to 2 levels deep in ${MEMORIES_ROOT}, excluding hidden items and node_modules:\n(empty)`,
        };
      }

      const listing = fileNames
        .map(name => {
          const size = formatSize(new TextEncoder().encode(this.fs.files[name].content).length);
          return `${size}\t${MEMORIES_ROOT}/${name}`;
        })
        .join('\n');

      return {
        content: `Here're the files and directories up to 2 levels deep in ${MEMORIES_ROOT}, excluding hidden items and node_modules:\n${listing}`,
      };
    }

    // File content
    const file = this.fs.files[normalized];
    if (!file) {
      return {
        content: `The path ${MEMORIES_ROOT}/${normalized} does not exist. Please provide a valid path.`,
        isError: true,
      };
    }

    const lines = file.content.split('\n');
    if (lines.length > MAX_LINE_COUNT) {
      return {
        content: `File ${MEMORIES_ROOT}/${normalized} exceeds maximum line limit of ${MAX_LINE_COUNT} lines.`,
        isError: true,
      };
    }

    let numberedContent: string;
    if (viewRange) {
      const [start, end] = viewRange;
      numberedContent = formatFileWithLineNumbers(file.content, start, end);
    } else {
      numberedContent = formatFileWithLineNumbers(file.content);
    }

    return {
      content: `Here's the content of ${MEMORIES_ROOT}/${normalized} with line numbers:\n${numberedContent}`,
    };
  }

  /** Handle create command */
  handleCreate(path: string, fileText: string): ToolResult {
    const normalized = normalizePath(path);

    if (normalized === '') {
      return {
        content: 'Error: Cannot create a file at the root path.',
        isError: true,
      };
    }

    if (this.fs.files[normalized]) {
      return {
        content: `Error: File ${MEMORIES_ROOT}/${normalized} already exists`,
        isError: true,
      };
    }

    const now = new Date().toISOString();
    const newFile: MemoryFile = {
      content: fileText,
      createdAt: now,
      updatedAt: now,
    };

    this.fs.files[normalized] = newFile;
    this.dirty = true;

    return {
      content: `File created successfully at: ${MEMORIES_ROOT}/${normalized}`,
    };
  }

  /** Handle str_replace command */
  handleStrReplace(path: string, oldStr: string, newStr: string): ToolResult {
    const normalized = normalizePath(path);

    if (normalized === '') {
      return {
        content: `Error: The path ${MEMORIES_ROOT} does not exist. Please provide a valid path.`,
        isError: true,
      };
    }

    const file = this.fs.files[normalized];
    if (!file) {
      return {
        content: `Error: The path ${MEMORIES_ROOT}/${normalized} does not exist. Please provide a valid path.`,
        isError: true,
      };
    }

    const occurrences = countOccurrences(file.content, oldStr);

    if (occurrences === 0) {
      return {
        content: `No replacement was performed, old_str \`${oldStr}\` did not appear verbatim in ${MEMORIES_ROOT}/${normalized}.`,
        isError: true,
      };
    }

    if (occurrences > 1) {
      const lineNumbers = findOccurrenceLines(file.content, oldStr);
      return {
        content: `No replacement was performed. Multiple occurrences of old_str \`${oldStr}\` in lines: ${lineNumbers.join(', ')}. Please ensure it is unique`,
        isError: true,
      };
    }

    // Find line number where replacement occurs
    const beforeReplace = file.content.substring(0, file.content.indexOf(oldStr));
    const editLine = beforeReplace.split('\n').length;

    // Replace first (and only) occurrence
    file.content = file.content.replace(oldStr, newStr);
    file.updatedAt = new Date().toISOString();
    this.dirty = true;

    const snippet = formatEditSnippet(file.content, editLine);

    return {
      content: `The memory file has been edited.\n${snippet}`,
    };
  }

  /** Handle insert command */
  handleInsert(path: string, insertLine: number, insertText: string): ToolResult {
    const normalized = normalizePath(path);

    if (normalized === '') {
      return {
        content: `Error: The path ${MEMORIES_ROOT} does not exist`,
        isError: true,
      };
    }

    const file = this.fs.files[normalized];
    if (!file) {
      return {
        content: `Error: The path ${MEMORIES_ROOT}/${normalized} does not exist`,
        isError: true,
      };
    }

    const lines = file.content.split('\n');
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
    file.content = lines.join('\n');
    file.updatedAt = new Date().toISOString();
    this.dirty = true;

    return {
      content: `The file ${MEMORIES_ROOT}/${normalized} has been edited.`,
    };
  }

  /** Handle delete command */
  handleDelete(path: string): ToolResult {
    const normalized = normalizePath(path);

    if (normalized === '') {
      return {
        content: `Error: The path ${MEMORIES_ROOT} does not exist`,
        isError: true,
      };
    }

    if (!this.fs.files[normalized]) {
      return {
        content: `Error: The path ${MEMORIES_ROOT}/${normalized} does not exist`,
        isError: true,
      };
    }

    delete this.fs.files[normalized];
    this.dirty = true;

    return {
      content: `Successfully deleted ${MEMORIES_ROOT}/${normalized}`,
    };
  }

  /** Handle rename command */
  handleRename(oldPath: string, newPath: string): ToolResult {
    const normalizedOld = normalizePath(oldPath);
    const normalizedNew = normalizePath(newPath);

    if (normalizedOld === '') {
      return {
        content: `Error: The path ${MEMORIES_ROOT} does not exist`,
        isError: true,
      };
    }

    const file = this.fs.files[normalizedOld];
    if (!file) {
      return {
        content: `Error: The path ${MEMORIES_ROOT}/${normalizedOld} does not exist`,
        isError: true,
      };
    }

    if (normalizedNew === '') {
      return {
        content: `Error: The destination ${MEMORIES_ROOT} already exists`,
        isError: true,
      };
    }

    if (this.fs.files[normalizedNew]) {
      return {
        content: `Error: The destination ${MEMORIES_ROOT}/${normalizedNew} already exists`,
        isError: true,
      };
    }

    // Move the file
    this.fs.files[normalizedNew] = file;
    delete this.fs.files[normalizedOld];
    this.dirty = true;

    return {
      content: `Successfully renamed ${MEMORIES_ROOT}/${normalizedOld} to ${MEMORIES_ROOT}/${normalizedNew}`,
    };
  }

  /** Execute a memory command */
  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const memoryInput = input as unknown as MemoryInput;
    let result: ToolResult;
    let isWriteOp = false;

    switch (memoryInput.command) {
      case 'view':
        result = this.handleView(memoryInput.path, memoryInput.view_range);
        break;
      case 'create':
        result = this.handleCreate(memoryInput.path, memoryInput.file_text);
        isWriteOp = true;
        break;
      case 'str_replace':
        result = this.handleStrReplace(memoryInput.path, memoryInput.old_str, memoryInput.new_str);
        isWriteOp = true;
        break;
      case 'insert':
        result = this.handleInsert(
          memoryInput.path,
          memoryInput.insert_line,
          memoryInput.insert_text
        );
        isWriteOp = true;
        break;
      case 'delete':
        result = this.handleDelete(memoryInput.path);
        isWriteOp = true;
        break;
      case 'rename':
        result = this.handleRename(memoryInput.old_path, memoryInput.new_path);
        isWriteOp = true;
        break;
      default:
        result = {
          content: `Unknown memory command: ${(memoryInput as { command: string }).command}`,
          isError: true,
        };
    }

    // Auto-save and journal after successful write operations
    if (this.dirty) {
      await this.save();
      // Log to journal only for successful writes (dirty flag was set)
      if (isWriteOp && !result.isError) {
        await saveJournalEntry(this.projectId, input);
      }
    }

    return result;
  }
}

// Active memory tool instances keyed by projectId
const instances = new Map<string, MemoryToolInstance>();

/**
 * Initialize memory tool for a project.
 * Loads existing memory from storage or creates empty filesystem.
 * Also registers the memory tool with the global toolRegistry.
 */
export async function initMemoryTool(projectId: string): Promise<MemoryToolInstance> {
  const existing = instances.get(projectId);
  if (existing) {
    return existing;
  }

  const fs = await loadMemory(projectId);
  const instance = new MemoryToolInstance(projectId, fs);
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
 * Create a ClientSideTool adapter for the memory tool.
 * The actual execution is delegated to the MemoryToolInstance.
 * Anthropic uses the memory_20250818 shorthand; other APIs use the full schema.
 */
export function createMemoryClientSideTool(projectId: string): ClientSideTool {
  return {
    name: 'memory',
    description:
      'Use this tool to store and retrieve information across conversations. Files persist per project.',
    iconInput: '🧠',
    iconOutput: '📝',
    renderInput: renderMemoryInput,
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
          description: 'Path to the file or directory',
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
      const instance = getMemoryTool(projectId);
      if (!instance) {
        return {
          content: 'Memory tool not initialized for this project',
          isError: true,
        };
      }
      return instance.execute(input);
    },
    // Anthropic uses shorthand type; other APIs get the full schema generated
    apiOverrides: {
      [APIType.ANTHROPIC]: {
        type: 'memory_20250818',
        name: 'memory',
      },
    },
  };
}
