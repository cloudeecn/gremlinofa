/**
 * E2E tests for RemoteStorageAdapter
 *
 * Spins up a real storage-backend instance and tests all CRUD operations.
 * Uses a temporary database file that gets cleaned up after tests.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import net from 'net';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { RemoteStorageAdapter } from '../adapters/RemoteStorageAdapter';
import { Tables } from '../StorageAdapter';

// Test credentials
const TEST_USER_ID = 'e2e-test-user-a1b2c3d4e5f6789012345678901234567890123456789012345678901234';
const TEST_PASSWORD = 'e2e-test-password';

describe('RemoteStorageAdapter E2E', () => {
  let serverProcess: ChildProcess | null = null;
  let port: number;
  let adapter: RemoteStorageAdapter;
  let tempDbPath: string;

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
    // Clean up temp database
    if (tempDbPath && fs.existsSync(tempDbPath)) {
      try {
        fs.unlinkSync(tempDbPath);
        // Also remove WAL and SHM files if they exist
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
    // Find unused port
    port = await findUnusedPort();

    // Create temp database path
    tempDbPath = path.join(os.tmpdir(), `gremlinofa-e2e-test-${Date.now()}.db`);

    // Path to storage-backend source
    const backendDir = path.resolve(process.cwd(), 'storage-backend');

    // Start storage-backend process using tsx (no build required)
    serverProcess = spawn('npx', ['tsx', 'src/index.ts'], {
      cwd: backendDir,
      env: {
        ...process.env,
        PORT: String(port),
        DB_PATH: tempDbPath,
        CORS_ORIGIN: '*', // Allow requests from tests
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Collect stdout/stderr for debugging
    let stdout = '';
    let stderr = '';
    serverProcess.stdout?.on('data', data => {
      stdout += data.toString();
    });
    serverProcess.stderr?.on('data', data => {
      stderr += data.toString();
    });

    // Handle unexpected exit
    serverProcess.on('exit', code => {
      if (code !== null && code !== 0) {
        console.error(`Server exited with code ${code}`);
        console.error('stdout:', stdout);
        console.error('stderr:', stderr);
      }
    });

    // Register cleanup handlers
    process.on('exit', cleanup);
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);

    // Wait for server to be ready
    const baseUrl = `http://localhost:${port}`;
    await waitForServer(baseUrl);

    // Create adapter
    adapter = new RemoteStorageAdapter(baseUrl, TEST_USER_ID, TEST_PASSWORD);
    await adapter.initialize();
  }, 30000); // 30 second timeout for server startup

  afterAll(async () => {
    // Remove cleanup handlers to prevent double-cleanup
    process.removeListener('exit', cleanup);
    process.removeListener('SIGINT', cleanup);
    process.removeListener('SIGTERM', cleanup);

    // Graceful shutdown
    if (serverProcess) {
      serverProcess.kill('SIGTERM');
      // Wait for process to exit
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

    // Clean up temp database
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
    // Clean up data between tests
    await adapter.clearAll();
  });

  describe('Save and Get operations', () => {
    const testTables = Object.values(Tables);

    it.each(testTables)('should save and retrieve a record on %s', async table => {
      const testId = `test-id-${Date.now()}`;
      const testData = 'encrypted-data-content';
      const testTimestamp = new Date().toISOString();

      // Save
      await adapter.save(table, testId, testData, {
        timestamp: testTimestamp,
      });

      // Retrieve
      const result = await adapter.get(table, testId);
      expect(result).toEqual({
        encryptedData: testData,
        unencryptedData: undefined,
      });
    });

    it('should return null for non-existent record', async () => {
      const result = await adapter.get(Tables.PROJECTS, 'non-existent-id');
      expect(result).toBeNull();
    });

    it('should save record with unencryptedData', async () => {
      const testId = 'proj-with-meta';
      const testData = 'encrypted-stuff';
      const unencryptedMeta = '{"version":2,"flags":["test"]}';

      await adapter.save(Tables.PROJECTS, testId, testData, {
        timestamp: new Date().toISOString(),
        unencryptedData: unencryptedMeta,
      });

      const result = await adapter.get(Tables.PROJECTS, testId);
      expect(result).toEqual({
        encryptedData: testData,
        unencryptedData: unencryptedMeta,
      });
    });

    it('should update existing record (upsert)', async () => {
      const testId = 'update-test';

      // First save
      await adapter.save(Tables.PROJECTS, testId, 'version-1', {
        timestamp: new Date().toISOString(),
      });

      // Update
      await adapter.save(Tables.PROJECTS, testId, 'version-2', {
        timestamp: new Date().toISOString(),
      });

      // Verify update
      const result = await adapter.get(Tables.PROJECTS, testId);
      expect(result?.encryptedData).toBe('version-2');
    });
  });

  describe('Query operations', () => {
    beforeEach(async () => {
      // Create test data with parent relationships
      await adapter.save(Tables.MESSAGES, 'msg-1', 'message-1-data', {
        timestamp: '2024-01-01T00:00:00Z',
        parentId: 'chat-a',
      });
      await adapter.save(Tables.MESSAGES, 'msg-2', 'message-2-data', {
        timestamp: '2024-01-02T00:00:00Z',
        parentId: 'chat-a',
      });
      await adapter.save(Tables.MESSAGES, 'msg-3', 'message-3-data', {
        timestamp: '2024-01-03T00:00:00Z',
        parentId: 'chat-b',
      });
    });

    it('should query all records from a table', async () => {
      const results = await adapter.query(Tables.MESSAGES);
      expect(results).toHaveLength(3);
    });

    it('should query by parentId', async () => {
      const results = await adapter.query(Tables.MESSAGES, { parentId: 'chat-a' });
      expect(results).toHaveLength(2);
      expect(results.map(r => r.encryptedData).sort()).toEqual([
        'message-1-data',
        'message-2-data',
      ]);
    });

    it('should order by timestamp descending by default', async () => {
      const results = await adapter.query(Tables.MESSAGES, { parentId: 'chat-a' });
      // Newest first
      expect(results[0].encryptedData).toBe('message-2-data');
      expect(results[1].encryptedData).toBe('message-1-data');
    });

    it('should order by timestamp ascending when specified', async () => {
      const results = await adapter.query(Tables.MESSAGES, {
        parentId: 'chat-a',
        orderDirection: 'asc',
      });
      // Oldest first
      expect(results[0].encryptedData).toBe('message-1-data');
      expect(results[1].encryptedData).toBe('message-2-data');
    });
  });

  describe('Delete operations', () => {
    it('should delete a single record', async () => {
      await adapter.save(Tables.PROJECTS, 'to-delete', 'data', {
        timestamp: new Date().toISOString(),
      });

      await adapter.delete(Tables.PROJECTS, 'to-delete');

      const result = await adapter.get(Tables.PROJECTS, 'to-delete');
      expect(result).toBeNull();
    });

    it('should delete multiple records by parentId', async () => {
      // Create data
      await adapter.save(Tables.MESSAGES, 'msg-1', 'data', {
        timestamp: new Date().toISOString(),
        parentId: 'chat-to-delete',
      });
      await adapter.save(Tables.MESSAGES, 'msg-2', 'data', {
        timestamp: new Date().toISOString(),
        parentId: 'chat-to-delete',
      });
      await adapter.save(Tables.MESSAGES, 'msg-3', 'data', {
        timestamp: new Date().toISOString(),
        parentId: 'chat-keep',
      });

      // Delete by parentId
      await adapter.deleteMany(Tables.MESSAGES, { parentId: 'chat-to-delete' });

      // Verify
      const count = await adapter.count(Tables.MESSAGES);
      expect(count).toBe(1);

      const remaining = await adapter.get(Tables.MESSAGES, 'msg-3');
      expect(remaining).not.toBeNull();
    });
  });

  describe('Count operations', () => {
    beforeEach(async () => {
      await adapter.save(Tables.MESSAGES, 'msg-1', 'data', {
        timestamp: new Date().toISOString(),
        parentId: 'parent-1',
      });
      await adapter.save(Tables.MESSAGES, 'msg-2', 'data', {
        timestamp: new Date().toISOString(),
        parentId: 'parent-1',
      });
      await adapter.save(Tables.MESSAGES, 'msg-3', 'data', {
        timestamp: new Date().toISOString(),
        parentId: 'parent-2',
      });
    });

    it('should count all records in a table', async () => {
      const count = await adapter.count(Tables.MESSAGES);
      expect(count).toBe(3);
    });

    it('should count by parentId', async () => {
      const count = await adapter.count(Tables.MESSAGES, { parentId: 'parent-1' });
      expect(count).toBe(2);
    });
  });

  describe('Clear all operations', () => {
    it('should clear all data for the user', async () => {
      // Create data in multiple tables
      await adapter.save(Tables.PROJECTS, 'proj-1', 'data', {
        timestamp: new Date().toISOString(),
      });
      await adapter.save(Tables.CHATS, 'chat-1', 'data', {
        timestamp: new Date().toISOString(),
      });
      await adapter.save(Tables.MESSAGES, 'msg-1', 'data', {
        timestamp: new Date().toISOString(),
      });

      // Clear all
      await adapter.clearAll();

      // Verify all cleared
      for (const table of Object.values(Tables)) {
        const count = await adapter.count(table);
        expect(count).toBe(0);
      }
    });
  });

  describe('Multi-tenancy isolation', () => {
    it('should isolate data between users', async () => {
      // Create a second adapter with different userId
      const otherUserId = 'other-user-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
      const otherAdapter = new RemoteStorageAdapter(
        `http://localhost:${port}`,
        otherUserId,
        'other-password'
      );
      await otherAdapter.initialize();

      // Primary user creates a project
      await adapter.save(Tables.PROJECTS, 'shared-id', 'user-a-data', {
        timestamp: new Date().toISOString(),
      });

      // Other user creates a project with same ID
      await otherAdapter.save(Tables.PROJECTS, 'shared-id', 'user-b-data', {
        timestamp: new Date().toISOString(),
      });

      // Verify isolation
      const userAResult = await adapter.get(Tables.PROJECTS, 'shared-id');
      const userBResult = await otherAdapter.get(Tables.PROJECTS, 'shared-id');

      expect(userAResult?.encryptedData).toBe('user-a-data');
      expect(userBResult?.encryptedData).toBe('user-b-data');

      // Clean up other user's data
      await otherAdapter.clearAll();
    });

    it('should not allow cross-user data access', async () => {
      const otherUserId = 'sneaky-user-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
      const otherAdapter = new RemoteStorageAdapter(
        `http://localhost:${port}`,
        otherUserId,
        'sneaky-password'
      );
      await otherAdapter.initialize();

      // Primary user creates a secret project
      await adapter.save(Tables.PROJECTS, 'secret-project', 'sensitive-data', {
        timestamp: new Date().toISOString(),
      });

      // Other user tries to access it
      const result = await otherAdapter.get(Tables.PROJECTS, 'secret-project');
      expect(result).toBeNull();

      // Clean up
      await otherAdapter.clearAll();
    });
  });

  describe('Error handling', () => {
    it('should throw on deleteMany without parentId', async () => {
      await expect(adapter.deleteMany(Tables.MESSAGES, {})).rejects.toThrow(
        'parentId is required for deleteMany'
      );
    });
  });

  describe('Export with columns operations', () => {
    beforeEach(async () => {
      // Create test data
      await adapter.save(Tables.MESSAGES, 'msg-1', 'encrypted-msg-1', {
        timestamp: '2024-01-01T10:00:00Z',
        parentId: 'chat-1',
        unencryptedData: '{"read":true}',
      });
      await adapter.save(Tables.MESSAGES, 'msg-2', 'encrypted-msg-2', {
        timestamp: '2024-01-02T10:00:00Z',
        parentId: 'chat-1',
      });
      await adapter.save(Tables.MESSAGES, 'msg-3', 'encrypted-msg-3', {
        timestamp: '2024-01-03T10:00:00Z',
        parentId: 'chat-2',
      });
    });

    it('should export all columns by default', async () => {
      const result = await adapter.exportPaginated(Tables.MESSAGES);
      expect(result.rows).toHaveLength(3);
      // All columns should be present
      const row = result.rows.find(r => r.id === 'msg-1');
      expect(row).toBeDefined();
      expect(row?.encryptedData).toBe('encrypted-msg-1');
      expect(row?.timestamp).toBe('2024-01-01T10:00:00Z');
      expect(row?.parentId).toBe('chat-1');
      expect(row?.unencryptedData).toBe('{"read":true}');
    });

    it('should export only specified columns', async () => {
      const result = await adapter.exportPaginated(Tables.MESSAGES, undefined, [
        'id',
        'timestamp',
        'parentId',
      ]);
      expect(result.rows).toHaveLength(3);
      // Only requested columns should be present
      const row = result.rows.find(r => r.id === 'msg-1');
      expect(row).toBeDefined();
      expect(row?.id).toBe('msg-1');
      expect(row?.timestamp).toBe('2024-01-01T10:00:00Z');
      expect(row?.parentId).toBe('chat-1');
      // encryptedData and unencryptedData should NOT be present
      expect(row?.encryptedData).toBeUndefined();
      expect(row?.unencryptedData).toBeUndefined();
    });

    it('should support columns with pagination (afterId)', async () => {
      const result = await adapter.exportPaginated(Tables.MESSAGES, 'msg-1', ['id', 'parentId']);
      // Should only return records after msg-1 (sorted by id)
      expect(result.rows.length).toBeGreaterThanOrEqual(2);
      // First row should NOT be msg-1
      expect(result.rows.every(r => r.id !== 'msg-1')).toBe(true);
      // Only requested columns
      result.rows.forEach(row => {
        expect(row.id).toBeDefined();
        expect(row.parentId).toBeDefined();
        expect(row.encryptedData).toBeUndefined();
      });
    });
  });

  describe('Batch get operations', () => {
    beforeEach(async () => {
      // Create test data
      await adapter.save(Tables.PROJECTS, 'proj-1', 'encrypted-proj-1', {
        timestamp: '2024-01-01T10:00:00Z',
        unencryptedData: '{"name":"Project 1"}',
      });
      await adapter.save(Tables.PROJECTS, 'proj-2', 'encrypted-proj-2', {
        timestamp: '2024-01-02T10:00:00Z',
        unencryptedData: '{"name":"Project 2"}',
      });
      await adapter.save(Tables.PROJECTS, 'proj-3', 'encrypted-proj-3', {
        timestamp: '2024-01-03T10:00:00Z',
        unencryptedData: '{"name":"Project 3"}',
      });
    });

    it('should batch get multiple records by IDs', async () => {
      const result = await adapter.batchGet(Tables.PROJECTS, ['proj-1', 'proj-3']);
      expect(result.rows).toHaveLength(2);

      const proj1 = result.rows.find(r => r.id === 'proj-1');
      const proj3 = result.rows.find(r => r.id === 'proj-3');

      expect(proj1?.encryptedData).toBe('encrypted-proj-1');
      expect(proj3?.encryptedData).toBe('encrypted-proj-3');
    });

    it('should return only found IDs (missing IDs silently omitted)', async () => {
      const result = await adapter.batchGet(Tables.PROJECTS, [
        'proj-1',
        'non-existent-id',
        'proj-2',
      ]);
      expect(result.rows).toHaveLength(2);
      expect(result.rows.map(r => r.id).sort()).toEqual(['proj-1', 'proj-2']);
    });

    it('should return empty array for all non-existent IDs', async () => {
      const result = await adapter.batchGet(Tables.PROJECTS, [
        'fake-id-1',
        'fake-id-2',
        'fake-id-3',
      ]);
      expect(result.rows).toHaveLength(0);
    });

    it('should batch get with column filtering', async () => {
      const result = await adapter.batchGet(
        Tables.PROJECTS,
        ['proj-1', 'proj-2'],
        ['id', 'timestamp']
      );
      expect(result.rows).toHaveLength(2);

      result.rows.forEach(row => {
        expect(row.id).toBeDefined();
        expect(row.timestamp).toBeDefined();
        // encryptedData should NOT be present
        expect(row.encryptedData).toBeUndefined();
        expect(row.parentId).toBeUndefined();
        expect(row.unencryptedData).toBeUndefined();
      });
    });

    it('should return empty array for empty IDs without API call', async () => {
      const result = await adapter.batchGet(Tables.PROJECTS, []);
      expect(result.rows).toHaveLength(0);
    });
  });
});
