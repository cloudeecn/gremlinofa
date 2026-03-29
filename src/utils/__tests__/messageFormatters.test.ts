import { describe, it, expect } from 'vitest';
import { formatTokenCount, formatTokens, formatTokenGroup } from '../messageFormatters';

describe('formatTokenCount', () => {
  it('returns plain number for small counts', () => {
    expect(formatTokenCount(500)).toBe('500');
    expect(formatTokenCount(10000)).toBe('10000');
  });

  it('formats large counts as ##.#k', () => {
    expect(formatTokenCount(10001)).toBe('10.0k');
    expect(formatTokenCount(12500)).toBe('12.5k');
    expect(formatTokenCount(150000)).toBe('150.0k');
  });
});

describe('formatTokens', () => {
  it('returns empty string for zero or undefined', () => {
    expect(formatTokens('↑', 0)).toBe('');
    expect(formatTokens('↑', undefined)).toBe('');
  });

  it('formats with prefix', () => {
    expect(formatTokens('↑', 123)).toBe('↑123');
    expect(formatTokens(' R:', 456)).toBe(' R:456');
  });
});

describe('formatTokenGroup', () => {
  it('returns empty string when main is undefined', () => {
    expect(formatTokenGroup('↑', undefined, [])).toBe('');
  });

  it('renders zero main token count', () => {
    expect(formatTokenGroup('↑', 0, [])).toBe('↑0');
    expect(formatTokenGroup('↑', 0, [{ prefix: 'C↑', value: 100 }])).toBe('↑(0, C↑100)');
  });

  it('returns flat format when no extras', () => {
    expect(formatTokenGroup('↑', 123, [])).toBe('↑123');
    expect(formatTokenGroup('↓', 456, [])).toBe('↓456');
  });

  it('returns flat format when all extras are zero or undefined', () => {
    expect(
      formatTokenGroup('↑', 123, [
        { prefix: 'C↑', value: 0 },
        { prefix: 'C↓', value: undefined },
      ])
    ).toBe('↑123');
  });

  it('returns grouped format with one extra', () => {
    expect(formatTokenGroup('↓', 456, [{ prefix: 'R:', value: 789 }])).toBe('↓(456, R:789)');
  });

  it('returns grouped format with multiple extras', () => {
    expect(
      formatTokenGroup('↑', 123, [
        { prefix: 'C↑', value: 101 },
        { prefix: 'C↓', value: 202 },
      ])
    ).toBe('↑(123, C↑101, C↓202)');
  });

  it('filters out zero extras from grouped format', () => {
    expect(
      formatTokenGroup('↑', 123, [
        { prefix: 'C↑', value: 101 },
        { prefix: 'C↓', value: 0 },
      ])
    ).toBe('↑(123, C↑101)');
  });

  it('uses k-format for large numbers', () => {
    expect(formatTokenGroup('↑', 50000, [{ prefix: 'C↓', value: 20000 }])).toBe(
      '↑(50.0k, C↓20.0k)'
    );
  });
});
