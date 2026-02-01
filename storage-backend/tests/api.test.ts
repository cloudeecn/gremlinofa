/**
 * Integration tests for the storage backend API
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express, { type Express } from 'express';
import { initDatabase, closeDatabase, getDatabase } from '../src/db.js';
import { basicAuth, cors } from '../src/middleware.js';
import { router } from '../src/routes.js';

// Test helpers
const TEST_USER = 'test-user-123';
const TEST_AUTH = 'Basic ' + Buffer.from(`${TEST_USER}:password`).toString('base64');

let app: Express;

/**
 * Make a test request
 */
async function request(
  method: 'GET' | 'PUT' | 'DELETE' | 'POST',
  path: string,
  body?: object,
  auth = TEST_AUTH
): Promise<{ status: number; body: unknown }> {
  // Using native fetch for simplicity
  const url = `http://localhost:${testPort}${path}`;
  const headers: Record<string, string> = {
    Authorization: auth,
  };

  if (body) {
    headers['Content-Type'] = 'application/json';
  }

  const response = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  let responseBody: unknown = null;
  const contentType = response.headers.get('content-type');
  if (contentType?.includes('application/json')) {
    responseBody = await response.json();
  }

  return { status: response.status, body: responseBody };
}

let server: ReturnType<typeof app.listen>;
let testPort: number;

beforeAll(async () => {
  // DB_PATH=:memory: is set in vitest.config.ts env before modules load

  // Initialize database
  initDatabase();

  // Create test app
  app = express();
  app.use(cors);
  app.use('/api', basicAuth);
  app.use('/api', router);
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));

  // Start server on random port
  await new Promise<void>(resolve => {
    server = app.listen(0, () => {
      testPort = (server.address() as { port: number }).port;
      resolve();
    });
  });
});

afterAll(() => {
  server?.close();
  closeDatabase();
});

beforeEach(() => {
  // Clear all data between tests
  const db = getDatabase();
  db.exec('DELETE FROM records');
});

describe('Authentication', () => {
  it('should reject requests without auth', async () => {
    const response = await fetch(`http://localhost:${testPort}/api/projects`);
    expect(response.status).toBe(401);
  });

  it('should accept requests with valid Basic Auth', async () => {
    const { status } = await request('GET', '/api/projects');
    expect(status).toBe(200);
  });

  it('should allow health check without auth', async () => {
    const response = await fetch(`http://localhost:${testPort}/health`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ status: 'ok' });
  });
});

describe('Table Validation', () => {
  it('should reject invalid table names', async () => {
    const { status, body } = await request('GET', '/api/invalid_table');
    expect(status).toBe(400);
    expect(body).toEqual({ error: 'Invalid table: invalid_table' });
  });

  it('should accept valid table names', async () => {
    const tables = ['projects', 'chats', 'messages', 'attachments', 'api_definitions'];
    for (const table of tables) {
      const { status } = await request('GET', `/api/${table}`);
      expect(status).toBe(200);
    }
  });
});

describe('CRUD Operations', () => {
  it('should save and retrieve a record', async () => {
    // Save
    const { status: saveStatus } = await request('PUT', '/api/projects/proj_1', {
      encryptedData: 'encrypted-content-here',
      timestamp: '2024-01-01T00:00:00Z',
    });
    expect(saveStatus).toBe(204);

    // Retrieve
    const { status: getStatus, body } = await request('GET', '/api/projects/proj_1');
    expect(getStatus).toBe(200);
    expect(body).toEqual({
      encryptedData: 'encrypted-content-here',
      timestamp: '2024-01-01T00:00:00Z',
    });
  });

  it('should return 404 for non-existent record', async () => {
    const { status } = await request('GET', '/api/projects/nonexistent');
    expect(status).toBe(404);
  });

  it('should update existing record (upsert)', async () => {
    // First save
    await request('PUT', '/api/projects/proj_1', {
      encryptedData: 'version1',
    });

    // Update
    await request('PUT', '/api/projects/proj_1', {
      encryptedData: 'version2',
    });

    // Verify update
    const { body } = await request('GET', '/api/projects/proj_1');
    expect(body).toEqual({ encryptedData: 'version2' });
  });

  it('should delete a record', async () => {
    // Create
    await request('PUT', '/api/projects/proj_1', { encryptedData: 'data' });

    // Delete
    const { status } = await request('DELETE', '/api/projects/proj_1');
    expect(status).toBe(204);

    // Verify deleted
    const { status: getStatus } = await request('GET', '/api/projects/proj_1');
    expect(getStatus).toBe(404);
  });
});

