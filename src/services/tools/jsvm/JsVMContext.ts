/**
 * JsVMContext - QuickJS context wrapper with event loop and polyfills
 *
 * Provides a browser-like JavaScript execution environment in QuickJS:
 * - Event loop via Promise-based setTimeout
 * - Promise/async-await support via executePendingJobs(1) per tick
 * - Common polyfills (TextEncoder, atob, etc.)
 * - Console output capture
 * - 60s execution timeout via interrupt handler
 */

import {
  newQuickJSWASMModuleFromVariant,
  type QuickJSWASMModule,
  type QuickJSContext,
  type QuickJSHandle,
} from 'quickjs-emscripten-core';
import variant from '@jitl/quickjs-ng-wasmfile-release-sync';
import { injectPolyfills } from './polyfills';
import { FsBridge } from './fsPolyfill';
import * as vfs from '../../vfs/vfsService';

export type ConsoleLevel = 'LOG' | 'WARN' | 'ERROR' | 'INFO' | 'DEBUG';

export interface ConsoleEntry {
  level?: ConsoleLevel;
  message: string;
}

export interface EvalResult {
  value: unknown;
  consoleOutput: ConsoleEntry[];
  isError: boolean;
}

const TIMEOUT_MS = 60_000;

// Module singleton - loaded once, reused across all contexts
let modulePromise: Promise<QuickJSWASMModule> | null = null;

async function getModule(): Promise<QuickJSWASMModule> {
  if (!modulePromise) {
    modulePromise = newQuickJSWASMModuleFromVariant(variant);
  }
  return modulePromise;
}

/**
 * QuickJS context wrapper with event loop support.
 *
 * Provides a browser-like execution environment where:
 * - async/await works via Promise job queue
 * - setTimeout queues via Promise.resolve().then()
 * - clearTimeout cancels pending callbacks
 * - 60s timeout enforced via interrupt handler
 */
export class JsVMContext {
  private context: QuickJSContext;
  private consoleOutput: ConsoleEntry[] = [];
  private libraryConsoleOutput: ConsoleEntry[] = [];
  private nextTimerId = 1;
  private cancelledTimers = new Set<number>();
  private pendingCallbacks = new Map<number, QuickJSHandle>();
  private fsBridge: FsBridge | null = null;

  private constructor(context: QuickJSContext) {
    this.context = context;
  }

  /**
   * Create a new JsVMContext with polyfills injected.
   * @param projectId - Optional project ID to enable fs operations
   * @param loadLib - Whether to load /lib scripts on session start (default: true)
   */
  static async create(projectId?: string, loadLib = true): Promise<JsVMContext> {
    const module = await getModule();
    const context = module.newContext();
    const vm = new JsVMContext(context);
    vm.setupConsole();
    vm.setupTimers();
    injectPolyfills(context);

    // Set up fs bridge if projectId provided
    if (projectId) {
      vm.fsBridge = new FsBridge(projectId, context);
      vm.fsBridge.injectFs();

      // Load and execute /lib scripts if enabled and the directory exists
      if (loadLib) {
        await vm.loadLibScripts(projectId);
      }
    }

    return vm;
  }

