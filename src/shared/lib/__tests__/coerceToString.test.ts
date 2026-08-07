import { describe, it, expect } from 'vitest';
import { coerceToString } from '../coerceToString';

describe('coerceToString', () => {
  it('passes strings through', () => {
    expect(coerceToString('hello')).toBe('hello');
    expect(coerceToString('')).toBe('');
  });

  it('maps null/undefined to empty string', () => {
    expect(coerceToString(null)).toBe('');
    expect(coerceToString(undefined)).toBe('');
  });

  it('JSON-encodes objects instead of rendering [object Object]', () => {
    expect(coerceToString({ note: 'x' })).toBe('{"note":"x"}');
    expect(coerceToString([1, 2])).toBe('[1,2]');
  });

  it('stringifies primitives', () => {
    expect(coerceToString(42)).toBe('42');
    expect(coerceToString(true)).toBe('true');
  });
});
