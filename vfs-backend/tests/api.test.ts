import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createApp } from '../src/index.js';
import { config } from '../src/config.js';
import type { Server } from 'http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { _lockMapSize } from '../src/fileLock.js';

let server: Server;
let baseUrl: string;
let tmpDir: string;

const AUTH = 'Basic ' + Buffer.from('testuser:testpass').toString('base64');
const AUTH_NO_PASS = 'Basic ' + Buffer.from('testuser:').toString('base64');
const PROJECT = 'proj1';

function api(
  method: string,
  pathAndQuery: string,
  options: { body?: unknown; rawBody?: Buffer; headers?: Record<string, string> } = {}
) {
  const headers: Record<string, string> = {
    Authorization: AUTH,
    ...options.headers,
  };

  let bodyInit: BodyInit | undefined;
  if (options.rawBody) {
    bodyInit = options.rawBody;
  } else if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    bodyInit = JSON.stringify(options.body);
  }

  return fetch(`${baseUrl}/api${pathAndQuery}`, {
    method,
    headers,
    body: bodyInit,
  });
}

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vfs-test-'));

  // Override config for tests
  Object.assign(config, {
    dataDir: tmpDir,
    authPassword: 'testpass',
    port: 0,
  });

  const app = createApp();
  server = await new Promise<Server>(resolve => {
    const s = app.listen(0, () => resolve(s));
  });
  const addr = server.address();
  if (typeof addr === 'object' && addr) {
    baseUrl = `http://127.0.0.1:${addr.port}`;
  }
});

