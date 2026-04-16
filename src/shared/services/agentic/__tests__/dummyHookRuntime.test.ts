import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DummyHookRuntime } from '../dummyHookRuntime';
import type { VfsAdapter } from '../../vfs/vfsAdapter';

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
    createFileGuarded: vi.fn(),
    ensureDirAndWrite: vi.fn(),
    compactProject: vi.fn(),
  } as VfsAdapter;
}

let adapter: VfsAdapter;

describe('DummyHookRuntime', () => {
  beforeEach(() => {
    adapter = createMockAdapter();
  });

  describe('load', () => {
    it('returns null when hook file does not exist', async () => {
      (adapter.readFile as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('not found'));

      const runtime = await DummyHookRuntime.load(adapter, 'missing-hook');
      expect(runtime).toBeNull();
    });

    it('loads a hook file from VFS', async () => {
      (adapter.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(
        'return function(msg, iter) { return undefined; };'
      );

      const runtime = await DummyHookRuntime.load(adapter, 'test-hook');
      expect(runtime).not.toBeNull();
      runtime?.dispose();
    });
  });

  describe('run', () => {
    it('returns undefined value for passthrough hooks', async () => {
      (adapter.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(
        'return function(msg, iter) { return undefined; };'
      );

      const runtime = await DummyHookRuntime.load(adapter, 'pass');
      expect(runtime).not.toBeNull();

      const result = await runtime!.run({}, 1);
      expect(result.value).toBeUndefined();
      expect(result.error).toBeUndefined();
      runtime!.dispose();
    });

    it('returns "user" when hook returns "user"', async () => {
      (adapter.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(
        'return function(msg, iter) { return "user"; };'
      );

      const runtime = await DummyHookRuntime.load(adapter, 'stop');
      const result = await runtime!.run({}, 1);
      expect(result.value).toBe('user');
      expect(result.error).toBeUndefined();
      runtime!.dispose();
    });

    it('returns structured response with text', async () => {
      (adapter.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(
        'return function(msg, iter) { return { text: "Hello", brief: "auto" }; };'
      );

      const runtime = await DummyHookRuntime.load(adapter, 'respond');
      const result = await runtime!.run({}, 1);
      expect(result.value).toEqual({ text: 'Hello', brief: 'auto' });
      expect(result.error).toBeUndefined();
      runtime!.dispose();
    });

    it('returns structured response with toolCalls', async () => {
      (adapter.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(
        `return function(msg, iter) {
          return {
            text: "Running search",
            toolCalls: [{ name: "memory", input: { action: "view" } }],
            brief: "auto-search"
          };
        };`
      );

      const runtime = await DummyHookRuntime.load(adapter, 'tools');
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
      (adapter.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(
        'return function(msg, iter) { throw new Error("boom"); };'
      );

      const runtime = await DummyHookRuntime.load(adapter, 'broken');
      const result = await runtime!.run({}, 1);
      expect(result.value).toBeUndefined();
      expect(result.error).toContain('boom');
      runtime!.dispose();
    });

    it('passes lastMessage data to hook', async () => {
      (adapter.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(
        `return function(msg, iter) {
          if (msg.toolResults && msg.toolResults.length > 0 && msg.toolResults[0].name === "memory") {
            return { text: "Got memory result", brief: "test" };
          }
          return undefined;
        };`
      );

      const runtime = await DummyHookRuntime.load(adapter, 'check');

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
      (adapter.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(
        `return function(msg, iter) {
          if (iter > 3) return "user";
          return undefined;
        };`
      );

      const runtime = await DummyHookRuntime.load(adapter, 'iter');

      expect((await runtime!.run({}, 1)).value).toBeUndefined();
      expect((await runtime!.run({}, 3)).value).toBeUndefined();
      expect((await runtime!.run({}, 4)).value).toBe('user');
      runtime!.dispose();
    });

    it('passes chatId and messageId to hook', async () => {
      (adapter.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(
        `return function(msg, iter) {
          if (msg.chatId && msg.messageId) {
            return { text: msg.chatId + ":" + msg.messageId, brief: "ids" };
          }
          return undefined;
        };`
      );

      const runtime = await DummyHookRuntime.load(adapter, 'ids');
      const result = await runtime!.run({ chatId: 'chat-42', messageId: 'msg-7' }, 1);
      expect(result.value).toEqual({ text: 'chat-42:msg-7', brief: 'ids' });
      runtime!.dispose();
    });

    it('supports async hook function returning synthetic response', async () => {
      (adapter.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(
        'return async function(msg, iter) { return { text: "async hello", brief: "async" }; };'
      );

      const runtime = await DummyHookRuntime.load(adapter, 'async-respond');
      const result = await runtime!.run({}, 1);
      expect(result.value).toEqual({ text: 'async hello', brief: 'async' });
      expect(result.error).toBeUndefined();
      runtime!.dispose();
    });

    it('supports async hook function returning "user"', async () => {
      (adapter.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(
        'return async function(msg, iter) { return "user"; };'
      );

      const runtime = await DummyHookRuntime.load(adapter, 'async-stop');
      const result = await runtime!.run({}, 1);
      expect(result.value).toBe('user');
      expect(result.error).toBeUndefined();
      runtime!.dispose();
    });

    it('supports top-level await in hook file body', async () => {
      (adapter.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(
        `var config = await Promise.resolve({ limit: 5 });
        return function(msg, iter) {
          if (iter > config.limit) return "user";
          return undefined;
        };`
      );

      const runtime = await DummyHookRuntime.load(adapter, 'top-await');
      expect((await runtime!.run({}, 3)).value).toBeUndefined();
      expect((await runtime!.run({}, 6)).value).toBe('user');
      runtime!.dispose();
    });

    it('passes history array to hook', async () => {
      (adapter.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(
        `return function(msg, iter) {
          if (msg.history && msg.history.length === 2) {
            return { text: msg.history[0].id + "," + msg.history[1].role, brief: "hist" };
          }
          return undefined;
        };`
      );

      const runtime = await DummyHookRuntime.load(adapter, 'hist');
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