describe('Query Operations', () => {
  beforeEach(async () => {
    // Create test data
    await request('PUT', '/api/messages/msg_1', {
      encryptedData: 'message1',
      parentId: 'chat_a',
      timestamp: '2024-01-01T00:00:00Z',
    });
    await request('PUT', '/api/messages/msg_2', {
      encryptedData: 'message2',
      parentId: 'chat_a',
      timestamp: '2024-01-02T00:00:00Z',
    });
    await request('PUT', '/api/messages/msg_3', {
      encryptedData: 'message3',
      parentId: 'chat_b',
      timestamp: '2024-01-03T00:00:00Z',
    });
  });

  it('should query all records in a table', async () => {
    const { status, body } = await request('GET', '/api/messages');
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
    expect((body as []).length).toBe(3);
  });

  it('should query by parentId', async () => {
    const { body } = await request('GET', '/api/messages?parentId=chat_a');
    expect(Array.isArray(body)).toBe(true);
    expect((body as []).length).toBe(2);
  });

  it('should order by timestamp descending by default', async () => {
    const { body } = await request('GET', '/api/messages?parentId=chat_a');
    const messages = body as Array<{ encryptedData: string }>;
    expect(messages[0].encryptedData).toBe('message2'); // newer first
    expect(messages[1].encryptedData).toBe('message1');
  });

  it('should order by timestamp ascending when specified', async () => {
    const { body } = await request('GET', '/api/messages?parentId=chat_a&orderDirection=asc');
    const messages = body as Array<{ encryptedData: string }>;
    expect(messages[0].encryptedData).toBe('message1'); // older first
    expect(messages[1].encryptedData).toBe('message2');
  });
});

describe('Count Operations', () => {
  beforeEach(async () => {
    await request('PUT', '/api/messages/msg_1', {
      encryptedData: 'data',
      parentId: 'chat_a',
    });
    await request('PUT', '/api/messages/msg_2', {
      encryptedData: 'data',
      parentId: 'chat_a',
    });
    await request('PUT', '/api/messages/msg_3', {
      encryptedData: 'data',
      parentId: 'chat_b',
    });
  });

  it('should count all records in a table', async () => {
    const { body } = await request('GET', '/api/messages/_count');
    expect(body).toEqual({ count: 3 });
  });

  it('should count by parentId', async () => {
    const { body } = await request('GET', '/api/messages/_count?parentId=chat_a');
    expect(body).toEqual({ count: 2 });
  });
});

describe('Delete Many Operations', () => {
  beforeEach(async () => {
    await request('PUT', '/api/messages/msg_1', {
      encryptedData: 'data',
      parentId: 'chat_a',
    });
    await request('PUT', '/api/messages/msg_2', {
      encryptedData: 'data',
      parentId: 'chat_a',
    });
    await request('PUT', '/api/messages/msg_3', {
      encryptedData: 'data',
      parentId: 'chat_b',
    });
  });

  it('should require parentId for bulk delete', async () => {
    const { status, body } = await request('DELETE', '/api/messages');
    expect(status).toBe(400);
    expect(body).toEqual({ error: 'parentId query parameter is required for bulk delete' });
  });

  it('should delete by parentId', async () => {
    const { status } = await request('DELETE', '/api/messages?parentId=chat_a');
    expect(status).toBe(204);

    // Verify only chat_a messages deleted
    const { body } = await request('GET', '/api/messages/_count');
    expect(body).toEqual({ count: 1 });
  });
});

