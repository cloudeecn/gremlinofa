/**
 * JavaScript Execution Tool
 *
 * Client-side tool that executes JavaScript code in a sandboxed QuickJS environment.
 * Uses JsVMContext for VM management, event loop, and polyfills.
 *
 * Each tool call creates a fresh execution context. Library scripts from /lib are
 * loaded for each call, but their output is only shown on the first call in an
 * agentic loop (to avoid repetitive output).
 */

import type { ClientSideTool, ToolResult } from '../../types';
import { toolRegistry } from './clientSideTools';
import { JsVMContext, type ConsoleEntry } from './jsvm/JsVMContext';

/**
 * JavaScript execution tool instance.
 * Each execute() call creates a fresh context that loads polyfills and /lib scripts.
 */
class JsToolInstance {
  private projectId: string | null = null;
  private loadLib = true;
  private hasShownLibraryLogs = false;

  /**
   * Set the project ID for fs operations.
   */
  setProjectId(projectId: string): void {
    this.projectId = projectId;
  }

  /**
   * Set whether to load /lib scripts.
   */
  setLoadLib(loadLib: boolean): void {
    this.loadLib = loadLib;
  }

  /**
   * Reset library log state. Call at start of each agentic loop.
   * This allows library output to be shown on the first JS call in each loop.
   */
  resetLibraryLogState(): void {
    this.hasShownLibraryLogs = false;
  }

  /**
   * Execute JavaScript code in a fresh context.
   * Each call creates a new VM with polyfills and /lib scripts loaded.
   */
  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const code = input.code;
    if (!code || typeof code !== 'string') {
      return {
        content: 'Error: code parameter is required and must be a string',
        isError: true,
      };
    }

    // Create fresh context for this execution
    const vm = await JsVMContext.create(this.projectId ?? undefined, this.loadLib);

    try {
      // Wrap code in async IIFE so await works at top level and return value is captured
      const wrappedCode = `(async () => {"use strict"; ${code} })()`;
      const result = await vm.evaluate(wrappedCode);

      // Get library logs only if we haven't shown them yet in this agentic loop
      const libraryOutput = this.hasShownLibraryLogs ? [] : vm.getLibraryLogs();
      if (libraryOutput.length > 0) {
        this.hasShownLibraryLogs = true;
      }

      if (result.isError) {
        return {
          content: this.formatOutput(String(result.value), libraryOutput, result.consoleOutput),
          isError: true,
        };
      }

      return {
        content: this.formatOutput(
          this.stringify(result.value),
          libraryOutput,
          result.consoleOutput
        ),
      };
    } finally {
      vm.dispose();
    }
  }

  private stringify(value: unknown): string {
    if (value === undefined) return 'undefined';
    if (value === null) return 'null';
    if (typeof value === 'string') return value;
    if (typeof value === 'function') return '[Function]';
    if (value instanceof Error) {
      return value.stack ?? `${value.name}: ${value.message}`;
    }
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }

  private formatOutput(
    resultStr: string,
    libraryOutput: ConsoleEntry[],
    consoleOutput: ConsoleEntry[]
  ): string {
    const parts: string[] = [];
    let hasConsoleOutput = false;

    // Format a single console entry - omit level prefix if level is undefined
    const formatEntry = (entry: ConsoleEntry): string => {
      return entry.level ? `[${entry.level}] ${entry.message}` : entry.message;
    };

    if (libraryOutput.length) {
      hasConsoleOutput = true;
      for (const entry of libraryOutput) {
        parts.push(formatEntry(entry));
      }
    }

    if (consoleOutput.length) {
      hasConsoleOutput = true;
      parts.push('=== Console output ===');
      for (const entry of consoleOutput) {
        parts.push(formatEntry(entry));
      }
    }

    if (hasConsoleOutput) {
      parts.push('=== Result ===');
    }

    parts.push(resultStr ?? '(no output)');

    return parts.join('\n');
  }
}

