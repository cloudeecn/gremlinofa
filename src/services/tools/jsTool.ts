/**
 * JavaScript Execution Tool
 *
 * Client-side tool that executes JavaScript code in a sandboxed QuickJS environment.
 * Uses @sebastianwessel/quickjs with @jitl/quickjs-singlefile-browser-release-sync variant.
 */

import { loadQuickJs, type SandboxOptions } from '@sebastianwessel/quickjs';
import variant from '@jitl/quickjs-singlefile-browser-release-sync';
import type { ClientSideTool, ToolResult } from '../../types';
import { toolRegistry } from './clientSideTools';

const DEFAULT_TIMEOUT_MS = 5000;

type ConsoleLevel = 'LOG' | 'WARN' | 'ERROR' | 'INFO' | 'DEBUG';

interface ConsoleEntry {
  level: ConsoleLevel;
  message: string;
}

/**
 * JavaScript execution tool instance.
 */
class JsToolInstance {
  private consoleOutput: ConsoleEntry[] = [];

  /**
   * Execute JavaScript code in sandbox
   */
  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const code = input.code;
    const timeoutMs = input.timeout_ms;

    if (!code || typeof code !== 'string') {
      return {
        content: 'Error: code parameter is required and must be a string',
        isError: true,
      };
    }

    const timeout = typeof timeoutMs === 'number' ? timeoutMs : DEFAULT_TIMEOUT_MS;
    this.consoleOutput = [];

    try {
      const { runSandboxed } = await loadQuickJs(variant);

      const options: SandboxOptions = {
        executionTimeout: timeout,
        allowFs: true,
        console: {
          log: (...args: unknown[]) => this.captureConsole('LOG', args),
          warn: (...args: unknown[]) => this.captureConsole('WARN', args),
          error: (...args: unknown[]) => this.captureConsole('ERROR', args),
          info: (...args: unknown[]) => this.captureConsole('INFO', args),
          debug: (...args: unknown[]) => this.captureConsole('DEBUG', args),
        },
      };

      const result = await runSandboxed(async ({ evalCode }) => evalCode(code), options);

      if (result.ok) {
        return this.formatResult(result.data);
      } else {
        return {
          content: this.formatOutput(`Error: ${result.error}`),
          isError: true,
        };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: this.formatOutput(`Error: ${message}`),
        isError: true,
      };
    }
  }

  private captureConsole(level: ConsoleLevel, args: unknown[]): void {
    const message = args.map(arg => this.stringify(arg)).join(' ');
    this.consoleOutput.push({ level, message });
  }

  private stringify(value: unknown): string {
    if (value === undefined) return 'undefined';
    if (value === null) return 'null';
    if (typeof value === 'string') return value;
    if (typeof value === 'function') return '[Function]';
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }

  private formatResult(result: unknown): ToolResult {
    const resultStr = this.stringify(result);
    return {
      content: this.formatOutput(resultStr),
    };
  }

  private formatOutput(resultStr: string): string {
    const parts: string[] = [];

    // Console output with level prefixes
    if (this.consoleOutput.length > 0) {
      for (const entry of this.consoleOutput) {
        parts.push(`[${entry.level}] ${entry.message}`);
      }
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

// Singleton instance (stateless, can be shared)
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

/** Render JS tool input - show code directly */
function renderJsInput(input: Record<string, unknown>): string {
  const code = input.code;
  const timeout = input.timeout_ms;

  const lines: string[] = [];
  if (typeof code === 'string') {
    lines.push(code);
  }
  if (typeof timeout === 'number' && timeout !== 5000) {
    lines.push(`\n[timeout: ${timeout}ms]`);
  }
  return lines.join('');
}

/**
 * Create a ClientSideTool adapter for the JavaScript execution tool.
 */
function createJsClientSideTool(): ClientSideTool {
  return {
    name: 'javascript',
    description:
      'Execute JavaScript code in a secure sandbox. Returns console output and default export as result. Use for calculations, data transformations, or algorithm demonstrations.',
    iconInput: '📜',
    iconOutput: '⚡',
    renderInput: renderJsInput,
    inputSchema: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description:
            'JavaScript code to execute. Use export default to return result. For example: `const result = 1 + 1; export default result`',
        },
        timeout_ms: {
          type: 'number',
          description: 'Execution timeout in milliseconds (default: 5000)',
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