describe('Clear All Operations', () => {
  it('should clear all records for user', async () => {
    // Create data in multiple tables
    await request('PUT', '/api/projects/proj_1', { encryptedData: 'data' });
    await request('PUT', '/api/chats/chat_1', { encryptedData: 'data' });
    await request('PUT', '/api/messages/msg_1', { encryptedData: 'data' });

    // Clear all
    const { status } = await request('POST', '/api/_clear-all');
    expect(status).toBe(204);

    // Verify all cleared
    const { body: projects } = await request('GET', '/api/projects');
    const { body: chats } = await request('GET', '/api/chats');
    const { body: messages } = await request('GET', '/api/messages');
    expect((projects as []).length).toBe(0);
    expect((chats as []).length).toBe(0);
    expect((messages as []).length).toBe(0);
  });
});

describe('Multi-tenancy', () => {
  const USER_A_AUTH = 'Basic ' + Buffer.from('user_a:pass').toString('base64');
  const USER_B_AUTH = 'Basic ' + Buffer.from('user_b:pass').toString('base64');

  it('should isolate data between users', async () => {
    // User A creates a project
    await request('PUT', '/api/projects/proj_1', { encryptedData: 'user_a_data' }, USER_A_AUTH);

    // User B creates a project with same ID
    await request('PUT', '/api/projects/proj_1', { encryptedData: 'user_b_data' }, USER_B_AUTH);

    // Verify isolation
    const { body: userAData } = await request(
      'GET',
      '/api/projects/proj_1',
      undefined,
      USER_A_AUTH
    );
    const { body: userBData } = await request(
      'GET',
      '/api/projects/proj_1',
      undefined,
      USER_B_AUTH
    );

    expect(userAData).toEqual({ encryptedData: 'user_a_data' });
    expect(userBData).toEqual({ encryptedData: 'user_b_data' });
  });

  it('should not allow cross-user data access', async () => {
    // User A creates a project
    await request('PUT', '/api/projects/proj_secret', { encryptedData: 'secret' }, USER_A_AUTH);

    // User B tries to access it
    const { status } = await request('GET', '/api/projects/proj_secret', undefined, USER_B_AUTH);
    expect(status).toBe(404);
  });
});

describe('Unencrypted Data', () => {
  it('should store and return unencryptedData', async () => {
    await request('PUT', '/api/projects/proj_1', {
      encryptedData: 'encrypted-stuff',
      unencryptedData: '{"version": 2, "flags": ["test"]}',
    });

    const { body } = await request('GET', '/api/projects/proj_1');
    expect(body).toEqual({
      encryptedData: 'encrypted-stuff',
      unencryptedData: '{"version": 2, "flags": ["test"]}',
    });
  });
});

