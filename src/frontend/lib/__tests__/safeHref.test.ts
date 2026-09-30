import { describe, expect, it } from 'vitest';
import { safeHref } from '../safeHref';

describe('safeHref', () => {
  it('passes http and https URLs through', () => {
    expect(safeHref('https://auth.example.com/device')).toBe('https://auth.example.com/device');
    expect(safeHref('http://localhost:1455/cb')).toBe('http://localhost:1455/cb');
  });

  it.each(['javascript:alert(1)', 'data:text/html,<b>x</b>', 'vbscript:x', 'not a url', ''])(
    'drops %s',
    url => {
      expect(safeHref(url)).toBeUndefined();
    }
  );
});
