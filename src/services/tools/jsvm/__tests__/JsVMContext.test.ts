import { describe, it, expect, afterEach } from 'vitest';
import { JsVMContext } from '../JsVMContext';

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
});
