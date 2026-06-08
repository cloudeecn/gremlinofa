import { describe, it, expect } from 'vitest';
import { formatFileWithLineNumbers } from '../formatFileContent';

describe('formatFileWithLineNumbers', () => {
  it('numbers all lines starting from 1 by default', () => {
    const result = formatFileWithLineNumbers('a\nb\nc');
    expect(result).toBe('     1\ta\n     2\tb\n     3\tc');
  });

  it('right-aligns line numbers to 6 characters', () => {
    const result = formatFileWithLineNumbers('hello');
    expect(result).toBe('     1\thello');
  });

  it('handles single empty line', () => {
    const result = formatFileWithLineNumbers('');
    expect(result).toBe('     1\t');
  });

  it('respects startLine parameter', () => {
    const result = formatFileWithLineNumbers('a\nb\nc\nd\ne', 3);
    expect(result).toBe('     3\tc\n     4\td\n     5\te');
  });

  it('respects endLine parameter', () => {
    const result = formatFileWithLineNumbers('a\nb\nc\nd\ne', 2, 4);
    expect(result).toBe('     2\tb\n     3\tc\n     4\td');
  });

  it('respects both startLine and endLine', () => {
    const result = formatFileWithLineNumbers('a\nb\nc\nd\ne', 2, 3);
    expect(result).toBe('     2\tb\n     3\tc');
  });

  it('handles large line numbers', () => {
    const lines = Array.from({ length: 1000 }, (_, i) => `line${i + 1}`);
    const result = formatFileWithLineNumbers(lines.join('\n'), 999, 1000);
    expect(result).toBe('   999\tline999\n  1000\tline1000');
  });
});
