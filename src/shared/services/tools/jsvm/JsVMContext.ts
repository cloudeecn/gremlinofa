/**
 * JsVMContext - QuickJS context wrapper with event loop and polyfills
 *
 * Provides a browser-like JavaScript execution environment in QuickJS:
 * - Event loop that drains microtasks, then fires host-scheduled timers
 * - setTimeout/setInterval honor real delays (bounded by the 300s cap)
 * - Promise/async-await support via executePendingJobs(1) per tick
 * - Common polyfills (TextEncoder, atob, etc.)
 * - Console output capture
 * - 300s execution timeout via interrupt handler
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
import type { VfsAdapter } from '../../vfs/vfsAdapter';

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

const TIMEOUT_MS = 300_000;

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
 * - setTimeout/setInterval register host-side timers honoring real delays
 * - clearTimeout cancels pending timers
 * - 300s timeout enforced via interrupt handler
 */
export class JsVMContext {
  private context: QuickJSContext;
  private consoleOutput: ConsoleEntry[] = [];
  private libraryConsoleOutput: ConsoleEntry[] = [];
  private nextTimerId = 1;
  private timerSeq = 0;
  /** Host-side timer registry. Each entry holds the VM callback handle and its
   *  absolute wake time; the drain loop sleeps until the earliest one is due. */
  private timers = new Map<number, { callback: QuickJSHandle; wakeAt: number; seq: number }>();
  private fsBridge: FsBridge | null = null;
  private isHalted = false;
  private haltMessage = '';
  private haltConsoleSnapshot: ConsoleEntry[] = [];

  private constructor(context: QuickJSContext) {
    this.context = context;
  }

  /**
   * Create a new JsVMContext with polyfills injected.
   * @param adapter - Optional VfsAdapter to enable fs operations
   * @param loadLib - Whether to load /lib scripts on session start (default: true)
   * @param loadShareLib - Whether to load /share/lib scripts (default: true)
   */
  static async create(
    adapter?: VfsAdapter,
    loadLib = true,
    loadShareLib = true
  ): Promise<JsVMContext> {
    const module = await getModule();
    const context = module.newContext();
    const vm = new JsVMContext(context);
    vm.setupConsole();
    vm.setupTimers();
    vm.setupHalt();
    injectPolyfills(context);

    // Set up fs bridge if adapter provided
    if (adapter) {
      vm.fsBridge = new FsBridge(adapter, context);
      vm.fsBridge.injectFs();

      // Load /share/lib first (shared across namespaces), then /lib (per-project)
      if (loadShareLib) {
        await vm.loadLibScripts(adapter, '/share/lib');
      }
      if (loadLib) {
        await vm.loadLibScripts(adapter, '/lib');
      }
    }

    return vm;
  }

