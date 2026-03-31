import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RemoteVfsAdapter } from '../remoteVfsAdapter';

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Mock encryptionService
vi.mock('../../encryption/encryptionService', () => ({
  encryptionService: {
    encrypt: vi.fn((content: string) => `encrypted:${content}`),
    decrypt: vi.fn((content: string) =>
      content.startsWith('encrypted:') ? content.slice(10) : content
    ),
  },
}));

function jsonResponse(data: unknown, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
    arrayBuffer: () => Promise.resolve(new TextEncoder().encode(JSON.stringify(data)).buffer),
  });
}

function textResponse(text: string, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve({}),
    text: () => Promise.resolve(text),
    arrayBuffer: () => Promise.resolve(new TextEncoder().encode(text).buffer),
  });
}

function emptyResponse(status = 204) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve({}),
    text: () => Promise.resolve(''),
  });
}

describe('RemoteVfsAdapter', () => {
  let adapter: RemoteVfsAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new RemoteVfsAdapter('http://localhost:3003', 'testuser', 'pass', 'proj1', false);
  });

  describe('readDir', () => {
    it('returns mapped entries from server', async () => {
      mockFetch.mockReturnValueOnce(
        jsonResponse({
          entries: [
            { name: 'docs', type: 'dir', size: 0, mtime: 1000 },
            { name: 'file.txt', type: 'file', size: 42, mtime: 2000 },
          ],
        })
      );

      const entries = await adapter.readDir('/');
      expect(entries).toHaveLength(2);
      expect(entries[0].name).toBe('docs');
      expect(entries[0].type).toBe('dir');
      expect(entries[1].name).toBe('file.txt');
      expect(entries[1].size).toBe(42);
    });
  });

  describe('readFile', () => {
    it('returns text content', async () => {
      mockFetch.mockReturnValueOnce(textResponse('hello world'));

      const content = await adapter.readFile('/test.txt');
      expect(content).toBe('hello world');
    });
  });

  describe('writeFile', () => {
    it('sends PUT request with body', async () => {
      mockFetch.mockReturnValueOnce(emptyResponse());

      await adapter.writeFile('/test.txt', 'content');

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/write'),
        expect.objectContaining({ method: 'PUT' })
      );
    });
  });

  describe('createFile', () => {
    it('sends PUT with createOnly=true', async () => {
      mockFetch.mockReturnValueOnce(emptyResponse());

      await adapter.createFile('/new.txt', 'content');

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain('createOnly=true');
    });

    it('throws FILE_EXISTS on 409', async () => {
      mockFetch.mockReturnValueOnce(emptyResponse(409));

      await expect(adapter.createFile('/exists.txt', 'content')).rejects.toThrow(
        'File already exists'
      );
    });
  });

  describe('deleteFile', () => {
    it('sends DELETE request', async () => {
      mockFetch.mockReturnValueOnce(emptyResponse());

      await adapter.deleteFile('/test.txt');

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/rm'),
        expect.objectContaining({ method: 'DELETE' })
      );
    });
  });

  describe('exists', () => {
    it('returns true when server says exists', async () => {
      mockFetch.mockReturnValueOnce(jsonResponse({ exists: true }));

      const result = await adapter.exists('/test.txt');
      expect(result).toBe(true);
    });

    it('returns false when server says not exists', async () => {
      mockFetch.mockReturnValueOnce(jsonResponse({ exists: false }));

      const result = await adapter.exists('/nope.txt');
      expect(result).toBe(false);
    });
  });

  describe('isDirectory', () => {
    it('returns true for root', async () => {
      const result = await adapter.isDirectory('/');
      expect(result).toBe(true);
    });
  });

  describe('orphan management', () => {
    it('listOrphans returns empty array', async () => {
      const orphans = await adapter.listOrphans();
      expect(orphans).toEqual([]);
    });
  });

  describe('versioning', () => {
    it('listVersions returns mapped versions', async () => {
      mockFetch.mockReturnValueOnce(
        jsonResponse({
          versions: [
            { version: 1, createdAt: 1000 },
            { version: 2, createdAt: 2000 },
          ],
        })
      );

      const versions = await adapter.listVersions('/test.txt');
      expect(versions).toHaveLength(2);
      expect(versions[0].version).toBe(1);
    });

    it('getVersion returns content', async () => {
      mockFetch.mockReturnValueOnce(textResponse('old content'));

      const content = await adapter.getVersion('/test.txt', 1);
      expect(content).toBe('old content');
    });
  });

  describe('compound ops without encryption', () => {
    it('strReplace calls server endpoint', async () => {
      mockFetch.mockReturnValueOnce(jsonResponse({ editLine: 2, snippet: 'new' }));

      const result = await adapter.strReplace('/test.txt', 'old', 'new');
      expect(result.editLine).toBe(2);
    });

    it('insert calls server endpoint', async () => {
      mockFetch.mockReturnValueOnce(jsonResponse({ insertedAt: 3 }));

      const result = await adapter.insert('/test.txt', 3, 'new line');
      expect(result.insertedAt).toBe(3);
    });

    it('appendFile calls server endpoint', async () => {
      mockFetch.mockReturnValueOnce(jsonResponse({ created: false }));

      const result = await adapter.appendFile('/test.txt', 'more text');
      expect(result.created).toBe(false);
    });
  });

  describe('with encryption', () => {
    let encAdapter: RemoteVfsAdapter;

    beforeEach(() => {
      encAdapter = new RemoteVfsAdapter('http://localhost:3003', 'testuser', 'pass', 'proj1', true);
    });

    it('encrypts content on write', async () => {
      mockFetch.mockReturnValueOnce(emptyResponse());

      await encAdapter.writeFile('/test.txt', 'secret');

      // Verify fetch was called
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/write'),
        expect.objectContaining({ method: 'PUT' })
      );
      // Body is a Blob containing encrypted content
      const body = mockFetch.mock.calls[0][1].body;
      expect(body).toBeInstanceOf(Blob);
    });

    it('decrypts content on read', async () => {
      mockFetch.mockReturnValueOnce(textResponse('encrypted:secret'));

      const content = await encAdapter.readFile('/test.txt');
      expect(content).toBe('secret');
    });

    it('strReplace uses client-side fallback', async () => {
      // Read call returns encrypted content
      mockFetch.mockReturnValueOnce(textResponse('encrypted:hello old world'));
      // Write call
      mockFetch.mockReturnValueOnce(emptyResponse());

      const result = await encAdapter.strReplace('/test.txt', 'old', 'new');
      expect(result.editLine).toBe(1);

      // Verify write was called with encrypted new content
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe('auth header', () => {
    it('sends Basic Auth with userId and password', async () => {
      mockFetch.mockReturnValueOnce(jsonResponse({ exists: true }));

      await adapter.exists('/test.txt');

      const headers = mockFetch.mock.calls[0][1].headers;
      const expectedAuth = 'Basic ' + btoa('testuser:pass');
      expect(headers.Authorization).toBe(expectedAuth);
    });
  });

  describe('getAdapter integration', () => {
    it('getFileId returns path for existing file', async () => {
      mockFetch.mockReturnValueOnce(jsonResponse({ exists: true }));

      const fileId = await adapter.getFileId('/test.txt');
      expect(fileId).toBe('/test.txt');
    });

    it('getFileId returns null for non-existing file', async () => {
      mockFetch.mockReturnValueOnce(jsonResponse({ exists: false }));

      const fileId = await adapter.getFileId('/nope.txt');
      expect(fileId).toBeNull();
    });
  });
});
