import { describe, it, expect, afterEach, vi, type Mock, beforeEach } from 'vitest';
import { JsVMContext } from '../JsVMContext';
import type { VfsAdapter } from '../../../vfs/vfsAdapter';
import { LocalVfsAdapter } from '../../../vfs/localVfsAdapter';
import { createVfsService } from '../../../vfs/vfsService';
import type { UnifiedStorage } from '../../../storage/unifiedStorage';
import type { EncryptionCore } from '../../../encryption/encryptionCore';
import { buildStubVfsDeps } from '../../../vfs/__tests__/_vfsTestHelpers';

function createMockAdapter(): VfsAdapter {
  return {
    readDir: vi.fn(),
    readFile: vi.fn(),
    readFileWithMeta: vi.fn(),
    writeFile: vi.fn(),
    createFile: vi.fn(),
    deleteFile: vi.fn(),
    mkdir: vi.fn(),
    rmdir: vi.fn(),
    rename: vi.fn(),
    exists: vi.fn(),
    isFile: vi.fn(),
    isDirectory: vi.fn(),
    stat: vi.fn(),
    hasVfs: vi.fn(),
    clearVfs: vi.fn(),
    strReplace: vi.fn(),
    insert: vi.fn(),
    appendFile: vi.fn(),
    getFileMeta: vi.fn(),
    getFileId: vi.fn(),
    listVersions: vi.fn(),
    getVersion: vi.fn(),
    dropOldVersions: vi.fn(),
    listOrphans: vi.fn(),
    restoreOrphan: vi.fn(),
    purgeOrphan: vi.fn(),
    copyFile: vi.fn(),
    deletePath: vi.fn(),
    deletePaths: vi.fn(),
    createFileGuarded: vi.fn(),
    ensureDirAndWrite: vi.fn(),
    writeFileWithHistory: vi.fn(),
    compactProject: vi.fn(),
  } as VfsAdapter;
}

