/**
 * JavaScript Execution Tool
 *
 * Client-side tool that executes JavaScript code in a sandboxed QuickJS environment.
 * Uses quickjs-emscripten-core with @jitl/quickjs-singlefile-browser-release-sync variant.
 *
 * VM state persists across multiple tool calls within an agentic loop, enabling
 * the AI to build up state across calls (e.g., define variables, then use them later).
 */

import {
  newQuickJSWASMModuleFromVariant,
  type QuickJSWASMModule,
  type QuickJSContext,
  type QuickJSHandle,
} from 'quickjs-emscripten-core';
import variant from '@jitl/quickjs-ng-wasmfile-release-sync';
import type { ClientSideTool, ToolResult } from '../../types';
import { toolRegistry } from './clientSideTools';

type ConsoleLevel = 'LOG' | 'WARN' | 'ERROR' | 'INFO' | 'DEBUG';

interface ConsoleEntry {
  level: ConsoleLevel;
  message: string;
}

// Module singleton - loaded once, reused
let modulePromise: Promise<QuickJSWASMModule> | null = null;

async function getModule(): Promise<QuickJSWASMModule> {
  if (!modulePromise) {
    modulePromise = newQuickJSWASMModuleFromVariant(variant);
  }
  return modulePromise;
}

/**
 * JavaScript execution tool instance.
 * VM state persists across multiple tool calls within a session.
 */
class JsToolInstance {
  private session: QuickJSContext | null = null;

  /**
   * Create a persistent session for the agentic loop.
   * Variables and state persist across multiple execute calls.
   * @returns The created context
   */
  async createSession(): Promise<QuickJSContext> {
    if (this.session) {
      console.debug('[JsTool] Session already exists, disposing old one');
      this.disposeSession();
    }

    const module = await getModule();
    this.session = module.newContext();
    console.debug('[JsTool] Session created');
    return this.session;
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
    const context = ephemeral
      ? (await getModule()).newContext()
      : (this.session ?? (await this.createSession()));

    const consoleOutput: ConsoleEntry[] = [];
    this.setupConsole(context, consoleOutput);

    try {
      return this.runCode(context, code, consoleOutput);
    } finally {
      if (ephemeral) {
        context.dispose();
      }
    }
  }

  /**
   * Core code execution logic shared between session and ephemeral modes.
   */
  private runCode(
    context: QuickJSContext,
    code: string,
    consoleOutput: ConsoleEntry[]
  ): ToolResult {
    try {
      const result = context.evalCode(code);

      if (result.error) {
        const errorHandle = result.error;
        const errorValue = context.dump(errorHandle);
        errorHandle.dispose();

        const message =
          typeof errorValue === 'object' && errorValue !== null
            ? `${errorValue.name || 'Error'}: ${errorValue.message || String(errorValue)}`
            : String(errorValue);

        return {
          content: this.formatOutput('Error: ' + message, consoleOutput),
          isError: true,
        };
      }

      const valueHandle = result.value;
      const value = context.dump(valueHandle);
      valueHandle.dispose();

      return {
        content: this.formatOutput(this.stringify(value), consoleOutput),
      };
    } catch (error) {
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      return {
        content: this.formatOutput(`Error: ${message}`, consoleOutput),
        isError: true,
      };
    }
  }

  /**
   * Set up console object in a context for capturing output.
   */
  private setupConsole(context: QuickJSContext, consoleOutput: ConsoleEntry[]): void {
    const consoleHandle = context.newObject();

    const createConsoleMethod = (level: ConsoleLevel) => {
      return context.newFunction(level.toLowerCase(), (...args: QuickJSHandle[]) => {
        const message = args.map(arg => this.stringify(context.dump(arg))).join(' ');
        consoleOutput.push({ level, message });
      });
    };

    const methods: ConsoleLevel[] = ['LOG', 'WARN', 'ERROR', 'INFO', 'DEBUG'];
    for (const level of methods) {
      const methodHandle = createConsoleMethod(level);
      context.setProp(consoleHandle, level.toLowerCase(), methodHandle);
      methodHandle.dispose();
    }

    context.setProp(context.global, 'console', consoleHandle);
    consoleHandle.dispose();
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
 */
export async function createJsSession(): Promise<void> {
  if (!instance) {
    throw new Error('JavaScript tool not initialized');
  }
  await instance.createSession();
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
  - Useage examples: calculations, data transformation, string manipulation, JSON processing, algorithm implementation, date manipulation.
  - Limitations: No browser APIs (fetch, DOM, setTimeout), no network or file access. 
  - Session state persists across tool calls within the same conversation turn, allowing you to build up state across multiple calls.
  - Output example: \`console.log("test"); const result = 1 + 1; result\`, or just \`console.log("test"); 1 + 1\` → 
    [LOG] test
    === Result ===
    2`,
    iconInput: '📜',
    iconOutput: '⚡',
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
  - \`JSON.parse('{"a":1}').a\` → 1,
  - \`[1,2,3].map(x => x * 2)\` → [2,4,6]
Note: if you want to return an object literal, it must be wrapped by parentheses, for example:
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
