import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { cloneFile } from '../versioning.js';

describe('cloneFile', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'versioning-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('copies into a fresh destination as an independent file', async () => {
    const src = path.join(tmpDir, 'src.bin');
    const dst = path.join(tmpDir, 'dst.bin');
    const payload = Buffer.from(Array.from({ length: 100_000 }, (_, i) => i & 0xff));
    fs.writeFileSync(src, payload);

    await cloneFile(src, dst);
    fs.appendFileSync(src, 'more');

    expect(fs.readFileSync(dst).equals(payload)).toBe(true);
    expect(fs.statSync(dst).ino).not.toBe(fs.statSync(src).ino);
  });

  it('overwrites an existing destination in place, keeping its inode', async () => {
    const src = path.join(tmpDir, 'src.txt');
    const dst = path.join(tmpDir, 'dst.txt');
    fs.writeFileSync(src, 'new content');
    fs.writeFileSync(dst, 'old content that is longer');
    const inodeBefore = fs.statSync(dst).ino;

    await cloneFile(src, dst);

    expect(fs.readFileSync(dst, 'utf-8')).toBe('new content');
    expect(fs.statSync(dst).ino).toBe(inodeBefore);
  });
});