describe('Export Operations', () => {
  beforeEach(async () => {
    // Create test data with various IDs (sorted alphabetically: a, b, c)
    await request('PUT', '/api/messages/msg_b', {
      encryptedData: 'data_b',
      parentId: 'chat_1',
      timestamp: '2024-01-02T00:00:00Z',
    });
    await request('PUT', '/api/messages/msg_a', {
      encryptedData: 'data_a',
      parentId: 'chat_1',
      timestamp: '2024-01-01T00:00:00Z',
    });
    await request('PUT', '/api/messages/msg_c', {
      encryptedData: 'data_c',
      parentId: 'chat_2',
      timestamp: '2024-01-03T00:00:00Z',
      unencryptedData: '{"extra": true}',
    });
  });

  it('should export all records sorted by id', async () => {
    const { status, body } = await request('GET', '/api/messages/_export');
    expect(status).toBe(200);

    const result = body as { rows: Array<{ id: string }>; hasMore: boolean };
    expect(result.hasMore).toBe(false);
    expect(result.rows.length).toBe(3);
    // Verify sorted by id
    expect(result.rows[0].id).toBe('msg_a');
    expect(result.rows[1].id).toBe('msg_b');
    expect(result.rows[2].id).toBe('msg_c');
  });

  it('should include all columns in export', async () => {
    const { body } = await request('GET', '/api/messages/_export');
    const result = body as {
      rows: Array<{
        id: string;
        encryptedData: string;
        parentId?: string;
        timestamp?: string;
        unencryptedData?: string;
      }>;
    };

    // Check first row has expected fields
    expect(result.rows[0]).toEqual({
      id: 'msg_a',
      encryptedData: 'data_a',
      parentId: 'chat_1',
      timestamp: '2024-01-01T00:00:00Z',
    });

    // Check row with unencryptedData
    expect(result.rows[2]).toEqual({
      id: 'msg_c',
      encryptedData: 'data_c',
      parentId: 'chat_2',
      timestamp: '2024-01-03T00:00:00Z',
      unencryptedData: '{"extra": true}',
    });
  });

  it('should paginate with afterId cursor', async () => {
    // Get first page (after nothing = from start)
    const { body: page1 } = await request('GET', '/api/messages/_export');
    const result1 = page1 as { rows: Array<{ id: string }>; hasMore: boolean };
    expect(result1.rows.length).toBe(3);

    // Get page after msg_a
    const { body: page2 } = await request('GET', '/api/messages/_export?afterId=msg_a');
    const result2 = page2 as { rows: Array<{ id: string }>; hasMore: boolean };
    expect(result2.rows.length).toBe(2);
    expect(result2.rows[0].id).toBe('msg_b');
    expect(result2.rows[1].id).toBe('msg_c');

    // Get page after msg_b
    const { body: page3 } = await request('GET', '/api/messages/_export?afterId=msg_b');
    const result3 = page3 as { rows: Array<{ id: string }>; hasMore: boolean };
    expect(result3.rows.length).toBe(1);
    expect(result3.rows[0].id).toBe('msg_c');

    // Get page after msg_c (should be empty)
    const { body: page4 } = await request('GET', '/api/messages/_export?afterId=msg_c');
    const result4 = page4 as { rows: Array<{ id: string }>; hasMore: boolean };
    expect(result4.rows.length).toBe(0);
    expect(result4.hasMore).toBe(false);
  });

  it('should return hasMore=true when more records exist', async () => {
    // Create 201 records to exceed the 200 limit
    for (let i = 0; i < 201; i++) {
      await request('PUT', `/api/projects/proj_${String(i).padStart(3, '0')}`, {
        encryptedData: `data_${i}`,
      });
    }

    const { body } = await request('GET', '/api/projects/_export');
    const result = body as { rows: Array<{ id: string }>; hasMore: boolean };
    expect(result.rows.length).toBe(200);
    expect(result.hasMore).toBe(true);

    // Get next page
    const lastId = result.rows[199].id;
    const { body: page2 } = await request('GET', `/api/projects/_export?afterId=${lastId}`);
    const result2 = page2 as { rows: Array<{ id: string }>; hasMore: boolean };
    expect(result2.rows.length).toBe(1);
    expect(result2.hasMore).toBe(false);
  });

  it('should return empty array for empty table', async () => {
    const { body } = await request('GET', '/api/projects/_export');
    const result = body as { rows: []; hasMore: boolean };
    expect(result.rows).toEqual([]);
    expect(result.hasMore).toBe(false);
  });
});

