/**
 * Admin record editor RPCs (`adminGetRecord` / `adminSaveRecord`) against a
 * real EncryptionCore + fake-IndexedDB adapter:
 *
 *   - Round-trip edit of a plain chat row, with the previous ciphertext blob
 *     backed up under `admin_edit_backup:<table>:<id>`.
 *   - Compressed message rows stay compressed after an edit (per-row "GZ"
 *     sniff, not per-table assumption).
 *   - `app_metadata` rows edit their plaintext `unencryptedData` payload.
 *   - RECORD_NOT_FOUND / RECORD_NOT_EDITABLE / INVALID_PARAMS refusals.
 *   - LOOPS_RUNNING guard on save.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { GremlinServer } from '../GremlinServer';
import { LoopRegistry } from '../LoopRegistry';
import type { BackendDeps } from '../backendDeps';
import { EncryptionCore } from '../../services/encryption/encryptionCore';
import { UnifiedStorage } from '../../services/storage/unifiedStorage';
import { IndexedDBAdapter } from '../../../worker/adapters/IndexedDBAdapter';
import { Tables } from '../../services/storage/StorageAdapter';
import { ClientSideToolRegistry } from '../../services/tools/clientSideTools';
import { APIService } from '../../services/api/apiService';
import type { Chat, Message } from '../../protocol/types';

const CEK_BYTES = new Uint8Array(32).fill(9);

function bytesToBase32(bytes: Uint8Array): string {
  const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
  let bits = 0;
  let value = 0;
  let result = '';
  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | bytes[i];
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      result += ALPHABET[(value >>> bits) & 0x1f];
    }
  }
  if (bits > 0) {
    result += ALPHABET[(value << (5 - bits)) & 0x1f];
  }
  return result;
}

async function buildServer(): Promise<{
  server: GremlinServer;
  deps: BackendDeps;
  encryption: EncryptionCore;
}> {
  const encryption = new EncryptionCore();
  await encryption.initializeWithCEK(bytesToBase32(CEK_BYTES));
  const adapter = new IndexedDBAdapter();
  const storage = new UnifiedStorage(adapter, encryption);
  const toolRegistry = new ClientSideToolRegistry();
  const apiService = new APIService({ storage, toolRegistry, encryption });
  const loopRegistry = new LoopRegistry();
  const deps: BackendDeps = { storage, encryption, apiService, toolRegistry, loopRegistry };
  const server = new GremlinServer(deps);
  await server.handleRequest('init', {});
  return { server, deps, encryption };
}

function makeChat(id: string): Chat {
  return {
    id,
    projectId: 'proj_1',
    name: 'Editable Chat',
    createdAt: new Date(),
    lastModifiedAt: new Date(),
    lastUsedAt: new Date(),
    messageCount: 0,
  } as unknown as Chat;
}

function makeMessage(id: string): Message<unknown> {
  return {
    id,
    role: 'assistant',
    content: { type: 'text', content: 'original text' },
    timestamp: new Date(),
  } as unknown as Message<unknown>;
}

describe('admin record editor', () => {
  beforeEach(async () => {
    const adapter = new IndexedDBAdapter();
    await adapter.initialize();
    await adapter.clearAll();
  });

  it('round-trips a plain chat row edit and backs up the previous blob', async () => {
    const { server, deps } = await buildServer();
    await deps.storage.saveChat(makeChat('chat_edit'));
    const originalRow = await deps.storage.getAdapter().get(Tables.CHATS, 'chat_edit');

    const view = await server.handleRequest('adminGetRecord', {
      table: 'chats',
      id: 'chat_edit',
    });
    expect(view.encrypted).toBe(true);
    expect(view.compressed).toBe(false);
    const parsed = JSON.parse(view.json);
    expect(parsed.name).toBe('Editable Chat');

    parsed.name = 'Repaired Chat';
    await server.handleRequest('adminSaveRecord', {
      table: 'chats',
      id: 'chat_edit',
      json: JSON.stringify(parsed),
    });

    const reloaded = await deps.storage.getChat('chat_edit');
    expect(reloaded?.name).toBe('Repaired Chat');
    // Backup carries the pre-edit ciphertext blob, restorable by hand.
    const backup = await deps.storage.getMetadata('admin_edit_backup:chats:chat_edit');
    expect(backup).toBe(originalRow?.encryptedData);
  });

  it('keeps compressed message rows compressed after an edit', async () => {
    const { server, deps } = await buildServer();
    await deps.storage.saveMessage('chat_1', makeMessage('msg_edit'));

    const view = await server.handleRequest('adminGetRecord', {
      table: 'messages',
      id: 'msg_edit',
    });
    expect(view.compressed).toBe(true);
    expect(view.parentId).toBe('chat_1');
    const parsed = JSON.parse(view.json);
    parsed.content.content = 'edited text';
    await server.handleRequest('adminSaveRecord', {
      table: 'messages',
      id: 'msg_edit',
      json: JSON.stringify(parsed),
    });

    const after = await server.handleRequest('adminGetRecord', {
      table: 'messages',
      id: 'msg_edit',
    });
    expect(after.compressed).toBe(true);
    expect(JSON.parse(after.json).content.content).toBe('edited text');
    const messages = await deps.storage.getMessages('chat_1');
    expect(messages[0]?.content).toMatchObject({ content: 'edited text' });
  });

  it('edits app_metadata rows via their plaintext payload', async () => {
    const { server, deps } = await buildServer();
    await deps.storage.setMetadata('some_flag', 'before');

    const view = await server.handleRequest('adminGetRecord', {
      table: 'app_metadata',
      id: 'some_flag',
    });
    expect(view.encrypted).toBe(false);
    expect(JSON.parse(view.json)).toEqual({ value: 'before' });

    await server.handleRequest('adminSaveRecord', {
      table: 'app_metadata',
      id: 'some_flag',
      json: JSON.stringify({ value: 'after' }),
    });
    expect(await deps.storage.getMetadata('some_flag')).toBe('after');
    expect(await deps.storage.getMetadata('admin_edit_backup:app_metadata:some_flag')).toBe(
      JSON.stringify({ value: 'before' })
    );
  });

  it('rejects a missing record with RECORD_NOT_FOUND', async () => {
    const { server } = await buildServer();
    await expect(
      server.handleRequest('adminGetRecord', { table: 'chats', id: 'nope' })
    ).rejects.toMatchObject({ code: 'RECORD_NOT_FOUND' });
    await expect(
      server.handleRequest('adminSaveRecord', { table: 'chats', id: 'nope', json: '{}' })
    ).rejects.toMatchObject({ code: 'RECORD_NOT_FOUND' });
  });

  it('refuses non-JSON payloads with RECORD_NOT_EDITABLE', async () => {
    const { server, deps, encryption } = await buildServer();
    // A validly-encrypted but binary (non-JSON) payload — the vfs_files shape.
    const blob = await encryption.encryptBytes(new Uint8Array([0, 1, 2, 3]));
    await deps.storage.getAdapter().save(Tables.VFS_FILES, 'bin_1', blob, {});
    await expect(
      server.handleRequest('adminGetRecord', { table: 'vfs_files', id: 'bin_1' })
    ).rejects.toMatchObject({ code: 'RECORD_NOT_EDITABLE' });

    // An undecryptable blob (wrong key / corrupt) is refused the same way.
    await deps.storage.getAdapter().save(Tables.CHATS, 'corrupt_1', 'not-a-ciphertext', {});
    await expect(
      server.handleRequest('adminGetRecord', { table: 'chats', id: 'corrupt_1' })
    ).rejects.toMatchObject({ code: 'RECORD_NOT_EDITABLE' });
  });

  it('rejects invalid edited JSON with INVALID_PARAMS', async () => {
    const { server, deps } = await buildServer();
    await deps.storage.saveChat(makeChat('chat_json'));
    await expect(
      server.handleRequest('adminSaveRecord', { table: 'chats', id: 'chat_json', json: '{oops' })
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
  });

  it('refuses to save while a loop is active (LOOPS_RUNNING)', async () => {
    const { server, deps } = await buildServer();
    await deps.storage.saveChat(makeChat('chat_busy'));
    server.registry.register(
      {
        loopId: 'live_edit',
        chatId: 'c1',
        startedAt: Date.now(),
        status: 'running',
        apiDefinitionId: 'api_1',
        modelId: 'm1',
      },
      new AbortController()
    );
    await expect(
      server.handleRequest('adminSaveRecord', { table: 'chats', id: 'chat_busy', json: '{}' })
    ).rejects.toMatchObject({ code: 'LOOPS_RUNNING' });
  });
});
