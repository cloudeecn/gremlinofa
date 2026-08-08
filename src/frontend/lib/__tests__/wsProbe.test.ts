import { describe, it, expect } from 'vitest';
import { normalizeWsUrl } from '../wsProbe';

describe('normalizeWsUrl', () => {
  it('keeps ws:// and wss:// URLs (canonicalized)', () => {
    expect(normalizeWsUrl('ws://localhost:3100')).toBe('ws://localhost:3100/');
    expect(normalizeWsUrl('wss://gremlin.example.com/backend')).toBe(
      'wss://gremlin.example.com/backend'
    );
  });

  it('converts http/https schemes to ws/wss', () => {
    expect(normalizeWsUrl('http://localhost:3100')).toBe('ws://localhost:3100/');
    expect(normalizeWsUrl('https://gremlin.example.com')).toBe('wss://gremlin.example.com/');
  });

  it('adds a scheme to schemeless input based on the page protocol', () => {
    // jsdom serves tests over http:, so the inferred scheme is ws:.
    expect(normalizeWsUrl('localhost:3100')).toBe('ws://localhost:3100/');
    expect(normalizeWsUrl('gremlin.example.com/backend')).toBe('ws://gremlin.example.com/backend');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeWsUrl('  ws://localhost:3100  ')).toBe('ws://localhost:3100/');
  });

  it('throws a user-facing error on empty or invalid input', () => {
    expect(() => normalizeWsUrl('')).toThrow(/enter the server/i);
    expect(() => normalizeWsUrl('   ')).toThrow(/enter the server/i);
    expect(() => normalizeWsUrl('ws://')).toThrow(/not a valid WebSocket URL/);
    expect(() => normalizeWsUrl('ftp://example.com')).toThrow(/not a valid WebSocket URL/);
  });
});