describe('Export with Columns Operations', () => {
  beforeEach(async () => {
    // Create test data with all fields populated
    await request('PUT', '/api/messages/msg_1', {
      encryptedData: 'encrypted_data_1',
      parentId: 'chat_a',
      timestamp: '2024-01-01T00:00:00Z',
      unencryptedData: '{"version": 1}',
    });
    await request('PUT', '/api/messages/msg_2', {
      encryptedData: 'encrypted_data_2',
      parentId: 'chat_a',
      timestamp: '2024-01-02T00:00:00Z',
    });
  });

  it('should export all columns when no columns param is provided', async () => {
    const { body } = await request('GET', '/api/messages/_export');
    const result = body as {
      rows: Array<{ id: string; encryptedData?: string; timestamp?: string; parentId?: string }>;
    };
    expect(result.rows[0]).toHaveProperty('id');
    expect(result.rows[0]).toHaveProperty('encryptedData');
    expect(result.rows[0]).toHaveProperty('timestamp');
    expect(result.rows[0]).toHaveProperty('parentId');
  });

  it('should export only requested columns', async () => {
    const { body } = await request('GET', '/api/messages/_export?columns=id,timestamp');
    const result = body as {
      rows: Array<{ id?: string; encryptedData?: string; timestamp?: string; parentId?: string }>;
    };

    // Should have requested columns
    expect(result.rows[0]).toHaveProperty('id');
    expect(result.rows[0]).toHaveProperty('timestamp');

    // Should NOT have unrequested columns
    expect(result.rows[0]).not.toHaveProperty('encryptedData');
    expect(result.rows[0]).not.toHaveProperty('parentId');
  });

  it('should export metadata only (without encryptedData)', async () => {
    const { body } = await request('GET', '/api/messages/_export?columns=id,timestamp,parentId');
    const result = body as { rows: Array<Record<string, string>> };

    expect(result.rows.length).toBe(2);
    expect(result.rows[0]).toEqual({
      id: 'msg_1',
      timestamp: '2024-01-01T00:00:00Z',
      parentId: 'chat_a',
    });
    expect(result.rows[0]).not.toHaveProperty('encryptedData');
  });

  it('should reject invalid column names', async () => {
    const { status, body } = await request(
      'GET',
      '/api/messages/_export?columns=id,invalid_column'
    );
    expect(status).toBe(400);
    expect(body).toEqual({ error: 'Invalid column: invalid_column' });
  });

  it('should handle columns with pagination', async () => {
    // Create enough records to test pagination
    for (let i = 3; i <= 5; i++) {
      await request('PUT', `/api/messages/msg_${i}`, {
        encryptedData: `data_${i}`,
        timestamp: `2024-01-0${i}T00:00:00Z`,
      });
    }

    const { body: page1 } = await request('GET', '/api/messages/_export?columns=id,timestamp');
    const result1 = page1 as { rows: Array<{ id: string; timestamp: string }>; hasMore: boolean };

    expect(result1.rows.length).toBe(5);
    expect(result1.rows[0]).not.toHaveProperty('encryptedData');
    expect(result1.hasMore).toBe(false);
  });
});

