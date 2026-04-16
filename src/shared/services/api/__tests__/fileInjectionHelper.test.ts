import { describe, it, expect } from 'vitest';
import { effectiveInjectionMode, buildInlinePrefix } from '../fileInjectionHelper';

describe('effectiveInjectionMode', () => {
  it('returns inline for undefined or inline request', () => {
    expect(effectiveInjectionMode(undefined, 'anthropic')).toBe('inline');
    expect(effectiveInjectionMode('inline', 'chatgpt')).toBe('inline');
  });

  it('keeps as-file for providers that support it', () => {
    expect(effectiveInjectionMode('as-file', 'anthropic')).toBe('as-file');
    expect(effectiveInjectionMode('as-file', 'chatgpt')).toBe('as-file');
    expect(effectiveInjectionMode('as-file', 'responses_api')).toBe('as-file');
    expect(effectiveInjectionMode('as-file', 'bedrock')).toBe('as-file');
  });

  it('downgrades as-file to separate-block for google', () => {
    expect(effectiveInjectionMode('as-file', 'google')).toBe('separate-block');
  });

  it('keeps separate-block for all providers', () => {
    expect(effectiveInjectionMode('separate-block', 'anthropic')).toBe('separate-block');
    expect(effectiveInjectionMode('separate-block', 'chatgpt')).toBe('separate-block');
    expect(effectiveInjectionMode('separate-block', 'google')).toBe('separate-block');
    expect(effectiveInjectionMode('separate-block', 'bedrock')).toBe('separate-block');
  });

  it('returns inline for unknown mode values', () => {
    expect(effectiveInjectionMode('unknown' as 'inline', 'anthropic')).toBe('inline');
  });
});

describe('buildInlinePrefix', () => {
  it('formats a single file with path header and separator', () => {
    const result = buildInlinePrefix([{ path: '/src/app.ts', content: 'const x = 1;' }]);
    expect(result).toContain('=== /src/app.ts ===');
    expect(result).toContain("Here's the content of /src/app.ts:");
    expect(result).toContain('const x = 1;');
    expect(result).toContain('=== end of files ===');
  });

  it('formats multiple files separated by blank lines', () => {
    const result = buildInlinePrefix([
      { path: '/a.ts', content: 'aaa' },
      { path: '/b.ts', content: 'bbb' },
    ]);
    expect(result).toContain('=== /a.ts ===');
    expect(result).toContain('=== /b.ts ===');
    // Files separated by double newline
    const aIdx = result.indexOf('aaa');
    const bHeader = result.indexOf('=== /b.ts ===');
    expect(bHeader).toBeGreaterThan(aIdx);
  });

  it('returns just separator for empty array', () => {
    const result = buildInlinePrefix([]);
    expect(result).toContain('=== end of files ===');
  });
});