  /**
   * Load and execute all .js files from a given directory.
   * Scripts are executed with their filename for better stack traces.
   * Console output during library loading is captured in libraryConsoleOutput.
   */
  private async loadLibScripts(adapter: VfsAdapter, libPath: string): Promise<void> {
    try {
      // Check if directory exists
      const libExists = await adapter.isDirectory(libPath);
      if (!libExists) {
        return;
      }

      // List files (non-recursive)
      const entries = await adapter.readDir(libPath);

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
            const content = await adapter.readFile(filePath);

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

            // Drain pending jobs, fs operations, and timers from this script
            const deadline = Date.now() + TIMEOUT_MS;
            const drainError = await this.drainPendingJobs(deadline);
            if (drainError) {
              console.error('[JsVMContext] Error draining', filePath, ':', drainError);
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
    // Clear state from previous eval. Dispose any timers left over from a
    // previous run that was aborted (timeout/halt) before they could fire.
    this.consoleOutput = [];
    this.clearTimers();

    // Reset halt state
    this.isHalted = false;
    this.haltMessage = '';
    this.haltConsoleSnapshot = [];

    // Set up interrupt handler for timeout and halt
    const deadline = Date.now() + TIMEOUT_MS;
    this.context.runtime.setInterruptHandler(() => this.isHalted || Date.now() > deadline);

    try {
      const result = this.context.evalCode(code, filename, {
        type: 'global',
        backtraceBarrier: true,
      });

      if (result.error) {
        const errorValue = this.context.dump(result.error);
        result.error.dispose();

        // Check if this was a halt (triggered by interrupt handler)
        if (this.isHalted) {
          return {
            value: 'Halted',
            consoleOutput: [
              ...this.haltConsoleSnapshot,
              { level: 'ERROR', message: this.haltMessage },
            ],
            isError: true,
          };
        }

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

        // Check if this was a halt during async execution
        if (loopError.startsWith('HALT:')) {
          return {
            value: 'Halted',
            consoleOutput: [
              ...this.haltConsoleSnapshot,
              { level: 'ERROR', message: loopError.substring(5) },
            ],
            isError: true,
          };
        }

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

        // Check if halt was called during execution (even if caught by user code)
        if (this.isHalted) {
          return {
            value: 'Halted',
            consoleOutput: [
              ...this.haltConsoleSnapshot,
              { level: 'ERROR', message: this.haltMessage },
            ],
            isError: true,
          };
        }

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

        // Check if halt was called during async execution
        if (this.isHalted) {
          return {
            value: 'Halted',
            consoleOutput: [
              ...this.haltConsoleSnapshot,
              { level: 'ERROR', message: this.haltMessage },
            ],
            isError: true,
          };
        }

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
        return 'Error: Execution timeout (300s)';
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
   * Run the event loop until there is no more work: drains microtasks one at a
   * time (yielding to the host between each), processes pending fs operations,
   * then — once microtasks are quiet — sleeps until the earliest scheduled
   * timer is due and fires every timer that has come due. Microtasks always
   * drain before any timer fires, matching real event-loop ordering.
   *
   * Returns an error message if something goes wrong, undefined on success.
   */
  private async drainPendingJobs(deadline: number): Promise<string | undefined> {
    while (
      this.context.runtime.hasPendingJob() ||
      (this.fsBridge && this.fsBridge.hasPendingOps()) ||
      this.timers.size > 0
    ) {
      // Check timeout
      if (Date.now() > deadline) {
        return 'Error: Execution timeout (300s)';
      }

      // Process pending fs operations first using helper
      const fsError = await this.drainFsOperations(deadline);
      if (fsError) {
        return fsError;
      }

      // Drain microtasks before advancing to timers
      if (this.context.runtime.hasPendingJob()) {
        // Yield to host
        await new Promise(resolve => globalThis.setTimeout(resolve, 0));

        const pendingResult = this.context.runtime.executePendingJobs(1);
        if (pendingResult.error) {
          const errorValue = this.context.dump(pendingResult.error);
          pendingResult.error.dispose();

          // Check if this was a halt
          if (this.isHalted) {
            return `HALT:${this.haltMessage}`;
          }

          return this.formatError(errorValue);
        }
        continue;
      }

      // No microtasks left — advance to the next due timer (if any)
      if (this.timers.size > 0) {
        const timerError = await this.fireDueTimers(deadline);
        if (timerError) {
          return timerError;
        }
      }
    }
    return undefined;
  }

  /**
   * Sleep until the earliest scheduled timer is due (capped at the deadline,
   * via the host's real setTimeout), then invoke every timer whose wake time
   * has passed, in (wakeAt, insertion order). A fired callback may schedule or
   * clear timers, so cancellation is re-checked just before each invocation.
   *
   * Returns an error message if a callback throws/halts, undefined otherwise.
   */
  private async fireDueTimers(deadline: number): Promise<string | undefined> {
    let earliest = Infinity;
    for (const timer of this.timers.values()) {
      if (timer.wakeAt < earliest) earliest = timer.wakeAt;
    }

    const waitMs = Math.min(earliest, deadline) - Date.now();
    if (waitMs > 0) {
      await new Promise(resolve => globalThis.setTimeout(resolve, waitMs));
    }
    if (Date.now() > deadline) {
      return 'Error: Execution timeout (300s)';
    }

    const now = Date.now();
    const due = [...this.timers.entries()]
      .filter(([, timer]) => timer.wakeAt <= now)
      .sort((a, b) => a[1].wakeAt - b[1].wakeAt || a[1].seq - b[1].seq);

    for (const [id, timer] of due) {
      // A previously-fired callback may have cleared this one.
      if (!this.timers.has(id)) continue;
      this.timers.delete(id);

      try {
        const callResult = this.context.callFunction(timer.callback, this.context.undefined);
        if (callResult.error) {
          const errorValue = this.context.dump(callResult.error);
          callResult.error.dispose();
          if (this.isHalted) {
            return `HALT:${this.haltMessage}`;
          }
          return this.formatError(errorValue);
        }
        callResult.value.dispose();
      } finally {
        timer.callback.dispose();
      }
    }
    return undefined;
  }

  /** Dispose every scheduled timer's callback handle and clear the registry. */
  private clearTimers(): void {
    for (const timer of this.timers.values()) {
      timer.callback.dispose();
    }
    this.timers.clear();
  }

  /**
   * Dispose the context and release resources.
   */
  dispose(): void {
    // Dispose any timer callback handles that haven't fired yet
    this.clearTimers();
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
   * Set up setTimeout/setInterval/clearTimeout/clearInterval backed by the
   * host-side timer registry. Both setTimeout and setInterval schedule a single
   * fire that honors the real delay; the drain loop sleeps until each is due.
   * setInterval does NOT repeat — a documented limitation.
   */
  private setupTimers(): void {
    const schedule = (callbackHandle: QuickJSHandle, delayHandle?: QuickJSHandle): number => {
      const id = this.nextTimerId++;
      const rawDelay = delayHandle ? this.context.getNumber(delayHandle) : 0;
      const delay = Number.isFinite(rawDelay) && rawDelay > 0 ? rawDelay : 0;
      this.timers.set(id, {
        callback: callbackHandle.dup(),
        wakeAt: Date.now() + delay,
        seq: this.timerSeq++,
      });
      return id;
    };

    const cancel = (idHandle: QuickJSHandle): void => {
      const id = this.context.getNumber(idHandle);
      const timer = this.timers.get(id);
      if (timer) {
        timer.callback.dispose();
        this.timers.delete(id);
      }
    };

    const setTimeoutFn = this.context.newFunction(
      'setTimeout',
      (callbackHandle: QuickJSHandle, delayHandle?: QuickJSHandle) =>
        this.context.newNumber(schedule(callbackHandle, delayHandle))
    );
    this.context.setProp(this.context.global, 'setTimeout', setTimeoutFn);
    setTimeoutFn.dispose();

    // setInterval honors its delay but fires once (no repeat) — documented limitation.
    const setIntervalFn = this.context.newFunction(
      'setInterval',
      (callbackHandle: QuickJSHandle, delayHandle?: QuickJSHandle) =>
        this.context.newNumber(schedule(callbackHandle, delayHandle))
    );
    this.context.setProp(this.context.global, 'setInterval', setIntervalFn);
    setIntervalFn.dispose();

    const clearTimeoutFn = this.context.newFunction('clearTimeout', cancel);
    this.context.setProp(this.context.global, 'clearTimeout', clearTimeoutFn);
    clearTimeoutFn.dispose();

    const clearIntervalFn = this.context.newFunction('clearInterval', cancel);
    this.context.setProp(this.context.global, 'clearInterval', clearIntervalFn);
    clearIntervalFn.dispose();
  }

  /**
   * Set up halt(message) function.
   * halt() immediately stops execution and logs the message at ERROR level.
   *
   * Implementation: halt sets a flag via host call, captures console snapshot, then throws.
   * Even if user code catches the throw, the isHalted flag remains set and we override
   * the result at the end of evaluation. Console output before halt() is preserved,
   * but output after halt() (including catch blocks) is discarded.
   */
  private setupHalt(): void {
    // Host function sets halt state, captures console snapshot, and throws to break execution
    const haltFn = this.context.newFunction('halt', (messageHandle?: QuickJSHandle) => {
      const message = messageHandle ? this.context.getString(messageHandle) : 'Halted';
      this.isHalted = true;
      this.haltMessage = message;
      // Capture console output at halt time (logs before halt are preserved)
      this.haltConsoleSnapshot = [...this.consoleOutput];
      // Throw to break current execution (may be caught, but isHalted flag persists)
      throw new Error('__HALT__');
    });
    this.context.setProp(this.context.global, 'halt', haltFn);
    haltFn.dispose();
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
        return 'Error: Execution timeout (300s)';
      }
      const base = `${err.name || 'Error'}: ${err.message || String(errorValue)}`;
      const stack = typeof err.stack === 'string' ? `\n${err.stack}` : '';
      return `${base}${stack}`;
    }
    return String(errorValue);
  }
}
