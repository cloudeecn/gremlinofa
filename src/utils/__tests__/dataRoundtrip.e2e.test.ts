/**
 * E2E Roundtrip Tests for Cross-Adapter Export/Import
 *
 * Tests actual data flow between IndexedDBAdapter (fake-indexeddb) and
 * RemoteStorageAdapter (live storage-backend server).
 *
 * Uses real EncryptionService for encryption/decryption.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import net from 'net';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';

import { IndexedDBAdapter } from '../../services/storage/adapters/IndexedDBAdapter';
import { RemoteStorageAdapter } from '../../services/storage/adapters/RemoteStorageAdapter';
import { Tables } from '../../services/storage/StorageAdapter';
import { EncryptionService } from '../../services/encryption/encryptionService';
import { exportDataToCSV } from '../dataExport';
import { importDataFromFile } from '../dataImport';

// Polyfill FileReader for Node.js environment (needed by csvHelper.ts)
class NodeFileReader {
  result: ArrayBuffer | null = null;
  onload: (() => void) | null = null;
  onerror: ((error: Error) => void) | null = null;
  error: Error | null = null;

  readAsArrayBuffer(blob: Blob) {
    blob
      .arrayBuffer()
      .then(buffer => {
        this.result = buffer;
        if (this.onload) this.onload();
      })
      .catch(err => {
        this.error = err;
        if (this.onerror) this.onerror(err);
      });
  }
}
globalThis.FileReader = NodeFileReader as unknown as typeof FileReader;

// Test credentials for RemoteStorageAdapter
const TEST_USER_ID = 'e2e-roundtrip-a1b2c3d4e5f6789012345678901234567890123456789012345678901234';
const TEST_PASSWORD = 'e2e-roundtrip-password';

// Test CEK for encryption (base32 format - 52 chars = 32 bytes)
const TEST_CEK = 'abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrst';

/**
 * Create a File object from CSV string (works in Node.js)
 */
function createFileFromCSV(csvContent: string, filename: string = 'export.csv'): File {
  const blob = new Blob([csvContent], { type: 'text/csv' });
  return new File([blob], filename, { type: 'text/csv' });
}

