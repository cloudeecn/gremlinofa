/**
 * JavaScript Execution Tool
 *
 * Client-side tool that executes JavaScript code in a sandboxed QuickJS environment.
 * Uses JsVMContext for VM management, event loop, and polyfills.
 *
 * VM state persists across multiple tool calls within an agentic loop, enabling
 * the AI to build up state across calls (e.g., define variables, then use them later).
 */

import type { ClientSideTool, ToolResult } from '../../types';
import { toolRegistry } from './clientSideTools';
import { JsVMContext, type ConsoleEntry } from './jsvm/JsVMContext';

/**
 * JavaScript execution tool instance.
 * VM state persists across multiple tool calls within a session.
 */
class JsToolInstance {
  private session: JsVMContext | null = null;
  private projectId: string | null = null;

  /**
   * Set the project ID for fs operations.
   */
  setProjectId(projectId: string): void {
    this.projectId = projectId;
  }

  /**
   * Create a persistent session for the agentic loop.
   * Variables and state persist across multiple execute calls.
   * @param loadLib - Whether to load /lib scripts on session start (default: true)
   */
  async createSession(loadLib = true): Promise<void> {
    if (this.session) {
      console.debug('[JsTool] Session already exists, disposing old one');
      this.disposeSession();
    }

    // Pass projectId to enable fs operations and loadLib option
    this.session = await JsVMContext.create(this.projectId ?? undefined, loadLib);
    console.debug('[JsTool] Session created', this.projectId ? 'with fs' : 'without fs');
  }

  /**
   * Check if a session is active.
   */
  hasSession(): boolean {
    return this.session !== null;
  }

  /**
   * Dispose the current session.
   */
  disposeSession(): void {
    if (this.session) {
      this.session.dispose();
      this.session = null;
      console.debug('[JsTool] Session disposed');
    }
  }

  /**
   * Execute JavaScript code.
   * @param input.ephemeral - If true, execute in isolated context without affecting session
   */
  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const code = input.code;
    if (!code || typeof code !== 'string') {
      return {
        content: 'Error: code parameter is required and must be a string',
        isError: true,
      };
    }

    const ephemeral = !!input.ephemeral;

    // Get or create context
    let vm: JsVMContext;
    let shouldDispose = false;

    if (ephemeral) {
      vm = await JsVMContext.create();
      shouldDispose = true;
    } else {
      if (!this.session) {
        await this.createSession();
      }
      vm = this.session!;
    }

    try {
      const result = await vm.evaluate(code);

      if (result.isError) {
        return {
          content: this.formatOutput(String(result.value), result.consoleOutput),
          isError: true,
        };
      }

      return {
        content: this.formatOutput(this.stringify(result.value), result.consoleOutput),
      };
    } finally {
      if (shouldDispose) {
        vm.dispose();
      }
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

  private formatOutput(resultStr: string, consoleOutput: ConsoleEntry[]): string {
    const parts: string[] = [];

    // Console output with level prefixes
    for (const entry of consoleOutput) {
      parts.push(`[${entry.level}] ${entry.message}`);
    }

    // Result section
    if (resultStr !== 'undefined') {
      if (parts.length > 0) {
        parts.push('=== Result ===');
      }
      parts.push(resultStr);
    } else if (parts.length === 0) {
      parts.push('(no output)');
    }

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

  instance.disposeSession();
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
 * Create a persistent JS session for the agentic loop.
 * State persists across multiple tool calls until disposeJsSession is called.
 * @param projectId - Project ID to enable fs operations (optional)
 * @param loadLib - Whether to load /lib scripts on session start (default: true)
 */
export async function createJsSession(projectId?: string, loadLib = true): Promise<void> {
  if (!instance) {
    throw new Error('JavaScript tool not initialized');
  }
  if (projectId) {
    instance.setProjectId(projectId);
  }
  await instance.createSession(loadLib);
}

/**
 * Check if a JS session is active.
 */
export function hasJsSession(): boolean {
  return instance?.hasSession() ?? false;
}

/**
 * Dispose the current JS session.
 * Call this when the agentic loop completes.
 */
export function disposeJsSession(): void {
  instance?.disposeSession();
}

/** Render JS tool input - show code directly */
function renderJsInput(input: Record<string, unknown>): string {
  const code = input.code;
  const ephemeral = input.ephemeral;

  const lines: string[] = [];
  if (typeof code === 'string') {
    lines.push(code);
  }
  if (ephemeral) {
    lines.push('\n[ephemeral]');
  }
  return lines.join('');
}

/**
 * Create a ClientSideTool adapter for the JavaScript execution tool.
 */
function createJsClientSideTool(): ClientSideTool {
  return {
    name: 'javascript',
    description: `
Execute JavaScript in a QuickJS sandbox (ES2023). Returns console output and the final expression value. 
  - Usage: calculations, data transformation, string/JSON processing, algorithm implementation, file operations.
  - Available APIs: ES2023 core, setTimeout, TextEncoder/TextDecoder, atob/btoa, console, Promise/async-await.
  - fs API (async only, use with await): readFile, writeFile, exists, mkdir, readdir, unlink, rmdir, rename, stat.
    - Example: \`await fs.writeFile('/data/result.txt', JSON.stringify(data))\`
    - Note: /memories is read-only. stat() returns {isFile, isDirectory, size, readonly, mtime}.
  - Limitations: No fetch or DOM. setInterval runs once only. No ES modules.
  - JS context persists across tool calls within same turn (unless 'ephemeral' is true).
    - Beware const name conflicts and variable pollution; use ephemeral mode if needed.
  - The sandbox is running in global mode, root level await is not supported. you can use the \`async function fun(){/*await here*/}; fun();\` pattern. The return value will get resolved automatically.
  - Output example: \`1 + 1\` → 2`,
    iconInput: '📜',
    renderInput: renderJsInput,
    inputSchema: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description: `
JavaScript code to execute. Console output and the value of the last expression will be returned.
Examples: 
  - \`Math.sqrt(144) + 2 ** 10\` → 1036
  - \`JSON.parse('{"a":1}').a\` → 1
  - \`[1,2,3].map(x => x * 2)\` → [2,4,6]
  - \`btoa('hello')\` → "aGVsbG8="
  - \`new TextEncoder().encode('hi')\` → Uint8Array [104, 105]
Note: object literals must be wrapped in parentheses:
  - \`{score: 5}\` → SyntaxError
  - \`({score: 5})\` → {score: 5}`,
        },
        ephemeral: {
          type: 'boolean',
          description:
            'Execute in an isolated context without affecting the persistent session. Useful for one-off calculations that should not pollute session state.',
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