describe('Batch Get Operations', () => {
  beforeEach(async () => {
    // Create test data
    await request('PUT', '/api/messages/msg_a', {
      encryptedData: 'data_a',
      parentId: 'chat_1',
      timestamp: '2024-01-01T00:00:00Z',
    });
    await request('PUT', '/api/messages/msg_b', {
      encryptedData: 'data_b',
      parentId: 'chat_1',
      timestamp: '2024-01-02T00:00:00Z',
      unencryptedData: '{"extra": true}',
    });
    await request('PUT', '/api/messages/msg_c', {
      encryptedData: 'data_c',
      parentId: 'chat_2',
      timestamp: '2024-01-03T00:00:00Z',
    });
  });

  it('should get multiple records by IDs', async () => {
    const { status, body } = await request('GET', '/api/messages/_batch?ids=msg_a,msg_c');
    expect(status).toBe(200);

    const result = body as { rows: Array<{ id: string; encryptedData: string }> };
    expect(result.rows.length).toBe(2);

    const ids = result.rows.map(r => r.id).sort();
    expect(ids).toEqual(['msg_a', 'msg_c']);
  });

  it('should return all columns by default', async () => {
    const { body } = await request('GET', '/api/messages/_batch?ids=msg_b');
    const result = body as { rows: Array<Record<string, string>> };

    expect(result.rows.length).toBe(1);
    expect(result.rows[0]).toEqual({
      id: 'msg_b',
      encryptedData: 'data_b',
      parentId: 'chat_1',
      timestamp: '2024-01-02T00:00:00Z',
      unencryptedData: '{"extra": true}',
    });
  });

  it('should return only requested columns', async () => {
    const { body } = await request(
      'GET',
      '/api/messages/_batch?ids=msg_a,msg_b&columns=id,timestamp'
    );
    const result = body as { rows: Array<Record<string, string>> };

    expect(result.rows.length).toBe(2);
    // Should have only requested columns
    for (const row of result.rows) {
      expect(row).toHaveProperty('id');
      expect(row).toHaveProperty('timestamp');
      expect(row).not.toHaveProperty('encryptedData');
      expect(row).not.toHaveProperty('parentId');
    }
  });

  it('should silently omit missing IDs', async () => {
    const { status, body } = await request(
      'GET',
      '/api/messages/_batch?ids=msg_a,nonexistent,msg_c'
    );
    expect(status).toBe(200);

    const result = body as { rows: Array<{ id: string }> };
    expect(result.rows.length).toBe(2);

    const ids = result.rows.map(r => r.id).sort();
    expect(ids).toEqual(['msg_a', 'msg_c']);
  });

  it('should return empty array when no IDs match', async () => {
    const { status, body } = await request(
      'GET',
      '/api/messages/_batch?ids=nonexistent1,nonexistent2'
    );
    expect(status).toBe(200);
    expect(body).toEqual({ rows: [] });
  });

  it('should require ids parameter', async () => {
    const { status, body } = await request('GET', '/api/messages/_batch');
    expect(status).toBe(400);
    expect(body).toEqual({ error: 'ids query parameter is required' });
  });

  it('should reject empty ids parameter', async () => {
    const { status, body } = await request('GET', '/api/messages/_batch?ids=');
    expect(status).toBe(400);
    expect(body).toEqual({ error: 'ids query parameter is required' });
  });

  it('should reject too many IDs', async () => {
    // Create 201 IDs (over the 200 limit)
    const ids = Array.from({ length: 201 }, (_, i) => `id_${i}`).join(',');
    const { status, body } = await request('GET', `/api/messages/_batch?ids=${ids}`);
    expect(status).toBe(400);
    expect(body).toEqual({ error: 'Maximum 200 IDs per request' });
  });

  it('should reject invalid column names', async () => {
    const { status, body } = await request(
      'GET',
      '/api/messages/_batch?ids=msg_a&columns=id,invalid'
    );
    expect(status).toBe(400);
    expect(body).toEqual({ error: 'Invalid column: invalid' });
  });

  it('should handle whitespace in ids and columns', async () => {
    const { status, body } = await request(
      'GET',
      '/api/messages/_batch?ids=msg_a, msg_b &columns=id, timestamp'
    );
    expect(status).toBe(200);

    const result = body as { rows: Array<{ id: string; timestamp: string }> };
    expect(result.rows.length).toBe(2);
  });
});