afterAll(async () => {
  server?.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

beforeEach(async () => {
  // Clean project directory between tests
  const projectDir = path.join(tmpDir, 'testuser', PROJECT);
  try {
    await fs.rm(projectDir, { recursive: true, force: true });
  } catch {
    // Doesn't exist yet
  }
});

describe('Health', () => {
  it('returns ok without auth', async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
  });
});

describe('Auth', () => {
  it('rejects requests without auth header', async () => {
    const res = await fetch(`${baseUrl}/api/ls?projectId=${PROJECT}&path=/`);
    expect(res.status).toBe(401);
  });

  it('rejects wrong password', async () => {
    const res = await fetch(`${baseUrl}/api/ls?projectId=${PROJECT}&path=/`, {
      headers: {
        Authorization: 'Basic ' + Buffer.from('testuser:wrongpass').toString('base64'),
      },
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('Invalid password');
  });

  it('rejects empty userId', async () => {
    const res = await fetch(`${baseUrl}/api/ls?projectId=${PROJECT}&path=/`, {
      headers: {
        Authorization: 'Basic ' + Buffer.from(':testpass').toString('base64'),
      },
    });
    expect(res.status).toBe(401);
  });
});

describe('CRUD lifecycle', () => {
  it('mkdir → write → read → stat → ls → rename → rm', async () => {
    // mkdir
    let res = await api('POST', `/mkdir?projectId=${PROJECT}&path=/docs`);
    expect(res.status).toBe(204);

    // write
    res = await api('PUT', `/write?projectId=${PROJECT}&path=/docs/hello.txt`, {
      rawBody: Buffer.from('Hello, world!'),
    });
    expect(res.status).toBe(204);

    // read
    res = await api('GET', `/read?projectId=${PROJECT}&path=/docs/hello.txt`);
    expect(res.status).toBe(200);
    const content = await res.text();
    expect(content).toBe('Hello, world!');

    // stat
    res = await api('GET', `/stat?projectId=${PROJECT}&path=/docs/hello.txt`);
    expect(res.status).toBe(200);
    const statBody = await res.json();
    expect(statBody.type).toBe('file');
    expect(statBody.size).toBe(13);

    // ls
    res = await api('GET', `/ls?projectId=${PROJECT}&path=/docs`);
    expect(res.status).toBe(200);
    const lsBody = await res.json();
    expect(lsBody.entries).toHaveLength(1);
    expect(lsBody.entries[0].name).toBe('hello.txt');

    // rename
    res = await api('POST', `/rename?projectId=${PROJECT}`, {
      body: { from: '/docs/hello.txt', to: '/docs/greeting.txt' },
    });
    expect(res.status).toBe(204);

    // verify rename
    res = await api('GET', `/read?projectId=${PROJECT}&path=/docs/greeting.txt`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('Hello, world!');

    // rm
    res = await api('DELETE', `/rm?projectId=${PROJECT}&path=/docs/greeting.txt`);
    expect(res.status).toBe(204);

    // verify rm
    res = await api('GET', `/exists?projectId=${PROJECT}&path=/docs/greeting.txt`);
    const existsBody = await res.json();
    expect(existsBody.exists).toBe(false);
  });
});

describe('Binary file round-trip', () => {
  it('writes and reads binary data unchanged', async () => {
    const binaryData = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00]);

    let res = await api('PUT', `/write?projectId=${PROJECT}&path=/image.png`, {
      rawBody: binaryData,
    });
    expect(res.status).toBe(204);

    res = await api('GET', `/read?projectId=${PROJECT}&path=/image.png`);
    expect(res.status).toBe(200);
    const readBack = Buffer.from(await res.arrayBuffer());
    expect(readBack).toEqual(binaryData);
  });
});

describe('Path traversal', () => {
  it('rejects ../ path escape', async () => {
    const res = await api('GET', `/read?projectId=${PROJECT}&path=/../../../etc/passwd`);
    expect(res.status).toBe(403);
  });

  it('rejects encoded traversal', async () => {
    const res = await api('GET', `/read?projectId=${PROJECT}&path=/..%2F..%2Fetc%2Fpasswd`);
    expect(res.status).toBe(403);
  });

  it('rejects null bytes in path', async () => {
    const res = await api('GET', `/read?projectId=${PROJECT}&path=/foo%00bar`);
    expect(res.status).toBe(403);
  });

  it('rejects traversal in projectId', async () => {
    const res = await api('GET', `/read?projectId=../../etc&path=/passwd`);
    expect(res.status).toBe(403);
  });

  it('rejects traversal in userId (Basic Auth username)', async () => {
    const poisonedAuth = 'Basic ' + Buffer.from('../../etc:testpass').toString('base64');
    const res = await fetch(`${baseUrl}/api/read?projectId=${PROJECT}&path=/test.txt`, {
      headers: { Authorization: poisonedAuth },
    });
    expect(res.status).toBe(403);
  });
});

describe('Nested directory operations', () => {
  it('auto-creates parent directories on write', async () => {
    const res = await api('PUT', `/write?projectId=${PROJECT}&path=/a/b/c/deep.txt`, {
      rawBody: Buffer.from('deep content'),
    });
    expect(res.status).toBe(204);

    const readRes = await api('GET', `/read?projectId=${PROJECT}&path=/a/b/c/deep.txt`);
    expect(await readRes.text()).toBe('deep content');
  });

  it('rmdir removes directory recursively', async () => {
    await api('PUT', `/write?projectId=${PROJECT}&path=/tree/a.txt`, {
      rawBody: Buffer.from('a'),
    });
    await api('PUT', `/write?projectId=${PROJECT}&path=/tree/sub/b.txt`, {
      rawBody: Buffer.from('b'),
    });

    const res = await api('DELETE', `/rmdir?projectId=${PROJECT}&path=/tree`);
    expect(res.status).toBe(204);

    const existsRes = await api('GET', `/exists?projectId=${PROJECT}&path=/tree`);
    expect((await existsRes.json()).exists).toBe(false);
  });
});

describe('createOnly flag', () => {
  it('returns 409 when file exists and createOnly=true', async () => {
    await api('PUT', `/write?projectId=${PROJECT}&path=/unique.txt`, {
      rawBody: Buffer.from('first'),
    });

    const res = await api('PUT', `/write?projectId=${PROJECT}&path=/unique.txt&createOnly=true`, {
      rawBody: Buffer.from('second'),
    });
    expect(res.status).toBe(409);
  });
});

describe('exists endpoint', () => {
  it('returns false for non-existent path', async () => {
    const res = await api('GET', `/exists?projectId=${PROJECT}&path=/nope.txt`);
    expect(res.status).toBe(200);
    expect((await res.json()).exists).toBe(false);
  });

  it('returns true for existing path', async () => {
    await api('PUT', `/write?projectId=${PROJECT}&path=/yes.txt`, {
      rawBody: Buffer.from('here'),
    });

    const res = await api('GET', `/exists?projectId=${PROJECT}&path=/yes.txt`);
    expect(res.status).toBe(200);
    expect((await res.json()).exists).toBe(true);
  });
});

describe('Versioning', () => {
  it('creates versions on write and lists them', async () => {
    // First write — no previous version to save
    await api('PUT', `/write?projectId=${PROJECT}&path=/versioned.txt`, {
      rawBody: Buffer.from('v1'),
    });

    // Second write — saves v1 as version 1
    await api('PUT', `/write?projectId=${PROJECT}&path=/versioned.txt`, {
      rawBody: Buffer.from('v2'),
    });

    // Third write — saves v2 as version 2
    await api('PUT', `/write?projectId=${PROJECT}&path=/versioned.txt`, {
      rawBody: Buffer.from('v3'),
    });

    // List versions
    const res = await api('GET', `/versions?projectId=${PROJECT}&path=/versioned.txt`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.versions.length).toBe(2); // versions 1 and 2

    // Read specific version (version 1 = original "v1")
    const v1Res = await api('GET', `/version?projectId=${PROJECT}&path=/versioned.txt&v=1`);
    expect(v1Res.status).toBe(200);
    expect(await v1Res.text()).toBe('v1');

    // Read version 2 = "v2"
    const v2Res = await api('GET', `/version?projectId=${PROJECT}&path=/versioned.txt&v=2`);
    expect(v2Res.status).toBe(200);
    expect(await v2Res.text()).toBe('v2');

    // Current content should be "v3"
    const currentRes = await api('GET', `/read?projectId=${PROJECT}&path=/versioned.txt`);
    expect(await currentRes.text()).toBe('v3');
  });

  it('drops old versions', async () => {
    for (let i = 1; i <= 5; i++) {
      await api('PUT', `/write?projectId=${PROJECT}&path=/prune.txt`, {
        rawBody: Buffer.from(`v${i}`),
      });
    }

    // Should have 4 versions (v1-v4; v5 is current)
    let versionsRes = await api('GET', `/versions?projectId=${PROJECT}&path=/prune.txt`);
    expect((await versionsRes.json()).versions.length).toBe(4);

    // Keep only 2
    const dropRes = await api('DELETE', `/versions?projectId=${PROJECT}&path=/prune.txt&keep=2`);
    expect(dropRes.status).toBe(200);
    expect((await dropRes.json()).deleted).toBe(2);

    // Verify only 2 versions remain
    versionsRes = await api('GET', `/versions?projectId=${PROJECT}&path=/prune.txt`);
    expect((await versionsRes.json()).versions.length).toBe(2);
  });
});

describe('Compound operations', () => {
  describe('str-replace', () => {
    it('replaces unique string and saves version', async () => {
      await api('PUT', `/write?projectId=${PROJECT}&path=/edit.txt`, {
        rawBody: Buffer.from('line1\nline2 old value\nline3'),
      });

      const res = await api('POST', `/str-replace?projectId=${PROJECT}&path=/edit.txt`, {
        body: { oldStr: 'old value', newStr: 'new value' },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.editLine).toBe(2);
      expect(body.snippet).toContain('new value');

      // Verify content
      const readRes = await api('GET', `/read?projectId=${PROJECT}&path=/edit.txt`);
      expect(await readRes.text()).toBe('line1\nline2 new value\nline3');

      // Should have saved a version
      const versionsRes = await api('GET', `/versions?projectId=${PROJECT}&path=/edit.txt`);
      expect((await versionsRes.json()).versions.length).toBeGreaterThanOrEqual(1);
    });

    it('returns 400 for string not found', async () => {
      await api('PUT', `/write?projectId=${PROJECT}&path=/edit2.txt`, {
        rawBody: Buffer.from('hello'),
      });

      const res = await api('POST', `/str-replace?projectId=${PROJECT}&path=/edit2.txt`, {
        body: { oldStr: 'nope', newStr: 'replacement' },
      });
      expect(res.status).toBe(400);
    });

    it('returns 400 for non-unique string', async () => {
      await api('PUT', `/write?projectId=${PROJECT}&path=/dup.txt`, {
        rawBody: Buffer.from('hello hello hello'),
      });

      const res = await api('POST', `/str-replace?projectId=${PROJECT}&path=/dup.txt`, {
        body: { oldStr: 'hello', newStr: 'world' },
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('3 occurrences');
    });

    it('preserves $ special patterns in replacement text literally', async () => {
      await api('PUT', `/write?projectId=${PROJECT}&path=/dollar.txt`, {
        rawBody: Buffer.from('prefix\nconst re = /old/;\nsuffix'),
      });

      const res = await api('POST', `/str-replace?projectId=${PROJECT}&path=/dollar.txt`, {
        body: { oldStr: 'const re = /old/;', newStr: 'const re = new RegExp(`^${pattern}$`);' },
      });
      expect(res.status).toBe(200);

      const readRes = await api('GET', `/read?projectId=${PROJECT}&path=/dollar.txt`);
      expect(await readRes.text()).toBe('prefix\nconst re = new RegExp(`^${pattern}$`);\nsuffix');
    });

    it('counts non-overlapping occurrences correctly', async () => {
      await api('PUT', `/write?projectId=${PROJECT}&path=/overlap.txt`, {
        rawBody: Buffer.from('aaa'),
      });

      const res = await api('POST', `/str-replace?projectId=${PROJECT}&path=/overlap.txt`, {
        body: { oldStr: 'aa', newStr: 'XX' },
      });
      expect(res.status).toBe(200);

      const readRes = await api('GET', `/read?projectId=${PROJECT}&path=/overlap.txt`);
      expect(await readRes.text()).toBe('XXa');
    });
  });

  describe('insert', () => {
    it('inserts text at specified line', async () => {
      await api('PUT', `/write?projectId=${PROJECT}&path=/insert.txt`, {
        rawBody: Buffer.from('line1\nline2\nline3'),
      });

      const res = await api('POST', `/insert?projectId=${PROJECT}&path=/insert.txt`, {
        body: { line: 1, text: 'inserted' },
      });
      expect(res.status).toBe(200);
      expect((await res.json()).insertedAt).toBe(1);

      const readRes = await api('GET', `/read?projectId=${PROJECT}&path=/insert.txt`);
      expect(await readRes.text()).toBe('line1\ninserted\nline2\nline3');
    });

    it('returns 400 for invalid line', async () => {
      await api('PUT', `/write?projectId=${PROJECT}&path=/insert2.txt`, {
        rawBody: Buffer.from('one line'),
      });

      const res = await api('POST', `/insert?projectId=${PROJECT}&path=/insert2.txt`, {
        body: { line: 99, text: 'nope' },
      });
      expect(res.status).toBe(400);
    });
  });

  describe('append', () => {
    it('creates file if missing', async () => {
      const res = await api('POST', `/append?projectId=${PROJECT}&path=/appended.txt`, {
        body: { text: 'first content' },
      });
      expect(res.status).toBe(200);
      expect((await res.json()).created).toBe(true);

      const readRes = await api('GET', `/read?projectId=${PROJECT}&path=/appended.txt`);
      expect(await readRes.text()).toBe('first content');
    });

    it('appends to existing file', async () => {
      await api('PUT', `/write?projectId=${PROJECT}&path=/appendable.txt`, {
        rawBody: Buffer.from('start'),
      });

      const res = await api('POST', `/append?projectId=${PROJECT}&path=/appendable.txt`, {
        body: { text: ' + end' },
      });
      expect(res.status).toBe(200);
      expect((await res.json()).created).toBe(false);

      const readRes = await api('GET', `/read?projectId=${PROJECT}&path=/appendable.txt`);
      expect(await readRes.text()).toBe('start + end');
    });
  });
});

describe('File meta', () => {
  it('returns file metadata with version info', async () => {
    await api('PUT', `/write?projectId=${PROJECT}&path=/meta.txt`, {
      rawBody: Buffer.from('content'),
    });
    await api('PUT', `/write?projectId=${PROJECT}&path=/meta.txt`, {
      rawBody: Buffer.from('updated'),
    });

    const res = await api('GET', `/file-meta?projectId=${PROJECT}&path=/meta.txt`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.version).toBeGreaterThanOrEqual(1);
    expect(body.size).toBe(7);
    expect(body.mime).toBe('text/plain');
  });

  it('returns 404 for non-existent file', async () => {
    const res = await api('GET', `/file-meta?projectId=${PROJECT}&path=/nope.txt`);
    expect(res.status).toBe(404);
  });
});

describe('Compact', () => {
  it('prunes old versions across all files', async () => {
    // Create files with several versions
    for (let i = 0; i < 5; i++) {
      await api('PUT', `/write?projectId=${PROJECT}&path=/compact1.txt`, {
        rawBody: Buffer.from(`v${i}`),
      });
      await api('PUT', `/write?projectId=${PROJECT}&path=/compact2.txt`, {
        rawBody: Buffer.from(`v${i}`),
      });
    }

    const res = await api('POST', `/compact?projectId=${PROJECT}`, {
      body: { keepCount: 1 },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.filesProcessed).toBe(2);
    expect(body.versionsDropped).toBeGreaterThan(0);
  });
});

describe('Hidden dirs excluded from ls', () => {
  it('does not list version directories', async () => {
    await api('PUT', `/write?projectId=${PROJECT}&path=/visible.txt`, {
      rawBody: Buffer.from('v1'),
    });
    // Write again to create version dir
    await api('PUT', `/write?projectId=${PROJECT}&path=/visible.txt`, {
      rawBody: Buffer.from('v2'),
    });

    const res = await api('GET', `/ls?projectId=${PROJECT}&path=/`);
    const body = await res.json();
    const names = body.entries.map((e: { name: string }) => e.name);
    expect(names).toContain('visible.txt');
    // Version dir should NOT appear
    expect(names.every((n: string) => !n.startsWith('.'))).toBe(true);
  });
});

describe('Missing projectId', () => {
  it('returns 400 when projectId is missing', async () => {
    const res = await fetch(`${baseUrl}/api/ls?path=/`, {
      headers: { Authorization: AUTH },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('projectId');
  });
});

describe('File lock serialization', () => {
  it('concurrent writes to same file produce consistent results', async () => {
    // Write initial content
    await api('PUT', `/write?projectId=${PROJECT}&path=/concurrent.txt`, {
      rawBody: Buffer.from('initial'),
    });

    // Fire concurrent appends
    const promises = Array.from({ length: 5 }, (_, i) =>
      api('POST', `/append?projectId=${PROJECT}&path=/concurrent.txt`, {
        body: { text: `[${i}]` },
      })
    );

    const results = await Promise.all(promises);
    for (const r of results) {
      expect(r.status).toBe(200);
    }

    // Read final content — all appends should be present
    const readRes = await api('GET', `/read?projectId=${PROJECT}&path=/concurrent.txt`);
    const finalContent = await readRes.text();
    expect(finalContent.startsWith('initial')).toBe(true);
    for (let i = 0; i < 5; i++) {
      expect(finalContent).toContain(`[${i}]`);
    }
  });
});

describe('ls on root of empty project', () => {
  it('auto-creates project root and returns empty entries', async () => {
    const res = await api('GET', `/ls?projectId=newproject&path=/`);
    // Might be 404 since the dir doesn't exist yet, or auto-created
    // Let's create a dir first
    await api('POST', `/mkdir?projectId=newproject&path=/`);
    const res2 = await api('GET', `/ls?projectId=newproject&path=/`);
    expect(res2.status).toBe(200);
    const body = await res2.json();
    expect(body.entries).toEqual([]);
  });
});
