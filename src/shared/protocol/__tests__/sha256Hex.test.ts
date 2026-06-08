import { describe, it, expect } from 'vitest';
import { sha256Hex } from '../sha256Hex';

describe('sha256Hex', () => {
  it('produces the canonical 64-char hex digest for an empty string', async () => {
    expect(await sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    );
  });

  it('matches the known digest for "abc"', async () => {
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    );
  });

  it('is deterministic for the same input', async () => {
    const input = 'project-12345';
    expect(await sha256Hex(input)).toBe(await sha256Hex(input));
  });

  it('differs between two distinct inputs (project vs chat scope)', async () => {
    const projectKey = await sha256Hex('project-abc');
    const chatKey = await sha256Hex('chat-abc');
    expect(projectKey).not.toBe(chatKey);
  });

  it('returns a 64-char lowercase hex string', async () => {
    const digest = await sha256Hex('any-id');
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });
});
