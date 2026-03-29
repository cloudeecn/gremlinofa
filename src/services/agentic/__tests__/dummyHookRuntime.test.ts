import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DummyHookRuntime } from '../dummyHookRuntime';

vi.mock('../../vfs', async importOriginal => {
  const actual = await importOriginal<typeof import('../../vfs')>();
  return {
    ...actual,
    readFile: vi.fn(),
    isDirectory: vi.fn(),
    readDir: vi.fn(),
  };
});

const vfs = await import('../../vfs');

describe('DummyHookRuntime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('load', () => {
    it('returns null when hook file does not exist', async () => {
      (vfs.readFile as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('not found'));

      const runtime = await DummyHookRuntime.load('proj-1', undefined, 'missing-hook');
      expect(runtime).toBeNull();
    });

    it('loads a hook file from VFS', async () => {
      (vfs.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(
        'return function(msg, iter) { return undefined; };'
      );

      const runtime = await DummyHookRuntime.load('proj-1', undefined, 'test-hook');
      expect(runtime).not.toBeNull();
      runtime?.dispose();
    });
  });

  describe('run', () => {
    it('returns undefined value for passthrough hooks', async () => {
      (vfs.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(
        'return function(msg, iter) { return undefined; };'
      );

      const runtime = await DummyHookRuntime.load('proj-1', undefined, 'pass');
      expect(runtime).not.toBeNull();

      const result = await runtime!.run({}, 1);
      expect(result.value).toBeUndefined();
      expect(result.error).toBeUndefined();
      runtime!.dispose();
    });

    it('returns "user" when hook returns "user"', async () => {
      (vfs.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(
        'return function(msg, iter) { return "user"; };'
      );

      const runtime = await DummyHookRuntime.load('proj-1', undefined, 'stop');
      const result = await runtime!.run({}, 1);
      expect(result.value).toBe('user');
      expect(result.error).toBeUndefined();
      runtime!.dispose();
    });

    it('returns structured response with text', async () => {
      (vfs.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(
        'return function(msg, iter) { return { text: "Hello", brief: "auto" }; };'
      );

      const runtime = await DummyHookRuntime.load('proj-1', undefined, 'respond');
      const result = await runtime!.run({}, 1);
      expect(result.value).toEqual({ text: 'Hello', brief: 'auto' });
      expect(result.error).toBeUndefined();
      runtime!.dispose();
    });

    it('returns structured response with toolCalls', async () => {
      (vfs.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(
        `return function(msg, iter) {
          return {
            text: "Running search",
            toolCalls: [{ name: "memory", input: { action: "view" } }],
            brief: "auto-search"
          };
        };`
      );

      const runtime = await DummyHookRuntime.load('proj-1', undefined, 'tools');
      const { value } = await runtime!.run({}, 1);

      expect(value).toBeDefined();
      expect(typeof value).toBe('object');
      const obj = value as Exclude<typeof value, undefined | 'user'>;
      expect(obj.text).toBe('Running search');
      expect(obj.toolCalls).toHaveLength(1);
      expect(obj.toolCalls![0].name).toBe('memory');
      expect(obj.brief).toBe('auto-search');
      runtime!.dispose();
    });

    it('returns undefined value with error message on hook error', async () => {
      (vfs.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(
        'return function(msg, iter) { throw new Error("boom"); };'
      );

      const runtime = await DummyHookRuntime.load('proj-1', undefined, 'broken');
      const result = await runtime!.run({}, 1);
      expect(result.value).toBeUndefined();
      expect(result.error).toContain('boom');
      runtime!.dispose();
    });

    it('passes lastMessage data to hook', async () => {
      (vfs.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(
        `return function(msg, iter) {
          if (msg.toolResults && msg.toolResults.length > 0 && msg.toolResults[0].name === "memory") {
            return { text: "Got memory result", brief: "test" };
          }
          return undefined;
        };`
      );

      const runtime = await DummyHookRuntime.load('proj-1', undefined, 'check');

      const passResult = await runtime!.run({ text: 'hello' }, 1);
      expect(passResult.value).toBeUndefined();

      const matchResult = await runtime!.run(
        {
          toolResults: [{ tool_use_id: 'tu_1', name: 'memory', content: 'ok', is_error: false }],
        },
        2
      );
      expect(matchResult.value).toEqual({ text: 'Got memory result', brief: 'test' });
      runtime!.dispose();
    });

    it('passes iteration count to hook', async () => {
      (vfs.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(
        `return function(msg, iter) {
          if (iter > 3) return "user";
          return undefined;
        };`
      );

      const runtime = await DummyHookRuntime.load('proj-1', undefined, 'iter');

      expect((await runtime!.run({}, 1)).value).toBeUndefined();
      expect((await runtime!.run({}, 3)).value).toBeUndefined();
      expect((await runtime!.run({}, 4)).value).toBe('user');
      runtime!.dispose();
    });

    it('passes chatId and messageId to hook', async () => {
      (vfs.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(
        `return function(msg, iter) {
          if (msg.chatId && msg.messageId) {
            return { text: msg.chatId + ":" + msg.messageId, brief: "ids" };
          }
          return undefined;
        };`
      );

      const runtime = await DummyHookRuntime.load('proj-1', undefined, 'ids');
      const result = await runtime!.run({ chatId: 'chat-42', messageId: 'msg-7' }, 1);
      expect(result.value).toEqual({ text: 'chat-42:msg-7', brief: 'ids' });
      runtime!.dispose();
    });

    it('supports async hook function returning synthetic response', async () => {
      (vfs.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(
        'return async function(msg, iter) { return { text: "async hello", brief: "async" }; };'
      );

      const runtime = await DummyHookRuntime.load('proj-1', undefined, 'async-respond');
      const result = await runtime!.run({}, 1);
      expect(result.value).toEqual({ text: 'async hello', brief: 'async' });
      expect(result.error).toBeUndefined();
      runtime!.dispose();
    });

    it('supports async hook function returning "user"', async () => {
      (vfs.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(
        'return async function(msg, iter) { return "user"; };'
      );

      const runtime = await DummyHookRuntime.load('proj-1', undefined, 'async-stop');
      const result = await runtime!.run({}, 1);
      expect(result.value).toBe('user');
      expect(result.error).toBeUndefined();
      runtime!.dispose();
    });

    it('supports top-level await in hook file body', async () => {
      (vfs.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(
        `var config = await Promise.resolve({ limit: 5 });
        return function(msg, iter) {
          if (iter > config.limit) return "user";
          return undefined;
        };`
      );

      const runtime = await DummyHookRuntime.load('proj-1', undefined, 'top-await');
      expect((await runtime!.run({}, 3)).value).toBeUndefined();
      expect((await runtime!.run({}, 6)).value).toBe('user');
      runtime!.dispose();
    });

    it('passes history array to hook', async () => {
      (vfs.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(
        `return function(msg, iter) {
          if (msg.history && msg.history.length === 2) {
            return { text: msg.history[0].id + "," + msg.history[1].role, brief: "hist" };
          }
          return undefined;
        };`
      );

      const runtime = await DummyHookRuntime.load('proj-1', undefined, 'hist');
      const result = await runtime!.run(
        {
          chatId: 'chat-1',
          history: [
            { id: 'prev-1', role: 'user', text: 'hello' },
            { id: 'prev-2', role: 'assistant', text: 'hi there' },
          ],
        },
        1
      );
      expect(result.value).toEqual({ text: 'prev-1,assistant', brief: 'hist' });
      runtime!.dispose();
    });
  });
});
