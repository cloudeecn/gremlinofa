import { describe, it, expect } from 'vitest';
import {
  formatTokenCount,
  formatTokens,
  formatTokenGroup,
  formatTimestamp,
  formatContextWindow,
  truncateModelName,
} from '../messageFormatters';

describe('formatTimestamp', () => {
  it('shows month, day and time without the year for the current year', () => {
    const now = new Date(2026, 8, 10, 9, 0);
    expect(formatTimestamp(new Date(2026, 8, 10, 15, 42), now)).toBe('Sep 10, 3:42 PM');
  });

  it('spells out the year when it differs from the current one', () => {
    const now = new Date(2026, 8, 10, 9, 0);
    expect(formatTimestamp(new Date(2025, 11, 3, 15, 42), now)).toBe('Dec 3, 2025, 3:42 PM');
  });
});

describe('formatContextWindow', () => {
  it('returns empty for missing or zero usage', () => {
    expect(formatContextWindow(undefined, 200000)).toBe('');
    expect(formatContextWindow(0, 200000)).toBe('');
  });

  it('renders usage alone when the window is unknown', () => {
    expect(formatContextWindow(5000)).toBe('5000');
    expect(formatContextWindow(12500, 0)).toBe('12.5k');
  });

  it('renders usage/max when both are known', () => {
    expect(formatContextWindow(12500, 200000)).toBe('12.5k/200.0k');
  });
});

describe('truncateModelName', () => {
  it('leaves ids at or under the limit alone', () => {
    expect(truncateModelName('gpt-5-2026-08-01')).toBe('gpt-5-2026-08-01');
    expect(truncateModelName('gpt-5')).toBe('gpt-5');
  });

  it('keeps max-1 characters plus an ellipsis for longer ids', () => {
    expect(truncateModelName('claude-fable-5-1-20260901')).toBe('claude-fable-5-…');
    expect(truncateModelName('claude-fable-5-1-20260901', 8)).toBe('claude-…');
  });
});

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