describe('JsVMContext', () => {
  let vm: JsVMContext | null = null;

  afterEach(() => {
    vm?.dispose();
    vm = null;
  });

  describe('basic evaluation', () => {
    it('evaluates simple expressions', async () => {
      vm = await JsVMContext.create();
      const result = await vm.evaluate('1 + 1');

      expect(result.isError).toBe(false);
      expect(result.value).toBe(2);
    });

    it('evaluates object literals wrapped in parentheses', async () => {
      vm = await JsVMContext.create();
      const result = await vm.evaluate('({score: 5})');

      expect(result.isError).toBe(false);
      expect(result.value).toEqual({ score: 5 });
    });

    it('handles syntax errors', async () => {
      vm = await JsVMContext.create();
      const result = await vm.evaluate('const x = ');

      expect(result.isError).toBe(true);
      expect(result.value).toContain('SyntaxError');
    });

    it('handles runtime errors', async () => {
      vm = await JsVMContext.create();
      const result = await vm.evaluate('nonExistentFunction()');

      expect(result.isError).toBe(true);
      expect(result.value).toContain('not defined');
    });
  });

  describe('console output', () => {
    it('captures console.log output', async () => {
      vm = await JsVMContext.create();
      const result = await vm.evaluate('console.log("hello"); 42');

      expect(result.isError).toBe(false);
      expect(result.value).toBe(42);
      expect(result.consoleOutput).toHaveLength(1);
      expect(result.consoleOutput[0]).toEqual({ level: 'LOG', message: 'hello' });
    });

    it('captures all console levels', async () => {
      vm = await JsVMContext.create();
      const result = await vm.evaluate(`
        console.log("log");
        console.warn("warn");
        console.error("error");
        console.info("info");
        console.debug("debug");
      `);

      expect(result.consoleOutput).toHaveLength(5);
      expect(result.consoleOutput[0].level).toBe('LOG');
      expect(result.consoleOutput[1].level).toBe('WARN');
      expect(result.consoleOutput[2].level).toBe('ERROR');
      expect(result.consoleOutput[3].level).toBe('INFO');
      expect(result.consoleOutput[4].level).toBe('DEBUG');
    });

    it('clears console between evaluations', async () => {
      vm = await JsVMContext.create();
      await vm.evaluate('console.log("first")');
      const result = await vm.evaluate('console.log("second")');

      expect(result.consoleOutput).toHaveLength(1);
      expect(result.consoleOutput[0].message).toBe('second');
    });
  });

  describe('session state persistence', () => {
    it('persists variables across evaluations', async () => {
      vm = await JsVMContext.create();

      await vm.evaluate('const x = 10');
      const result = await vm.evaluate('x * 2');

      expect(result.isError).toBe(false);
      expect(result.value).toBe(20);
    });

    it('persists functions across evaluations', async () => {
      vm = await JsVMContext.create();

      await vm.evaluate('function double(n) { return n * 2; }');
      const result = await vm.evaluate('double(21)');

      expect(result.value).toBe(42);
    });
  });

  describe('async/await support', () => {
    it('resolves Promise with then', async () => {
      vm = await JsVMContext.create();
      // Use Promise.then to store the resolved value in a variable
      await vm.evaluate(`
        let resolved = null;
        Promise.resolve(42).then(v => { resolved = v; });
      `);

      const result = await vm.evaluate('resolved');
      expect(result.isError).toBe(false);
      expect(result.value).toBe(42);
    });

    it('handles async IIFE', async () => {
      vm = await JsVMContext.create();
      // Use async IIFE with a side effect to verify it runs
      await vm.evaluate(`
        let asyncResult = null;
        (async () => {
          asyncResult = await Promise.resolve('done');
        })();
      `);

      const result = await vm.evaluate('asyncResult');
      expect(result.isError).toBe(false);
      expect(result.value).toBe('done');
    });

    it('chains multiple promises', async () => {
      vm = await JsVMContext.create();
      await vm.evaluate(`
        let chain = [];
        Promise.resolve(1)
          .then(v => { chain.push(v); return v + 1; })
          .then(v => { chain.push(v); return v + 1; })
          .then(v => { chain.push(v); });
      `);

      const result = await vm.evaluate('chain');
      expect(result.value).toEqual([1, 2, 3]);
    });

    it('returns resolved value when code directly returns a promise', async () => {
      vm = await JsVMContext.create();
      const result = await vm.evaluate('Promise.resolve(42)');

      expect(result.isError).toBe(false);
      expect(result.value).toBe(42);
    });

    it('returns resolved value from async function return', async () => {
      vm = await JsVMContext.create();
      const result = await vm.evaluate('(async () => 123)()');

      expect(result.isError).toBe(false);
      expect(result.value).toBe(123);
    });

    it('returns complex object from resolved promise', async () => {
      vm = await JsVMContext.create();
      const result = await vm.evaluate('Promise.resolve({ a: 1, b: [2, 3] })');

      expect(result.isError).toBe(false);
      expect(result.value).toEqual({ a: 1, b: [2, 3] });
    });

    it('handles rejected promise as error', async () => {
      vm = await JsVMContext.create();
      const result = await vm.evaluate('Promise.reject(new Error("rejection reason"))');

      expect(result.isError).toBe(true);
      expect(result.value).toContain('Error');
      expect(result.value).toContain('rejection reason');
    });

    it('handles async function that throws', async () => {
      vm = await JsVMContext.create();
      const result = await vm.evaluate(`
        (async () => {
          throw new Error('async error');
        })()
      `);

      expect(result.isError).toBe(true);
      expect(result.value).toContain('async error');
    });
  });

  describe('setTimeout support', () => {
    it('executes setTimeout callbacks', async () => {
      vm = await JsVMContext.create();
      const result = await vm.evaluate(`
        let value = 0;
        setTimeout(() => { value = 42; });
        value
      `);

      // Initial value is 0, but setTimeout runs during macrotask drain
      expect(result.isError).toBe(false);
      // The result.value is 0 because that's the last expression before setTimeout runs

      // Verify the callback ran
      const check = await vm.evaluate('value');
      expect(check.value).toBe(42);
    });

    it('executes setTimeout callbacks in FIFO order', async () => {
      vm = await JsVMContext.create();
      await vm.evaluate(`
        const order = [];
        setTimeout(() => { order.push(1); });
        setTimeout(() => { order.push(2); });
        setTimeout(() => { order.push(3); });
      `);

      const result = await vm.evaluate('order');
      expect(result.value).toEqual([1, 2, 3]);
    });

    it('clearTimeout cancels pending callbacks', async () => {
      vm = await JsVMContext.create();
      await vm.evaluate(`
        let value = 'unchanged';
        const id = setTimeout(() => { value = 'changed'; });
        clearTimeout(id);
      `);

      const result = await vm.evaluate('value');
      expect(result.value).toBe('unchanged');
    });

    it('returns timer ID from setTimeout', async () => {
      vm = await JsVMContext.create();
      const result = await vm.evaluate('typeof setTimeout(() => {})');

      expect(result.value).toBe('number');
    });

    it('waits the real delay before resolving', async () => {
      vm = await JsVMContext.create();
      const start = Date.now();
      const result = await vm.evaluate(`
        (async () => {
          await new Promise(resolve => setTimeout(resolve, 60));
          return 'done';
        })()
      `);
      const elapsed = Date.now() - start;

      expect(result.isError).toBe(false);
      expect(result.value).toBe('done');
      // Allow a little slack below the 60ms delay for timer coarseness.
      expect(elapsed).toBeGreaterThanOrEqual(50);
    });

    it('fires callbacks in delay order, not registration order', async () => {
      vm = await JsVMContext.create();
      const result = await vm.evaluate(`
        (async () => {
          const order = [];
          setTimeout(() => order.push('a'), 50);
          setTimeout(() => order.push('b'), 10);
          await new Promise(resolve => setTimeout(resolve, 90));
          return order;
        })()
      `);

      expect(result.isError).toBe(false);
      expect(result.value).toEqual(['b', 'a']);
    });

    it('setInterval honors its delay but fires once (no repeat)', async () => {
      vm = await JsVMContext.create();
      const result = await vm.evaluate(`
        (async () => {
          let count = 0;
          setInterval(() => { count++; }, 20);
          await new Promise(resolve => setTimeout(resolve, 90));
          return count;
        })()
      `);

      expect(result.isError).toBe(false);
      expect(result.value).toBe(1);
    });
  });

  describe('polyfills', () => {
    describe('self global', () => {
      it('self equals globalThis', async () => {
        vm = await JsVMContext.create();
        const result = await vm.evaluate('self === globalThis');

        expect(result.value).toBe(true);
      });
    });

    describe('TextEncoder/TextDecoder', () => {
      it('TextEncoder encodes ASCII strings', async () => {
        vm = await JsVMContext.create();
        const result = await vm.evaluate(`
          const encoder = new TextEncoder();
          Array.from(encoder.encode('hi'))
        `);

        expect(result.value).toEqual([104, 105]); // 'h' = 104, 'i' = 105
      });

      it('TextEncoder encodes UTF-8 multibyte characters', async () => {
        vm = await JsVMContext.create();
        const result = await vm.evaluate(`
          const encoder = new TextEncoder();
          Array.from(encoder.encode('日'))
        `);

        // '日' in UTF-8 is E6 97 A5 (230, 151, 165)
        expect(result.value).toEqual([230, 151, 165]);
      });

      it('TextDecoder decodes UTF-8 bytes', async () => {
        vm = await JsVMContext.create();
        const result = await vm.evaluate(`
          const decoder = new TextDecoder();
          decoder.decode(new Uint8Array([104, 105]))
        `);

        expect(result.value).toBe('hi');
      });

      it('roundtrips text through encode/decode', async () => {
        vm = await JsVMContext.create();
        const result = await vm.evaluate(`
          const text = 'Hello 世界! 🎉';
          const encoder = new TextEncoder();
          const decoder = new TextDecoder();
          decoder.decode(encoder.encode(text))
        `);

        expect(result.value).toBe('Hello 世界! 🎉');
      });
    });

    describe('atob/btoa', () => {
      it('btoa encodes to base64', async () => {
        vm = await JsVMContext.create();
        const result = await vm.evaluate("btoa('hello')");

        expect(result.value).toBe('aGVsbG8=');
      });

      it('atob decodes from base64', async () => {
        vm = await JsVMContext.create();
        const result = await vm.evaluate("atob('aGVsbG8=')");

        expect(result.value).toBe('hello');
      });

      it('roundtrips through btoa/atob', async () => {
        vm = await JsVMContext.create();
        const result = await vm.evaluate("atob(btoa('test string'))");

        expect(result.value).toBe('test string');
      });

      it('btoa handles binary data', async () => {
        vm = await JsVMContext.create();
        const result = await vm.evaluate(`
          btoa(String.fromCharCode(0, 1, 255))
        `);

        expect(result.value).toBe('AAH/');
      });
    });
  });

  describe('error stack traces', () => {
    it('includes stack trace in sync error output', async () => {
      vm = await JsVMContext.create();
      const result = await vm.evaluate(`
        function outer() {
          inner();
        }
        function inner() {
          throw new Error('sync error');
        }
        outer();
      `);

      expect(result.isError).toBe(true);
      expect(result.value).toContain('sync error');
      // Should include VM stack trace with function names
      expect(result.value).toContain('inner');
      expect(result.value).toContain('outer');
    });

    it('includes stack trace in async error output', async () => {
      vm = await JsVMContext.create();
      const result = await vm.evaluate(`
        async function asyncOuter() {
          await asyncInner();
        }
        async function asyncInner() {
          throw new Error('async stack error');
        }
        asyncOuter();
      `);

      expect(result.isError).toBe(true);
      expect(result.value).toContain('async stack error');
      // Should include VM stack trace with function names
      expect(result.value).toContain('asyncInner');
    });

    it('includes stack trace in rejected promise', async () => {
      vm = await JsVMContext.create();
      const result = await vm.evaluate(`
        function rejectWithStack() {
          return Promise.reject(new Error('rejected with stack'));
        }
        rejectWithStack();
      `);

      expect(result.isError).toBe(true);
      expect(result.value).toContain('rejected with stack');
      expect(result.value).toContain('rejectWithStack');
    });

    it('does not leak host stack in sync errors', async () => {
      vm = await JsVMContext.create();
      const result = await vm.evaluate('throw new Error("test")');

      expect(result.isError).toBe(true);
      // Should NOT contain host file paths (eval.js is fine - it's the VM's internal name)
      expect(result.value).not.toContain('JsVMContext.ts');
      expect(result.value).not.toContain('/workspaces/');
      expect(result.value).not.toContain('node_modules');
      // Stack should only contain VM locations like "eval.js", not host .ts/.js files with paths
      expect(result.value).not.toMatch(/at\s+\S+\s+\([^)]*\/[^)]+\.[tj]s:/);
    });

    it('does not leak host stack in async errors', async () => {
      vm = await JsVMContext.create();
      const result = await vm.evaluate(`
        (async () => {
          throw new Error('async leak test');
        })()
      `);

      expect(result.isError).toBe(true);
      // Should NOT contain host file paths
      expect(result.value).not.toContain('JsVMContext.ts');
      expect(result.value).not.toContain('/workspaces/');
      expect(result.value).not.toContain('node_modules');
    });

    it('does not leak host stack in rejected promises', async () => {
      vm = await JsVMContext.create();
      const result = await vm.evaluate('Promise.reject(new Error("reject leak test"))');

      expect(result.isError).toBe(true);
      // Should NOT contain host file paths
      expect(result.value).not.toContain('JsVMContext.ts');
      expect(result.value).not.toContain('/workspaces/');
      expect(result.value).not.toContain('node_modules');
    });
  });

  describe('halt', () => {
    it('stops execution immediately with message', async () => {
      vm = await JsVMContext.create();
      const result = await vm.evaluate(`
        halt("stopping here");
        console.log("should not run");
        42
      `);

      expect(result.isError).toBe(true);
      expect(result.value).toBe('Halted');
      expect(result.consoleOutput).toHaveLength(1);
      expect(result.consoleOutput[0].level).toBe('ERROR');
      expect(result.consoleOutput[0].message).toBe('stopping here');
    });

    it('is uncatchable by try/catch', async () => {
      vm = await JsVMContext.create();
      const result = await vm.evaluate(`
        try {
          halt("caught?");
          console.log("a");
        } catch {
          console.log("b");
        }
        console.log("c");
      `);

      expect(result.isError).toBe(true);
      expect(result.value).toBe('Halted');
      // Only the halt message, no other console output
      expect(result.consoleOutput).toHaveLength(1);
      expect(result.consoleOutput[0].message).toBe('caught?');
    });

    it('uses default message when called without argument', async () => {
      vm = await JsVMContext.create();
      const result = await vm.evaluate('halt()');

      expect(result.isError).toBe(true);
      expect(result.value).toBe('Halted');
      expect(result.consoleOutput).toHaveLength(1);
      expect(result.consoleOutput[0].message).toBe('Halted');
    });

    it('preserves console output before halt', async () => {
      vm = await JsVMContext.create();
      const result = await vm.evaluate(`
        console.log("before");
        console.warn("also before");
        halt("the message");
      `);

      expect(result.isError).toBe(true);
      // Console output before halt is preserved, halt message appended
      expect(result.consoleOutput).toHaveLength(3);
      expect(result.consoleOutput[0].message).toBe('before');
      expect(result.consoleOutput[1].message).toBe('also before');
      expect(result.consoleOutput[2].level).toBe('ERROR');
      expect(result.consoleOutput[2].message).toBe('the message');
    });

    it('stops async execution', async () => {
      vm = await JsVMContext.create();
      const result = await vm.evaluate(`
        (async () => {
          await Promise.resolve();
          halt("async halt");
          console.log("after await");
        })()
      `);

      expect(result.isError).toBe(true);
      expect(result.value).toBe('Halted');
      expect(result.consoleOutput).toHaveLength(1);
      expect(result.consoleOutput[0].message).toBe('async halt');
    });

    it('stops execution after await, preserving logs before halt', async () => {
      vm = await JsVMContext.create();
      const result = await vm.evaluate(`
        (async () => {
          console.log("before");
          await Promise.resolve();
          console.log("after await");
          halt("stopping after await");
          console.log("should not matter");
          return "done";
        })()
      `);

      expect(result.isError).toBe(true);
      expect(result.value).toBe('Halted');
      // Console output before halt is preserved, output after halt is discarded
      expect(result.consoleOutput).toHaveLength(3);
      expect(result.consoleOutput[0].message).toBe('before');
      expect(result.consoleOutput[1].message).toBe('after await');
      expect(result.consoleOutput[2].level).toBe('ERROR');
      expect(result.consoleOutput[2].message).toBe('stopping after await');
    });
  });

  describe('dispose', () => {
    it('can be disposed safely', async () => {
      vm = await JsVMContext.create();
      vm.dispose();
      vm = null; // Prevent double dispose in afterEach
    });

    it('disposes pending macrotasks', async () => {
      vm = await JsVMContext.create();
      // Queue a callback but dispose before it runs
      vm.getContext().evalCode('setTimeout(() => {})');
      vm.dispose();
      vm = null;
    });
  });

  describe('lib script loading', () => {
    let adapter: VfsAdapter;

    beforeEach(() => {
      adapter = createMockAdapter();
    });

    /** Configure adapter mocks so specific lib directories exist with given scripts */
    function mockLibDir(libPath: string, scripts: { name: string; content: string }[]) {
      (adapter.isDirectory as Mock).mockImplementation((path: string) =>
        Promise.resolve(path === libPath)
      );
      (adapter.readDir as Mock).mockImplementation((path: string) => {
        if (path === libPath) {
          return Promise.resolve(scripts.map(s => ({ name: s.name, type: 'file' })));
        }
        return Promise.resolve([]);
      });
      (adapter.readFile as Mock).mockImplementation((path: string) => {
        const script = scripts.find(s => `${libPath}/${s.name}` === path);
        return Promise.resolve(script?.content ?? '');
      });
    }

    /** Configure adapter mocks for both /share/lib and /lib directories */
    function mockBothLibDirs(
      shareScripts: { name: string; content: string }[],
      libScripts: { name: string; content: string }[]
    ) {
      (adapter.isDirectory as Mock).mockImplementation((path: string) =>
        Promise.resolve(path === '/share/lib' || path === '/lib')
      );
      (adapter.readDir as Mock).mockImplementation((path: string) => {
        if (path === '/share/lib')
          return Promise.resolve(shareScripts.map(s => ({ name: s.name, type: 'file' })));
        if (path === '/lib')
          return Promise.resolve(libScripts.map(s => ({ name: s.name, type: 'file' })));
        return Promise.resolve([]);
      });
      (adapter.readFile as Mock).mockImplementation((path: string) => {
        const shareScript = shareScripts.find(s => `/share/lib/${s.name}` === path);
        if (shareScript) return Promise.resolve(shareScript.content);
        const libScript = libScripts.find(s => `/lib/${s.name}` === path);
        if (libScript) return Promise.resolve(libScript.content);
        return Promise.resolve('');
      });
    }

    it('loads /share/lib scripts when enabled', async () => {
      mockLibDir('/share/lib', [{ name: 'utils.js', content: 'globalThis.shared = 42;' }]);

      vm = await JsVMContext.create(adapter, false, true);
      const result = await vm.evaluate('shared');

      expect(result.isError).toBe(false);
      expect(result.value).toBe(42);
    });

    it('loads /share/lib before /lib (order verification)', async () => {
      mockBothLibDirs(
        [{ name: 'a.js', content: 'globalThis.order = ["share"];' }],
        [{ name: 'a.js', content: 'globalThis.order.push("lib");' }]
      );

      vm = await JsVMContext.create(adapter, true, true);
      const result = await vm.evaluate('order');

      expect(result.isError).toBe(false);
      expect(result.value).toEqual(['share', 'lib']);
    });

    it('skips /share/lib when disabled', async () => {
      mockBothLibDirs(
        [{ name: 'a.js', content: 'globalThis.shared = true;' }],
        [{ name: 'a.js', content: 'globalThis.local = true;' }]
      );

      vm = await JsVMContext.create(adapter, true, false);

      const sharedResult = await vm.evaluate('typeof shared');
      expect(sharedResult.value).toBe('undefined');

      const localResult = await vm.evaluate('local');
      expect(localResult.value).toBe(true);
    });

    it('loads nothing when both disabled', async () => {
      mockBothLibDirs(
        [{ name: 'a.js', content: 'globalThis.shared = true;' }],
        [{ name: 'a.js', content: 'globalThis.local = true;' }]
      );

      vm = await JsVMContext.create(adapter, false, false);

      const sharedResult = await vm.evaluate('typeof shared');
      expect(sharedResult.value).toBe('undefined');

      const localResult = await vm.evaluate('typeof local');
      expect(localResult.value).toBe('undefined');
    });

    it('captures /share/lib console output in library logs', async () => {
      mockLibDir('/share/lib', [{ name: 'log.js', content: 'console.log("hello from share");' }]);

      vm = await JsVMContext.create(adapter, false, true);
      const logs = vm.getLibraryLogs();

      expect(logs).toHaveLength(2);
      expect(logs[0].message).toContain('log.js');
      expect(logs[1].message).toBe('hello from share');
    });
  });

  describe('fs.writeFile', () => {
    let adapter: VfsAdapter;

    beforeEach(() => {
      adapter = createMockAdapter();
      (adapter.isDirectory as Mock).mockResolvedValue(false); // No /lib directory
      (adapter.writeFile as Mock).mockResolvedValue(undefined);
    });

    it('writes Uint8Array as raw bytes', async () => {
      vm = await JsVMContext.create(adapter, false);

      const result = await vm.evaluate(`
        (async () => {
          const bytes = new Uint8Array([0x7F, 0x45, 0x4C, 0x46]);
          await fs.writeFile('/test', bytes);
          return 'done';
        })()
      `);

      expect(result.isError).toBe(false);
      expect(result.value).toBe('done');
      expect(adapter.writeFile).toHaveBeenCalledTimes(1);

      // Verify the data is an ArrayBuffer with correct bytes
      const [, data] = (adapter.writeFile as Mock).mock.calls[0];
      expect(data).toBeInstanceOf(ArrayBuffer);
      const written = new Uint8Array(data);
      expect(Array.from(written)).toEqual([0x7f, 0x45, 0x4c, 0x46]);
    });

    it('writes ArrayBuffer as raw bytes', async () => {
      vm = await JsVMContext.create(adapter, false);

      const result = await vm.evaluate(`
        (async () => {
          const bytes = new Uint8Array([0x7F, 0x45, 0x4C, 0x46]);
          await fs.writeFile('/test', bytes.buffer);
          return 'done';
        })()
      `);

      expect(result.isError).toBe(false);
      expect(result.value).toBe('done');

      const [, data] = (adapter.writeFile as Mock).mock.calls[0];
      expect(data).toBeInstanceOf(ArrayBuffer);
      const written = new Uint8Array(data);
      expect(Array.from(written)).toEqual([0x7f, 0x45, 0x4c, 0x46]);
    });

    it('writes string as text', async () => {
      vm = await JsVMContext.create(adapter, false);

      const result = await vm.evaluate(`
        (async () => {
          await fs.writeFile('/test.txt', 'hello world');
          return 'done';
        })()
      `);

      expect(result.isError).toBe(false);
      expect(result.value).toBe('done');

      const [, data] = (adapter.writeFile as Mock).mock.calls[0];
      expect(data).toBe('hello world');
    });

    it('rejects non-string non-buffer data', async () => {
      vm = await JsVMContext.create(adapter, false);

      const result = await vm.evaluate(`
        (async () => {
          try {
            await fs.writeFile('/test', { foo: 'bar' });
            return 'should not reach';
          } catch (e) {
            return e.message;
          }
        })()
      `);

      expect(result.isError).toBe(false);
      expect(result.value).toContain('EINVAL');
      expect(result.value).toContain('data must be string or buffer');
      expect(adapter.writeFile).not.toHaveBeenCalled();
    });

    it('rejects number data', async () => {
      vm = await JsVMContext.create(adapter, false);

      const result = await vm.evaluate(`
        (async () => {
          try {
            await fs.writeFile('/test', 12345);
            return 'should not reach';
          } catch (e) {
            return e.message;
          }
        })()
      `);

      expect(result.isError).toBe(false);
      expect(result.value).toContain('EINVAL');
      expect(adapter.writeFile).not.toHaveBeenCalled();
    });
  });

  describe('fs.appendFile / fs.rm / fs.mkdir options', () => {
    let adapter: VfsAdapter;

    beforeEach(() => {
      adapter = createMockAdapter();
      (adapter.isDirectory as Mock).mockResolvedValue(false);
    });

    async function run(code: string) {
      vm = await JsVMContext.create(adapter, false, false);
      return vm.evaluate(`(async () => { ${code} })()`);
    }

    it('appendFile sends one append call', async () => {
      (adapter.appendFile as Mock).mockResolvedValue({ created: true });
      const result = await run(
        `await fs.appendFile('/logs/run.log', 'line\\n', 'utf-8'); return 'ok';`
      );
      expect(result.value).toBe('ok');
      expect(adapter.appendFile).toHaveBeenCalledWith('/logs/run.log', 'line\n');
    });

    it('appendFile rejects non-string data and read-only paths', async () => {
      const result = await run(`
        const errors = [];
        for (const args of [['/a', new Uint8Array([1])], ['/memories/x.md', 'x']]) {
          try { await fs.appendFile(...args); } catch (e) { errors.push(e.message); }
        }
        return errors;
      `);
      expect(result.value).toEqual([
        expect.stringContaining('EINVAL'),
        expect.stringContaining('EROFS'),
      ]);
      expect(adapter.appendFile).not.toHaveBeenCalled();
    });

    it('mkdir passes recursive through', async () => {
      (adapter.mkdir as Mock).mockResolvedValue(undefined);
      await run(`await fs.mkdir('/a/b', { recursive: true }); await fs.mkdir('/c');`);
      expect((adapter.mkdir as Mock).mock.calls).toEqual([
        ['/a/b', { recursive: true }],
        ['/c', { recursive: false }],
      ]);
    });

    it('rm deletes an array in one call and resolves when all succeed', async () => {
      (adapter.deletePaths as Mock).mockImplementation(async (paths: string[]) =>
        paths.map(path => ({ path }))
      );
      const result = await run(`await fs.rm(['/a', '/b'], { recursive: true }); return 'ok';`);
      expect(result.value).toBe('ok');
      expect(adapter.deletePaths).toHaveBeenCalledTimes(1);
      expect(adapter.deletePaths).toHaveBeenCalledWith(['/a', '/b'], true);
    });

    it('rm rejects with the first failure and lists the rest', async () => {
      (adapter.deletePaths as Mock).mockImplementation(async (paths: string[]) =>
        paths.map(path =>
          path === '/ok'
            ? { path }
            : path === '/dir'
              ? { path, error: { code: 'NOT_A_FILE', message: 'dir' } }
              : { path, error: { code: 'PATH_NOT_FOUND', message: 'missing' } }
        )
      );
      const result = await run(`
        try { await fs.rm(['/memories/m.md', '/ok', '/dir', '/gone']); return 'no error'; }
        catch (e) { return e.message; }
      `);
      expect(result.value).toBe(
        "EROFS: read-only file system, rm '/memories/m.md' (also failed: '/dir', '/gone')"
      );
      expect(adapter.deletePaths).toHaveBeenCalledWith(['/ok', '/dir', '/gone'], false);
    });

    it('rm with force ignores missing paths, and a single path works like Node', async () => {
      (adapter.deletePaths as Mock).mockImplementation(async (paths: string[]) =>
        paths.map(path => ({ path, error: { code: 'PATH_NOT_FOUND', message: 'missing' } }))
      );
      const result = await run(`
        await fs.rm('/gone', { force: true });
        try { await fs.rm('/gone'); } catch (e) { return e.message; }
      `);
      expect(result.value).toBe("ENOENT: no such file or directory, '/gone'");
    });

    it('rm validates its target', async () => {
      const result = await run(`try { await fs.rm([1, 2]); } catch (e) { return e.message; }`);
      expect(result.value).toContain('EINVAL');
      expect(adapter.deletePaths).not.toHaveBeenCalled();
    });
  });

  describe('fs /memories access', () => {
    let adapter: VfsAdapter;

    const writeCalls = [
      `await fs.writeFile('/memories/a.md', 'x')`,
      `await fs.appendFile('/memories/a.md', 'x')`,
      `await fs.mkdir('/memories/sub')`,
      `await fs.unlink('/memories/a.md')`,
      `await fs.rmdir('/memories/sub')`,
      `await fs.rm('/memories/a.md')`,
      `await fs.rename('/memories/a.md', '/a.md')`,
      `await fs.rename('/a.md', '/memories/a.md')`,
    ];

    beforeEach(() => {
      adapter = createMockAdapter();
      (adapter.isDirectory as Mock).mockResolvedValue(false);
      (adapter.writeFile as Mock).mockResolvedValue(undefined);
      (adapter.appendFile as Mock).mockResolvedValue({ created: true });
      (adapter.mkdir as Mock).mockResolvedValue(undefined);
      (adapter.deleteFile as Mock).mockResolvedValue(undefined);
      (adapter.rmdir as Mock).mockResolvedValue(undefined);
      (adapter.rename as Mock).mockResolvedValue(undefined);
      (adapter.deletePaths as Mock).mockImplementation(async (paths: string[]) =>
        paths.map(path => ({ path }))
      );
      (adapter.stat as Mock).mockResolvedValue({
        isFile: true,
        isDirectory: false,
        size: 1,
        updatedAt: 0,
        isBinary: false,
      });
    });

    async function runEach(target: JsVMContext, calls: string[]) {
      return target.evaluate(`(async () => {
        const outcomes = [];
        for (const call of ${JSON.stringify(calls)}) {
          try { await eval('(async () => { ' + call + ' })()'); outcomes.push('ok'); }
          catch (e) { outcomes.push(e.message.split(',')[0]); }
        }
        return outcomes;
      })()`);
    }

    it('refuses every write under /memories by default', async () => {
      vm = await JsVMContext.create(adapter, false, false);
      const result = await runEach(vm, writeCalls);
      expect(result.value).toEqual(writeCalls.map(() => 'EROFS: read-only file system'));
      for (const method of [
        'writeFile',
        'appendFile',
        'mkdir',
        'deleteFile',
        'rmdir',
        'deletePaths',
        'rename',
      ] as const) {
        expect(adapter[method]).not.toHaveBeenCalled();
      }
    });

    it('allows every write under /memories with memoriesWritable', async () => {
      vm = await JsVMContext.create(adapter, false, false, { memoriesWritable: true });
      const result = await runEach(vm, writeCalls);
      expect(result.value).toEqual(writeCalls.map(() => 'ok'));
      expect(adapter.writeFile).toHaveBeenCalledWith('/memories/a.md', 'x');
      expect(adapter.rename).toHaveBeenCalledTimes(2);
    });

    it('stat reports readonly per the option and the namespace', async () => {
      const readonlyOf = async (target: JsVMContext, path: string) =>
        (await target.evaluate(`(async () => (await fs.stat('${path}')).readonly)()`)).value;

      const defaults = await JsVMContext.create(adapter, false, false);
      expect(await readonlyOf(defaults, '/memories/a.md')).toBe(true);
      expect(await readonlyOf(defaults, '/share/a.md')).toBe(false);
      defaults.dispose();

      vm = await JsVMContext.create(adapter, false, false, {
        memoriesWritable: true,
        namespace: '/minions/coder',
      });
      expect(await readonlyOf(vm, '/memories/a.md')).toBe(false);
      expect(await readonlyOf(vm, '/share/a.md')).toBe(true);
    });

    it('writes real memory files with memoriesWritable', async () => {
      const { stubStorage, stubEncryption } = buildStubVfsDeps();
      const service = createVfsService(
        stubStorage as unknown as UnifiedStorage,
        stubEncryption as unknown as EncryptionCore
      );
      vm = await JsVMContext.create(new LocalVfsAdapter(service, 'proj_mem'), false, false, {
        memoriesWritable: true,
      });

      const result = await vm.evaluate(`(async () => {
        await fs.writeFile('/memories/README.md', '# Index\\n');
        await fs.appendFile('/memories/README.md', '- note');
        return fs.readFile('/memories/README.md', 'utf-8');
      })()`);

      expect(result.isError).toBe(false);
      expect(result.value).toBe('# Index\n- note');
    });
  });

  describe('fs bridge against the encrypted VFS', () => {
    it('appends into new nested dirs and batch-deletes them', async () => {
      const { stubStorage, stubEncryption } = buildStubVfsDeps();
      const service = createVfsService(
        stubStorage as unknown as UnifiedStorage,
        stubEncryption as unknown as EncryptionCore
      );
      const adapter = new LocalVfsAdapter(service, 'proj_js');
      vm = await JsVMContext.create(adapter, false, false);

      const result = await vm.evaluate(`(async () => {
        for (let i = 0; i < 3; i++) await fs.appendFile('/logs/a/b/run.log', 'line ' + i + '\\n');
        await fs.writeFile('/logs/c/note.txt', 'n');
        const text = await fs.readFile('/logs/a/b/run.log', 'utf-8');
        await fs.rm(['/logs/a', '/logs/c/note.txt'], { recursive: true });
        return { text, left: await fs.readdir('/logs') };
      })()`);

      expect(result.isError).toBe(false);
      expect(result.value).toEqual({ text: 'line 0\nline 1\nline 2\n', left: ['c'] });
    });
  });

  describe('event loop throughput', () => {
    it('runs thousands of awaits without a timer hop per microtask', async () => {
      vm = await JsVMContext.create();
      const started = Date.now();
      const result = await vm.evaluate(`(async () => {
        let n = 0;
        for (let i = 0; i < 10000; i++) { await null; n++; }
        return n;
      })()`);

      expect(result.value).toBe(10000);
      expect(Date.now() - started).toBeLessThan(2000);
    });

    it('still drains microtasks before firing timers', async () => {
      vm = await JsVMContext.create();
      const result = await vm.evaluate(`(async () => {
        const order = [];
        setTimeout(() => order.push('timer'), 0);
        for (let i = 0; i < 500; i++) await null;
        order.push('microtasks');
        await new Promise(r => setTimeout(r, 5));
        return order;
      })()`);
      expect(result.value).toEqual(['microtasks', 'timer']);
    });
  });
});