  /**
   * Load and execute all .js files in /lib directory.
   * Scripts are executed with their filename for better stack traces.
   * Console output during library loading is captured in libraryConsoleOutput.
   */
  private async loadLibScripts(projectId: string): Promise<void> {
    const libPath = '/lib';

    try {
      // Check if /lib directory exists
      const libExists = await vfs.isDirectory(projectId, libPath);
      if (!libExists) {
        return;
      }

      // List files in /lib (non-recursive)
      const entries = await vfs.readDir(projectId, libPath);

      // Filter for .js files and sort alphabetically for deterministic order
      const jsFiles = entries
        .filter(e => e.type === 'file' && e.name.endsWith('.js'))
        .sort((a, b) => a.name.localeCompare(b.name));

      if (jsFiles.length === 0) {
        return;
      }

      console.debug(
        '[JsVMContext] Loading lib scripts:',
        jsFiles.map(f => f.name)
      );

      // Temporarily swap consoleOutput to capture library logs separately
      const originalConsoleOutput = this.consoleOutput;

      try {
        // Execute each script with filename for stack traces
        for (const file of jsFiles) {
          const filePath = `${libPath}/${file.name}`;

          // Capture output for this specific library
          const libraryOutput: ConsoleEntry[] = [];
          this.consoleOutput = libraryOutput;

          try {
            const content = await vfs.readFile(projectId, filePath);

            // Use evalCode directly (not evaluate) to avoid resetting consoleOutput
            // and to have simpler error handling during init
            const result = this.context.evalCode(content, filePath, {
              type: 'global',
              backtraceBarrier: false,
            });

            if (result.error) {
              const errorValue = this.context.dump(result.error);
              result.error.dispose();
              console.error('[JsVMContext] Error loading', filePath, ':', errorValue);
            } else {
              result.value.dispose();
            }

            // Drain pending jobs and fs operations from this script
            const deadline = Date.now() + TIMEOUT_MS;
            while (
              this.context.runtime.hasPendingJob() ||
              (this.fsBridge && this.fsBridge.hasPendingOps())
            ) {
              // Drain fs operations first
              const fsError = await this.drainFsOperations(deadline);
              if (fsError) {
                console.error('[JsVMContext] FS error in', filePath, ':', fsError);
                break;
              }

              // Execute promise jobs
              while (this.context.runtime.hasPendingJob()) {
                const pendingResult = this.context.runtime.executePendingJobs(1);
                if (pendingResult.error) {
                  const errorValue = this.context.dump(pendingResult.error);
                  pendingResult.error.dispose();
                  console.error('[JsVMContext] Async error in', filePath, ':', errorValue);
                  break;
                }
              }

              // Check if we have more fs operations after promise jobs resolved
              if (!this.fsBridge || !this.fsBridge.hasPendingOps()) {
                break;
              }
            }

            // Only add header + output if this library produced console output
            if (libraryOutput.length > 0) {
              this.libraryConsoleOutput.push({
                message: `=== Output of library ${file.name} ===`,
              });
              this.libraryConsoleOutput.push(...libraryOutput);
            }
          } catch (error) {
            console.error('[JsVMContext] Failed to load', filePath, ':', error);
          }
        }
      } finally {
        // Restore original consoleOutput
        this.consoleOutput = originalConsoleOutput;
      }
    } catch {
      // /lib doesn't exist or can't be read - that's fine, it's optional
    }
  }

  /**
   * Evaluate JavaScript code and process the event loop.
   *
   * @param code - JavaScript code to execute
   * @param filename - Optional filename for stack traces
   * @returns Result with value, console output, and error flag
   */
  async evaluate(code: string, filename?: string): Promise<EvalResult> {
    // Clear state from previous eval
    this.consoleOutput = [];
    this.cancelledTimers.clear();

    // Set up 60s timeout via interrupt handler
    const deadline = Date.now() + TIMEOUT_MS;
    this.context.runtime.setInterruptHandler(() => Date.now() > deadline);

    try {
      const result = this.context.evalCode(code, filename, {
        type: 'global',
        backtraceBarrier: true,
      });

      if (result.error) {
        const errorValue = this.context.dump(result.error);
        result.error.dispose();

        const message = this.formatError(errorValue);
        return {
          value: message,
          consoleOutput: [...this.consoleOutput],
          isError: true,
        };
      }

      // Process pending jobs one at a time with browser yields
      const loopError = await this.drainPendingJobs(deadline);
      if (loopError) {
        result.value.dispose();
        return {
          value: loopError,
          consoleOutput: [...this.consoleOutput],
          isError: true,
        };
      }

      // Check if result is a promise and extract resolved/rejected value
      const promiseState = this.context.getPromiseState(result.value);

      if (promiseState.type === 'fulfilled') {
        // For non-promise values, notAPromise is true and value === result.value
        const value = this.context.dump(promiseState.value);
        if (!promiseState.notAPromise) {
          promiseState.value.dispose();
        }
        result.value.dispose();
        return {
          value,
          consoleOutput: [...this.consoleOutput],
          isError: false,
        };
      }

      if (promiseState.type === 'rejected') {
        const errorValue = this.context.dump(promiseState.error);
        promiseState.error.dispose();
        result.value.dispose();
        return {
          value: this.formatError(errorValue),
          consoleOutput: [...this.consoleOutput],
          isError: true,
        };
      }

      // promiseState.type === 'pending' - should not happen after draining jobs
      result.value.dispose();
      return {
        value: 'Error: Promise did not resolve within timeout',
        consoleOutput: [...this.consoleOutput],
        isError: true,
      };
    } catch (error) {
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      return {
        value: message,
        consoleOutput: [...this.consoleOutput],
        isError: true,
      };
    } finally {
      this.context.runtime.removeInterruptHandler();
    }
  }

