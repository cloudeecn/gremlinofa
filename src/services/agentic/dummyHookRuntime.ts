/**
 * DUMMY System Hook Runtime
 *
 * Loads and executes hook files from VFS in a QuickJS sandbox.
 * Each hook file must return a function(lastMessage, iteration) that
 * returns undefined (passthrough), "user" (stop loop), or a synthetic response object.
 */

import { JsVMContext } from '../tools/jsvm/JsVMContext';
import * as vfs from '../vfs';
import type { DummyHookResult } from './agenticLoopGenerator';

/** Condensed representation of a single message for hook history */
export interface HookInputMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text?: string;
  toolCalls?: { id: string; name: string; input: Record<string, unknown> }[];
  toolResults?: {
    tool_use_id: string;
    name: string;
    content: string;
    is_error?: boolean;
  }[];
}

/** Model-agnostic representation of the last message, passed to hook functions */
export interface HookInput {
  chatId?: string;
  messageId?: string;
  text?: string;
  toolResults?: {
    tool_use_id: string;
    name: string;
    content: string;
    is_error?: boolean;
  }[];
  history?: HookInputMessage[];
}

/** Result from run() — wraps the hook result with error info for status reporting */
export interface DummyHookRunResult {
  value: DummyHookResult;
  /** Non-null when the hook threw or returned an error */
  error?: string;
}

export class DummyHookRuntime {
  private vm: JsVMContext;
  private hookFnCode: string;

  private constructor(vm: JsVMContext, hookFnCode: string) {
    this.vm = vm;
    this.hookFnCode = hookFnCode;
  }

  /**
   * Load a hook from VFS. Returns null if the hook file doesn't exist.
   */
  static async load(
    projectId: string,
    namespace: string | undefined,
    hookName: string
  ): Promise<DummyHookRuntime | null> {
    const hookPath = `/hooks/${hookName}.js`;

    // Check if hook file exists
    try {
      const content = await vfs.readFile(projectId, hookPath, namespace);
      if (!content) return null;

      // Create VM without lib loading — hooks are self-contained
      const vm = await JsVMContext.create(projectId, false, namespace, false);

      return new DummyHookRuntime(vm, content);
    } catch {
      // File doesn't exist or VFS error — skip silently
      return null;
    }
  }

  /**
   * Run the hook function with the given input.
   * Returns the hook result plus any error info for status reporting.
   * On error, value is undefined (passthrough) and error contains the message.
   */
  async run(hookInput: HookInput, iteration: number): Promise<DummyHookRunResult> {
    try {
      // Wrap the hook code in async IIFEs so hooks can use async functions and top-level await
      const wrappedCode = `
        (async function() {
          var __hookFn = await (async function() {
            ${this.hookFnCode}
          })();
          if (typeof __hookFn !== 'function') {
            throw new Error('Hook file must return a function');
          }
          return __hookFn(${JSON.stringify(hookInput)}, ${iteration});
        })()
      `;

      const result = await this.vm.evaluate(wrappedCode, 'hook');

      if (result.isError) {
        const errMsg = String(result.value ?? 'Unknown hook error');
        console.error('[dummyHookRuntime] Hook error:', errMsg);
        return { value: undefined, error: errMsg };
      }

      const value = result.value;

      // undefined → passthrough
      if (value === undefined || value === null) {
        return { value: undefined };
      }

      // "user" → stop loop
      if (value === 'user') {
        return { value: 'user' };
      }

      // Object → synthetic response
      if (typeof value === 'object' && value !== null && 'text' in value) {
        const obj = value as Record<string, unknown>;
        return {
          value: {
            text: String(obj.text ?? ''),
            toolCalls: Array.isArray(obj.toolCalls)
              ? obj.toolCalls.map((tc: Record<string, unknown>) => ({
                  id: tc.id ? String(tc.id) : undefined,
                  name: String(tc.name ?? ''),
                  input: (tc.input as Record<string, unknown>) ?? {},
                }))
              : undefined,
            brief: obj.brief ? String(obj.brief) : undefined,
          },
        };
      }

      const errMsg = `Unexpected hook return type: ${typeof value}`;
      console.error('[dummyHookRuntime]', errMsg);
      return { value: undefined, error: errMsg };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error('[dummyHookRuntime] Hook execution failed:', errMsg);
      return { value: undefined, error: errMsg };
    }
  }

  /**
   * Dispose the QuickJS context. Call when the agentic loop ends.
   */
  dispose(): void {
    this.vm.dispose();
  }
}