// Singleton instance
let instance: JsToolInstance | null = null;

/**
 * Initialize JavaScript execution tool.
 * Registers the tool with the global toolRegistry.
 */
export function initJsTool(): void {
  if (instance) return;

  instance = new JsToolInstance();
  toolRegistry.register(createJsClientSideTool());
}

/**
 * Dispose JavaScript execution tool.
 * Unregisters from the global toolRegistry.
 */
export function disposeJsTool(): void {
  if (!instance) return;

  toolRegistry.unregister('javascript');
  instance = null;
}

/**
 * Check if JavaScript tool is initialized
 */
export function isJsToolInitialized(): boolean {
  return instance !== null;
}

/**
 * Configure the JS tool for the current agentic loop.
 * Call this at the start of each agentic loop before any tool calls.
 * @param projectId - Project ID to enable fs operations
 * @param loadLib - Whether to load /lib scripts (default: true)
 */
export function configureJsTool(projectId: string, loadLib = true): void {
  if (!instance) {
    throw new Error('JavaScript tool not initialized');
  }
  instance.setProjectId(projectId);
  instance.setLoadLib(loadLib);
  instance.resetLibraryLogState();
}

/** Render JS tool input - show code directly */
function renderJsInput(input: Record<string, unknown>): string {
  const code = input.code;
  if (typeof code === 'string') {
    return code;
  }
  return '';
}

/**
 * Create a ClientSideTool adapter for the JavaScript execution tool.
 */
function createJsClientSideTool(): ClientSideTool {
  return {
    name: 'javascript',
    description: `
Execute JavaScript in a QuickJS sandbox (ES2023). Code runs inside an async function body, so use \`return\` to output values and \`await\` is supported at top level.
  - Usage: calculations, data transformation, string/JSON processing, algorithm implementation, file operations.
  - Available APIs: ES2023 core, setTimeout, TextEncoder/TextDecoder, atob/btoa, console, Promise/async-await.
  - fs API (async only, use with await): fs.readFile, fs.writeFile, fs.exists, fs.mkdir, fs.readdir, fs.unlink, fs.rmdir, fs.rename, fs.stat.
    - readFile(path) returns ArrayBuffer (binary), readFile(path, 'utf-8') returns string.
    - writeFile(path, data) accepts string or ArrayBuffer for binary files.
    - stat() returns {isFile, isDirectory, size, readonly, mtime, isBinary, mime}.
    - Example: \`const data = await fs.readFile('/data.json', 'utf-8'); return JSON.parse(data);\`
    - Note: /memories is read-only.
  - Limitations: No fetch or DOM. setInterval runs once only. No ES modules.
  - Each call runs in a fresh context. Variables do NOT persist between calls. To persist data, use the fs API to write to files.
  - If /lib directory exists and contains .js files, they are pre-loaded as utilities (e.g., lodash UMD builds).
  - Output example: \`return 1 + 1\` → 2`,
    iconInput: '📜',
    renderInput: renderJsInput,
    inputSchema: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description: `
JavaScript code to execute. Use \`return\` to output values. Console output is also captured. Each call runs in isolated context - use fs API to persist data between calls.
Examples: 
  - \`return Math.sqrt(144) + 2 ** 10\` → 1036
  - \`return JSON.parse('{"a":1}').a\` → 1
  - \`return [1,2,3].map(x => x * 2)\` → [2,4,6]
  - \`return btoa('hello')\` → "aGVsbG8="
  - \`return {score: 5}\` → {score: 5}
  - \`await fs.writeFile('/cache.json', JSON.stringify({x: 1})); return 'saved';\``,
        },
      },
      required: ['code'],
    },
    execute: async (input: Record<string, unknown>): Promise<ToolResult> => {
      if (!instance) {
        return {
          content: 'JavaScript tool not initialized',
          isError: true,
        };
      }
      return instance.execute(input);
    },
  };
}