describe('Batch Save Operations', () => {
  it('should batch save multiple records', async () => {
    const { status, body } = await request('POST', '/api/messages/_batch', {
      rows: [
        { id: 'msg_1', encryptedData: 'data_1', parentId: 'chat_a' },
        { id: 'msg_2', encryptedData: 'data_2', parentId: 'chat_a' },
        { id: 'msg_3', encryptedData: 'data_3', parentId: 'chat_b' },
      ],
    });

    expect(status).toBe(200);
    expect(body).toEqual({ saved: 3, skipped: 0 });

    // Verify all records were saved
    const { body: count } = await request('GET', '/api/messages/_count');
    expect(count).toEqual({ count: 3 });
  });

  it('should upsert by default (skipExisting=false)', async () => {
    // Create initial record
    await request('PUT', '/api/messages/msg_1', { encryptedData: 'original' });

    // Batch save with same id
    const { body } = await request('POST', '/api/messages/_batch', {
      rows: [
        { id: 'msg_1', encryptedData: 'updated' },
        { id: 'msg_2', encryptedData: 'new' },
      ],
      skipExisting: false,
    });

    expect(body).toEqual({ saved: 2, skipped: 0 });

    // Verify record was updated
    const { body: record } = await request('GET', '/api/messages/msg_1');
    expect(record).toEqual({ encryptedData: 'updated' });
  });

  it('should skip existing records when skipExisting=true', async () => {
    // Create initial record
    await request('PUT', '/api/messages/msg_1', { encryptedData: 'original' });

    // Batch save with skipExisting
    const { body } = await request('POST', '/api/messages/_batch', {
      rows: [
        { id: 'msg_1', encryptedData: 'should_be_skipped' },
        { id: 'msg_2', encryptedData: 'new' },
      ],
      skipExisting: true,
    });

    expect(body).toEqual({ saved: 1, skipped: 1 });

    // Verify original was preserved
    const { body: record } = await request('GET', '/api/messages/msg_1');
    expect(record).toEqual({ encryptedData: 'original' });
  });

  it('should save fields correctly', async () => {
    await request('POST', '/api/messages/_batch', {
      rows: [
        {
          id: 'msg_1',
          encryptedData: 'data',
          timestamp: '2024-01-15T10:30:00Z',
          parentId: 'chat_abc',
          unencryptedData: '{"version": 1}',
        },
      ],
    });

    // Export to verify metadata was stored
    const { body } = await request('GET', '/api/messages/_export');
    const result = body as { rows: Array<Record<string, string>> };
    expect(result.rows[0]).toEqual({
      id: 'msg_1',
      encryptedData: 'data',
      timestamp: '2024-01-15T10:30:00Z',
      parentId: 'chat_abc',
      unencryptedData: '{"version": 1}',
    });
  });

  it('should reject request without rows array', async () => {
    const { status, body } = await request('POST', '/api/messages/_batch', {});
    expect(status).toBe(400);
    expect(body).toEqual({ error: 'rows array is required' });
  });

  it('should reject rows missing required fields', async () => {
    const { status, body } = await request('POST', '/api/messages/_batch', {
      rows: [
        { id: 'msg_1', encryptedData: 'valid' },
        { id: 'msg_2' }, // missing encryptedData
      ],
    });
    expect(status).toBe(400);
    expect(body).toEqual({ error: 'Row 1 missing required id or encryptedData' });
  });

  it('should handle empty rows array', async () => {
    const { status, body } = await request('POST', '/api/messages/_batch', { rows: [] });
    expect(status).toBe(200);
    expect(body).toEqual({ saved: 0, skipped: 0 });
  });

  it('should be atomic (all or nothing on error)', async () => {
    // This test verifies transaction behavior - if we had validation that could
    // fail mid-batch, all changes should be rolled back. Currently we validate
    // upfront, but the transaction wrapping is still important for consistency.
    const { body } = await request('POST', '/api/messages/_batch', {
      rows: [
        { id: 'msg_1', encryptedData: 'data_1' },
        { id: 'msg_2', encryptedData: 'data_2' },
        { id: 'msg_3', encryptedData: 'data_3' },
      ],
    });

    expect(body).toEqual({ saved: 3, skipped: 0 });

    // All should be present
    const { body: exported } = await request('GET', '/api/messages/_export');
    expect((exported as { rows: [] }).rows.length).toBe(3);
  });
});
