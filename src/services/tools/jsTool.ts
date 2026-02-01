/**
 * JavaScript Execution Tool
 *
 * Client-side tool that executes JavaScript code in a sandboxed QuickJS environment.
 * Uses JsVMContext for VM management, event loop, and polyfills.
 *
 * Each tool call creates a fresh execution context. Library scripts from /lib are
 * loaded and their output is always shown (no first-call tracking).
 *
 * This is a stateless tool - all state is passed via toolOptions and context.
 */

import type { ClientSideTool, ToolContext, ToolOptions, ToolResult } from '../../types';
import { JsVMContext, type ConsoleEntry } from './jsvm/JsVMContext';

/**
 * Stringify a value for output
 */
function stringify(value: unknown): string {
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

/**
 * Format output with optional library logs, console output, and result
 */
function formatOutput(
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

/**
 * Execute JavaScript code in a fresh QuickJS context.
 */
async function executeJavaScript(
  input: Record<string, unknown>,
  toolOptions?: ToolOptions,
  context?: ToolContext
): Promise<ToolResult> {
  const code = input.code;
  if (!code || typeof code !== 'string') {
    return {
      content: 'Error: code parameter is required and must be a string',
      isError: true,
    };
  }

  if (!context?.projectId) {
    return {
      content: 'Error: projectId is required in context',
      isError: true,
    };
  }

  // Get loadLib option (UI initializes to true when tool is enabled)
  const loadLib = toolOptions?.loadLib ?? false;

  // Create fresh context for this execution
  const vm = await JsVMContext.create(context.projectId, loadLib);

  try {
    // Wrap code in async IIFE so await works at top level and return value is captured
    const wrappedCode = `(async () => {"use strict"; ${code} })()`;
    const result = await vm.evaluate(wrappedCode);

    // Always show library output (no first-call tracking)
    const libraryOutput = vm.getLibraryLogs();

    if (result.isError) {
      return {
        content: formatOutput(String(result.value), libraryOutput, result.consoleOutput),
        isError: true,
      };
    }

    return {
      content: formatOutput(stringify(result.value), libraryOutput, result.consoleOutput),
    };
  } finally {
    vm.dispose();
  }
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
 * JavaScript execution tool definition.
 * Stateless - all configuration passed via toolOptions and context.
 */
export const jsTool: ClientSideTool = {
  name: 'javascript',
  displayName: 'JavaScript Execution',
  displaySubtitle: 'Execute code in a secure sandbox in your browser',
  optionDefinitions: [
    {
      id: 'loadLib',
      label: 'Load /lib Scripts',
      subtitle: 'Auto-load .js files from /lib when JS session starts',
      default: true,
    },
  ],
  description: `
Execute JavaScript in a QuickJS sandbox (ES2023). Code runs inside an async function body, so use \`return\` to output values and \`await\` is supported at top level.
  - Usage: calculations, data transformation, string/JSON processing, algorithm implementation, file operations.
  - Available APIs: ES2023 core, setTimeout, TextEncoder/TextDecoder, atob/btoa, console, Promise/async-await, halt.
  - fs API (async only, use with await): fs.readFile, fs.writeFile, fs.exists, fs.mkdir, fs.readdir, fs.unlink, fs.rmdir, fs.rename, fs.stat.
    - readFile(path) returns ArrayBuffer (binary), readFile(path, 'utf-8') returns string.
    - writeFile(path, data) accepts string or ArrayBuffer for binary files.
    - stat() returns {isFile, isDirectory, size, readonly, mtime, isBinary, mime}.
    - Example: \`const data = await fs.readFile('/data.json', 'utf-8'); return JSON.parse(data);\`
    - Note: /memories is read-only.
  - halt(message): Immediately stops execution and outputs message at ERROR level.
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
  execute: executeJavaScript,
};