  /**
   * Drain pending fs operations from the FsBridge.
   * Returns error message if something goes wrong, undefined on success.
   */
  private async drainFsOperations(deadline: number): Promise<string | undefined> {
    if (!this.fsBridge) return undefined;

    const fsOps = this.fsBridge.getPendingOps();
    for (const op of fsOps) {
      // Check timeout
      if (Date.now() > deadline) {
        return 'Error: Execution timeout (60s)';
      }

      try {
        const result = (await op.execute()) as { ok: boolean; value?: unknown; error?: string };
        const { handle, isError } = this.fsBridge.resultToHandle(result);
        if (isError) {
          op.reject(handle);
        } else {
          op.resolve(handle);
        }
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        const errHandle = this.context.newError(errMsg);
        op.reject(errHandle);
      }
    }
    return undefined;
  }

  /**
   * Process pending jobs one at a time, yielding to browser between each.
   * Also processes pending fs operations before each job execution.
   * Returns error message if something goes wrong, undefined on success.
   */
  private async drainPendingJobs(deadline: number): Promise<string | undefined> {
    // Keep looping while there are pending jobs OR pending fs operations
    while (
      this.context.runtime.hasPendingJob() ||
      (this.fsBridge && this.fsBridge.hasPendingOps())
    ) {
      // Check timeout
      if (Date.now() > deadline) {
        return 'Error: Execution timeout (60s)';
      }

      // Process pending fs operations first using helper
      const fsError = await this.drainFsOperations(deadline);
      if (fsError) {
        return fsError;
      }

      // Yield to browser
      await new Promise(resolve => globalThis.setTimeout(resolve, 0));

      // Execute one pending job if there are any
      if (this.context.runtime.hasPendingJob()) {
        const pendingResult = this.context.runtime.executePendingJobs(1);
        if (pendingResult.error) {
          const errorValue = this.context.dump(pendingResult.error);
          pendingResult.error.dispose();
          return this.formatError(errorValue);
        }
      }
    }
    return undefined;
  }

  /**
   * Dispose the context and release resources.
   */
  dispose(): void {
    // Dispose any pending callback handles that haven't run yet
    for (const handle of this.pendingCallbacks.values()) {
      handle.dispose();
    }
    this.pendingCallbacks.clear();
    this.cancelledTimers.clear();
    this.context.dispose();
  }

  /**
   * Get the underlying QuickJS context for advanced operations.
   */
  getContext(): QuickJSContext {
    return this.context;
  }

  /**
   * Get library console logs captured during /lib script loading.
   */
  getLibraryLogs(): ConsoleEntry[] {
    return [...this.libraryConsoleOutput];
  }

  /**
   * Clear library console logs (called after flushing to first tool call).
   */
  clearLibraryLogs(): void {
    this.libraryConsoleOutput = [];
  }

  /**
   * Set up console object for capturing output.
   */
  private setupConsole(): void {
    const consoleHandle = this.context.newObject();

    const createMethod = (level: ConsoleLevel) => {
      return this.context.newFunction(level.toLowerCase(), (...args: QuickJSHandle[]) => {
        const message = args.map(arg => this.stringify(this.context.dump(arg))).join(' ');
        this.consoleOutput.push({ level, message });
      });
    };

    const levels: ConsoleLevel[] = ['LOG', 'WARN', 'ERROR', 'INFO', 'DEBUG'];
    for (const level of levels) {
      const methodHandle = createMethod(level);
      this.context.setProp(consoleHandle, level.toLowerCase(), methodHandle);
      methodHandle.dispose();
    }

    this.context.setProp(this.context.global, 'console', consoleHandle);
    consoleHandle.dispose();
  }