describe('Cross-Adapter E2E Roundtrip', () => {
  let serverProcess: ChildProcess | null = null;
  let port: number;
  let tempDbPath: string;
  let remoteAdapter: RemoteStorageAdapter;
  let indexedDBAdapter: IndexedDBAdapter;
  let encryptionService: EncryptionService;

  /**
   * Find an unused port by binding to port 0 and getting the assigned port
   */
  async function findUnusedPort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = net.createServer();
      server.listen(0, () => {
        const address = server.address();
        if (!address || typeof address === 'string') {
          reject(new Error('Failed to get port'));
          return;
        }
        const { port } = address;
        server.close(() => resolve(port));
      });
      server.on('error', reject);
    });
  }

  /**
   * Wait for server to be ready by polling /health
   */
  async function waitForServer(url: string, timeoutMs = 15000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const response = await fetch(`${url}/health`);
        if (response.ok) {
          const data = await response.json();
          if (data.status === 'ok') {
            return;
          }
        }
      } catch {
        // Server not ready yet, keep polling
      }
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error(`Server failed to start within ${timeoutMs}ms`);
  }

  /**
   * Cleanup function for process exit
   */
  function cleanup() {
    if (serverProcess) {
      serverProcess.kill('SIGKILL');
      serverProcess = null;
    }
    if (tempDbPath && fs.existsSync(tempDbPath)) {
      try {
        fs.unlinkSync(tempDbPath);
        const walPath = tempDbPath + '-wal';
        const shmPath = tempDbPath + '-shm';
        if (fs.existsSync(walPath)) fs.unlinkSync(walPath);
        if (fs.existsSync(shmPath)) fs.unlinkSync(shmPath);
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  beforeAll(async () => {
    // --- Set up fake-indexeddb ---
    globalThis.indexedDB = new IDBFactory();
    globalThis.IDBKeyRange = IDBKeyRange;

    // --- Set up encryption service ---
    encryptionService = new EncryptionService();
    await encryptionService.initializeWithCEK(TEST_CEK);

    // --- Start storage-backend server ---
    port = await findUnusedPort();
    tempDbPath = path.join(os.tmpdir(), `gremlinofa-roundtrip-e2e-${Date.now()}.db`);

    const backendDir = path.resolve(process.cwd(), 'storage-backend');
    serverProcess = spawn('npx', ['tsx', 'src/index.ts'], {
      cwd: backendDir,
      env: {
        ...process.env,
        PORT: String(port),
        DB_PATH: tempDbPath,
        CORS_ORIGIN: '*',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    serverProcess.stdout?.on('data', data => {
      stdout += data.toString();
    });
    serverProcess.stderr?.on('data', data => {
      stderr += data.toString();
    });

    serverProcess.on('exit', code => {
      if (code !== null && code !== 0) {
        console.error(`Server exited with code ${code}`);
        console.error('stdout:', stdout);
        console.error('stderr:', stderr);
      }
    });

    process.on('exit', cleanup);
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);

    const baseUrl = `http://localhost:${port}`;
    await waitForServer(baseUrl);

    // --- Create adapters ---
    remoteAdapter = new RemoteStorageAdapter(baseUrl, TEST_USER_ID, TEST_PASSWORD);
    await remoteAdapter.initialize();

    indexedDBAdapter = new IndexedDBAdapter();
    await indexedDBAdapter.initialize();
  }, 30000);

  afterAll(async () => {
    process.removeListener('exit', cleanup);
    process.removeListener('SIGINT', cleanup);
    process.removeListener('SIGTERM', cleanup);

    if (serverProcess) {
      serverProcess.kill('SIGTERM');
      await new Promise<void>(resolve => {
        const timeout = setTimeout(() => {
          serverProcess?.kill('SIGKILL');
          resolve();
        }, 2000);

        serverProcess?.on('exit', () => {
          clearTimeout(timeout);
          resolve();
        });
      });
      serverProcess = null;
    }

    if (tempDbPath && fs.existsSync(tempDbPath)) {
      try {
        fs.unlinkSync(tempDbPath);
        const walPath = tempDbPath + '-wal';
        const shmPath = tempDbPath + '-shm';
        if (fs.existsSync(walPath)) fs.unlinkSync(walPath);
        if (fs.existsSync(shmPath)) fs.unlinkSync(shmPath);
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  beforeEach(async () => {
    // Clear both adapters before each test
    await remoteAdapter.clearAll();
    await indexedDBAdapter.clearAll();
  });

  describe('IndexedDB → Remote Storage', () => {
    it('should export from IndexedDB and import to Remote Storage', async () => {
      // Seed IndexedDB with test data
      const projectData = JSON.stringify({ name: 'Test Project', icon: '🚀' });
      const chatData = JSON.stringify({ title: 'Test Chat' });
      const messageData = JSON.stringify({ role: 'user', content: 'Hello world' });

      await indexedDBAdapter.save(
        Tables.PROJECTS,
        'proj-idb-1',
        await encryptionService.encrypt(projectData),
        {
          timestamp: '2024-01-01T10:00:00Z',
        }
      );
      await indexedDBAdapter.save(
        Tables.CHATS,
        'chat-idb-1',
        await encryptionService.encrypt(chatData),
        {
          timestamp: '2024-01-01T11:00:00Z',
          parentId: 'proj-idb-1',
        }
      );
      await indexedDBAdapter.save(
        Tables.MESSAGES,
        'msg-idb-1',
        await encryptionService.encrypt(messageData),
        {
          timestamp: '2024-01-01T12:00:00Z',
          parentId: 'chat-idb-1',
        }
      );

      // Export from IndexedDB
      const csv = await exportDataToCSV(indexedDBAdapter);
      expect(csv).toContain('proj-idb-1');
      expect(csv).toContain('chat-idb-1');
      expect(csv).toContain('msg-idb-1');

      // Import to Remote Storage
      const file = createFileFromCSV(csv);
      const result = await importDataFromFile(remoteAdapter, file, TEST_CEK, encryptionService);

      expect(result.imported).toBe(3);
      expect(result.skipped).toBe(0);
      expect(result.errors).toHaveLength(0);

      // Verify data in Remote Storage
      const remoteProject = await remoteAdapter.get(Tables.PROJECTS, 'proj-idb-1');
      expect(remoteProject).not.toBeNull();
      const decryptedProject = JSON.parse(
        await encryptionService.decrypt(remoteProject!.encryptedData)
      );
      expect(decryptedProject.name).toBe('Test Project');

      const remoteChat = await remoteAdapter.get(Tables.CHATS, 'chat-idb-1');
      expect(remoteChat).not.toBeNull();

      const remoteMessage = await remoteAdapter.get(Tables.MESSAGES, 'msg-idb-1');
      expect(remoteMessage).not.toBeNull();
    });

    it('should preserve parent-child relationships', async () => {
      // Create parent-child hierarchy
      await indexedDBAdapter.save(
        Tables.PROJECTS,
        'proj-parent',
        await encryptionService.encrypt('{}'),
        {
          timestamp: '2024-01-01T00:00:00Z',
        }
      );
      await indexedDBAdapter.save(
        Tables.CHATS,
        'chat-child-1',
        await encryptionService.encrypt('{}'),
        {
          timestamp: '2024-01-01T01:00:00Z',
          parentId: 'proj-parent',
        }
      );
      await indexedDBAdapter.save(
        Tables.CHATS,
        'chat-child-2',
        await encryptionService.encrypt('{}'),
        {
          timestamp: '2024-01-01T02:00:00Z',
          parentId: 'proj-parent',
        }
      );
      await indexedDBAdapter.save(Tables.MESSAGES, 'msg-1', await encryptionService.encrypt('{}'), {
        timestamp: '2024-01-01T03:00:00Z',
        parentId: 'chat-child-1',
      });

      // Export and import
      const csv = await exportDataToCSV(indexedDBAdapter);
      const file = createFileFromCSV(csv);
      await importDataFromFile(remoteAdapter, file, TEST_CEK, encryptionService);

      // Query by parentId to verify relationships preserved
      const chats = await remoteAdapter.query(Tables.CHATS, { parentId: 'proj-parent' });
      expect(chats).toHaveLength(2);

      const messages = await remoteAdapter.query(Tables.MESSAGES, { parentId: 'chat-child-1' });
      expect(messages).toHaveLength(1);
    });
  });

  describe('Remote Storage → IndexedDB', () => {
    it('should export from Remote Storage and import to IndexedDB', async () => {
      // Seed Remote Storage with test data
      const projectData = JSON.stringify({ name: 'Remote Project', icon: '🌐' });
      const chatData = JSON.stringify({ title: 'Remote Chat' });

      await remoteAdapter.save(
        Tables.PROJECTS,
        'proj-remote-1',
        await encryptionService.encrypt(projectData),
        {
          timestamp: '2024-02-01T10:00:00Z',
        }
      );
      await remoteAdapter.save(
        Tables.CHATS,
        'chat-remote-1',
        await encryptionService.encrypt(chatData),
        {
          timestamp: '2024-02-01T11:00:00Z',
          parentId: 'proj-remote-1',
        }
      );

      // Export from Remote Storage
      const csv = await exportDataToCSV(remoteAdapter);
      expect(csv).toContain('proj-remote-1');
      expect(csv).toContain('chat-remote-1');

      // Import to IndexedDB
      const file = createFileFromCSV(csv);
      const result = await importDataFromFile(indexedDBAdapter, file, TEST_CEK, encryptionService);

      expect(result.imported).toBe(2);
      expect(result.errors).toHaveLength(0);

      // Verify data in IndexedDB
      const idbProject = await indexedDBAdapter.get(Tables.PROJECTS, 'proj-remote-1');
      expect(idbProject).not.toBeNull();
      const decryptedProject = JSON.parse(
        await encryptionService.decrypt(idbProject!.encryptedData)
      );
      expect(decryptedProject.name).toBe('Remote Project');

      const idbChat = await indexedDBAdapter.get(Tables.CHATS, 'chat-remote-1');
      expect(idbChat).not.toBeNull();
    });
  });

  describe('Bidirectional sync', () => {
    it('should preserve data integrity through A → B → A roundtrip', async () => {
      // Create original data in IndexedDB
      const originalProject = { name: 'Bidirectional Test', icon: '🔄', version: 1 };
      const originalMessage = { role: 'user', content: 'Original message content' };

      await indexedDBAdapter.save(
        Tables.PROJECTS,
        'proj-bidir',
        await encryptionService.encrypt(JSON.stringify(originalProject)),
        {
          timestamp: '2024-03-01T10:00:00Z',
          unencryptedData: '{"flags":["test"]}',
        }
      );
      await indexedDBAdapter.save(
        Tables.MESSAGES,
        'msg-bidir',
        await encryptionService.encrypt(JSON.stringify(originalMessage)),
        {
          timestamp: '2024-03-01T11:00:00Z',
          parentId: 'chat-bidir',
        }
      );

      // Step 1: IndexedDB → Remote
      const csv1 = await exportDataToCSV(indexedDBAdapter);
      await importDataFromFile(remoteAdapter, createFileFromCSV(csv1), TEST_CEK, encryptionService);

      // Clear IndexedDB
      await indexedDBAdapter.clearAll();
      expect(await indexedDBAdapter.count(Tables.PROJECTS)).toBe(0);

      // Step 2: Remote → IndexedDB (back to original)
      const csv2 = await exportDataToCSV(remoteAdapter);
      await importDataFromFile(
        indexedDBAdapter,
        createFileFromCSV(csv2),
        TEST_CEK,
        encryptionService
      );

      // Verify data integrity after full roundtrip
      const finalProject = await indexedDBAdapter.get(Tables.PROJECTS, 'proj-bidir');
      expect(finalProject).not.toBeNull();
      const decryptedProject = JSON.parse(
        await encryptionService.decrypt(finalProject!.encryptedData)
      );
      expect(decryptedProject).toEqual(originalProject);
      expect(finalProject!.unencryptedData).toBe('{"flags":["test"]}');

      const finalMessage = await indexedDBAdapter.get(Tables.MESSAGES, 'msg-bidir');
      expect(finalMessage).not.toBeNull();
      const decryptedMessage = JSON.parse(
        await encryptionService.decrypt(finalMessage!.encryptedData)
      );
      expect(decryptedMessage).toEqual(originalMessage);
    });
  });

  describe('Large dataset pagination', () => {
    it('should handle datasets exceeding page limits (250+ records)', async () => {
      // Insert 250 messages into IndexedDB
      const promises = [];
      for (let i = 0; i < 250; i++) {
        const messageData = JSON.stringify({ content: `Message ${i}`, index: i });
        promises.push(
          indexedDBAdapter.save(
            Tables.MESSAGES,
            `msg-large-${String(i).padStart(5, '0')}`,
            await encryptionService.encrypt(messageData),
            {
              timestamp: new Date(Date.now() + i * 1000).toISOString(),
              parentId: 'chat-large',
            }
          )
        );
      }
      await Promise.all(promises);

      // Verify count before export
      expect(await indexedDBAdapter.count(Tables.MESSAGES)).toBe(250);

      // Export from IndexedDB (should use pagination internally)
      const csv = await exportDataToCSV(indexedDBAdapter);
      const lineCount = csv.split('\n').filter(line => line.includes('msg-large-')).length;
      expect(lineCount).toBe(250);

      // Import to Remote Storage
      const file = createFileFromCSV(csv);
      const result = await importDataFromFile(remoteAdapter, file, TEST_CEK, encryptionService);

      expect(result.imported).toBe(250);
      expect(result.errors).toHaveLength(0);

      // Verify all records in Remote Storage
      const remoteCount = await remoteAdapter.count(Tables.MESSAGES);
      expect(remoteCount).toBe(250);

      // Verify data integrity for a few records
      const msg0 = await remoteAdapter.get(Tables.MESSAGES, 'msg-large-00000');
      expect(msg0).not.toBeNull();
      const decrypted0 = JSON.parse(await encryptionService.decrypt(msg0!.encryptedData));
      expect(decrypted0.content).toBe('Message 0');

      const msg249 = await remoteAdapter.get(Tables.MESSAGES, 'msg-large-00249');
      expect(msg249).not.toBeNull();
      const decrypted249 = JSON.parse(await encryptionService.decrypt(msg249!.encryptedData));
      expect(decrypted249.content).toBe('Message 249');
    }, 60000); // Allow 60 seconds for large dataset test
  });

  describe('Re-encryption with different CEKs', () => {
    it('should re-encrypt data when importing with different CEK', async () => {
      // Create a different CEK for the source (base32 format - 52 chars)
      const sourceCEK = 'stuvwxyz234567abcdefghijklmnopqrstuvwxyz234567abcdef';
      const sourceEncryption = new EncryptionService();
      await sourceEncryption.initializeWithCEK(sourceCEK);

      // Encrypt data with source CEK and store in IndexedDB
      const originalData = { name: 'Re-encryption Test', secret: 'sensitive data' };
      await indexedDBAdapter.save(
        Tables.PROJECTS,
        'proj-reencrypt',
        await sourceEncryption.encrypt(JSON.stringify(originalData)),
        {
          timestamp: '2024-04-01T10:00:00Z',
        }
      );

      // Export from IndexedDB (data encrypted with source CEK)
      const csv = await exportDataToCSV(indexedDBAdapter);

      // Import to Remote Storage with different CEK (app's encryptionService)
      // This should re-encrypt the data
      const file = createFileFromCSV(csv);
      const result = await importDataFromFile(remoteAdapter, file, sourceCEK, encryptionService);

      expect(result.imported).toBe(1);
      expect(result.errors).toHaveLength(0);

      // Verify data can be decrypted with the app's CEK (not source CEK)
      const remoteProject = await remoteAdapter.get(Tables.PROJECTS, 'proj-reencrypt');
      expect(remoteProject).not.toBeNull();

      // Should be decryptable with app's encryption service
      const decrypted = JSON.parse(await encryptionService.decrypt(remoteProject!.encryptedData));
      expect(decrypted).toEqual(originalData);

      // Should NOT be decryptable with source encryption (different CEK)
      await expect(sourceEncryption.decrypt(remoteProject!.encryptedData)).rejects.toThrow();
    });
  });

  describe('Skip existing records', () => {
    it('should skip existing records during import', async () => {
      // Pre-populate Remote Storage with some records
      const existingData = JSON.stringify({ name: 'Existing', version: 1 });
      await remoteAdapter.save(
        Tables.PROJECTS,
        'proj-existing',
        await encryptionService.encrypt(existingData),
        {
          timestamp: '2024-05-01T00:00:00Z',
        }
      );

      // Create data in IndexedDB including a record with same ID
      const newData = JSON.stringify({ name: 'New from IDB', version: 2 });
      const conflictData = JSON.stringify({ name: 'Conflict from IDB', version: 99 });

      await indexedDBAdapter.save(
        Tables.PROJECTS,
        'proj-new',
        await encryptionService.encrypt(newData),
        {
          timestamp: '2024-05-01T01:00:00Z',
        }
      );
      await indexedDBAdapter.save(
        Tables.PROJECTS,
        'proj-existing',
        await encryptionService.encrypt(conflictData),
        {
          timestamp: '2024-05-01T02:00:00Z',
        }
      );

      // Export and import
      const csv = await exportDataToCSV(indexedDBAdapter);
      const result = await importDataFromFile(
        remoteAdapter,
        createFileFromCSV(csv),
        TEST_CEK,
        encryptionService
      );

      expect(result.imported).toBe(1); // Only new record
      expect(result.skipped).toBe(1); // Existing record skipped

      // Verify existing record was NOT overwritten
      const existingProject = await remoteAdapter.get(Tables.PROJECTS, 'proj-existing');
      const decrypted = JSON.parse(await encryptionService.decrypt(existingProject!.encryptedData));
      expect(decrypted.name).toBe('Existing'); // Original value, not 'Conflict from IDB'
      expect(decrypted.version).toBe(1);

      // Verify new record was imported
      const newProject = await remoteAdapter.get(Tables.PROJECTS, 'proj-new');
      expect(newProject).not.toBeNull();
    });
  });
});
