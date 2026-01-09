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

export type ConsoleLevel = 'LOG' | 'WARN' | 'ERROR' | 'INFO' | 'DEBUG';

export interface ConsoleEntry {
  level: ConsoleLevel;
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
  private nextTimerId = 1;
  private cancelledTimers = new Set<number>();
  private pendingCallbacks = new Map<number, QuickJSHandle>();

  private constructor(context: QuickJSContext) {
    this.context = context;
  }

  /**
   * Create a new JsVMContext with polyfills injected.
   */
  static async create(): Promise<JsVMContext> {
    const module = await getModule();
    const context = module.newContext();
    const vm = new JsVMContext(context);
    vm.setupConsole();
    vm.setupTimers();
    injectPolyfills(context);
    return vm;
  }

  /**
   * Evaluate JavaScript code and process the event loop.
   *
   * @param code - JavaScript code to execute
   * @returns Result with value, console output, and error flag
   */
  async evaluate(code: string): Promise<EvalResult> {
    // Clear state from previous eval
    this.consoleOutput = [];
    this.cancelledTimers.clear();

    // Set up 60s timeout via interrupt handler
    const deadline = Date.now() + TIMEOUT_MS;
    this.context.runtime.setInterruptHandler(() => Date.now() > deadline);

    try {
      const result = this.context.evalCode(code, undefined, {
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
   * Process pending jobs one at a time, yielding to browser between each.
   * Returns error message if something goes wrong, undefined on success.
   */
  private async drainPendingJobs(deadline: number): Promise<string | undefined> {
    while (this.context.runtime.hasPendingJob()) {
      // Check timeout
      if (Date.now() > deadline) {
        return 'Error: Execution timeout (60s)';
      }

      // Yield to browser
      await new Promise(resolve => globalThis.setTimeout(resolve, 0));

      // Execute one pending job
      const pendingResult = this.context.runtime.executePendingJobs(1);
      if (pendingResult.error) {
        const errorValue = this.context.dump(pendingResult.error);
        pendingResult.error.dispose();
        return this.formatError(errorValue);
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