  /**
   * Set up setTimeout/clearTimeout using Promise-based approach.
   * setTimeout queues callback via Promise.resolve().then()
   * clearTimeout marks timer ID as cancelled
   */
  private setupTimers(): void {
    // Helper to create wrapper that checks cancellation
    const createTimeoutWrapper = this.context.newFunction(
      '__createTimeoutWrapper',
      (callbackHandle: QuickJSHandle, idHandle: QuickJSHandle) => {
        const id = this.context.getNumber(idHandle);
        const callback = callbackHandle.dup();

        // Track the callback handle for cleanup on dispose
        this.pendingCallbacks.set(id, callback);

        // Return a new function that checks cancellation before calling
        return this.context.newFunction('__timeoutWrapper', () => {
          // Remove from pending (we're about to handle it)
          this.pendingCallbacks.delete(id);

          try {
            if (!this.cancelledTimers.has(id)) {
              this.context.callFunction(callback, this.context.undefined);
            }
            this.cancelledTimers.delete(id);
          } finally {
            callback.dispose();
          }
        });
      }
    );
    this.context.setProp(this.context.global, '__createTimeoutWrapper', createTimeoutWrapper);
    createTimeoutWrapper.dispose();

    // setTimeout implementation in JS using Promise.resolve().then()
    const setTimeoutCode = `
      (function() {
        let __nextTimerId = 1;
        globalThis.setTimeout = function(callback, delay) {
          const id = __nextTimerId++;
          const wrapper = __createTimeoutWrapper(callback, id);
          Promise.resolve().then(wrapper);
          return id;
        };
      })();
    `;
    this.context.evalCode(setTimeoutCode);

    // clearTimeout - just marks the ID as cancelled (host-side)
    const clearTimeoutFn = this.context.newFunction('clearTimeout', (idHandle: QuickJSHandle) => {
      const id = this.context.getNumber(idHandle);
      this.cancelledTimers.add(id);
    });
    this.context.setProp(this.context.global, 'clearTimeout', clearTimeoutFn);
    clearTimeoutFn.dispose();

    // setInterval stub - returns ID but doesn't actually repeat
    const setIntervalFn = this.context.newFunction(
      'setInterval',
      (callbackHandle: QuickJSHandle, _delayHandle?: QuickJSHandle) => {
        // Just do one setTimeout, no repeat
        const id = this.nextTimerId++;
        const callback = callbackHandle.dup();
        const wrapper = this.context.newFunction('__intervalWrapper', () => {
          try {
            if (!this.cancelledTimers.has(id)) {
              this.context.callFunction(callback, this.context.undefined);
            }
            this.cancelledTimers.delete(id);
          } finally {
            callback.dispose();
          }
        });

        // Queue via Promise
        const promiseCode = `Promise.resolve().then`;
        const thenResult = this.context.evalCode(promiseCode);
        if (!thenResult.error) {
          this.context.callFunction(thenResult.value, this.context.undefined, wrapper);
          thenResult.value.dispose();
        }
        wrapper.dispose();

        return this.context.newNumber(id);
      }
    );
    this.context.setProp(this.context.global, 'setInterval', setIntervalFn);
    setIntervalFn.dispose();

    // clearInterval - same as clearTimeout
    const clearIntervalFn = this.context.newFunction('clearInterval', (idHandle: QuickJSHandle) => {
      const id = this.context.getNumber(idHandle);
      this.cancelledTimers.add(id);
    });
    this.context.setProp(this.context.global, 'clearInterval', clearIntervalFn);
    clearIntervalFn.dispose();
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

  private formatError(errorValue: unknown): string {
    if (typeof errorValue === 'object' && errorValue !== null) {
      const err = errorValue as Record<string, unknown>;
      if (err.message === 'interrupted') {
        return 'Error: Execution timeout (60s)';
      }
      const base = `${err.name || 'Error'}: ${err.message || String(errorValue)}`;
      const stack = typeof err.stack === 'string' ? `\n${err.stack}` : '';
      return `${base}${stack}`;
    }
    return String(errorValue);
  }
}
