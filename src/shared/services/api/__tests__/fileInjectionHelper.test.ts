import { describe, it, expect } from 'vitest';
import {
  effectiveInjectionMode,
  buildCarriedUserContent,
  buildInlineContent,
  buildInlinePrefix,
  buildInlineSuffix,
  buildInlineSection,
  buildMockToolCallPair,
  buildSeparateBlockText,
  hasCustomFraming,
  wrapInjectedFile,
} from '../fileInjectionHelper';
import { extractCarriedInjection } from '../../../protocol/carriedInjection';
import type { CarriedInjection, MessageContent } from '../../../protocol/types';

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

  it('downgrades as-file to separate-block for claude-agent', () => {
    expect(effectiveInjectionMode('as-file', 'claude-agent')).toBe('separate-block');
  });

  it('downgrades mock-tool-call to separate-block for claude-agent only', () => {
    expect(effectiveInjectionMode('mock-tool-call', 'claude-agent')).toBe('separate-block');
    expect(effectiveInjectionMode('mock-tool-call', 'anthropic')).toBe('mock-tool-call');
    expect(effectiveInjectionMode('mock-tool-call', 'google')).toBe('mock-tool-call');
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
    expect(result).toBe('\n\n');
  });

  it('omits the end marker when every file has custom framing', () => {
    const result = buildInlinePrefix([
      {
        path: '/diary.md',
        content: 'Dear diary',
        preamble: 'She read:',
        postamble: 'She closed it.',
      },
    ]);
    expect(result).toBe('She read:\nDear diary\nShe closed it.\n\n');
  });

  it('keeps the end marker when any file uses default framing', () => {
    const result = buildInlinePrefix([
      { path: '/a.ts', content: 'aaa' },
      { path: '/diary.md', content: 'Dear diary', preamble: 'She read:' },
    ]);
    expect(result).toContain('=== /a.ts ===');
    expect(result).toContain('She read:\nDear diary');
    expect(result).not.toContain('=== /diary.md ===');
    expect(result).toContain('=== end of files ===');
  });
});

describe('buildInlineSuffix', () => {
  it('formats a file with the default header and no end marker', () => {
    const result = buildInlineSuffix([{ path: '/src/app.ts', content: 'const x = 1;' }]);
    expect(result).toBe("=== /src/app.ts ===\nHere's the content of /src/app.ts:\nconst x = 1;");
  });

  it('never emits the end marker, even for a mixed batch', () => {
    const result = buildInlineSuffix([
      { path: '/a.ts', content: 'aaa' },
      { path: '/diary.md', content: 'Dear diary', preamble: 'She read:' },
    ]);
    expect(result).toContain('=== /a.ts ===');
    expect(result).toContain('She read:\nDear diary');
    expect(result).not.toContain('=== end of files ===');
  });

  it('joins multiple files with a blank line and adds no trailing separator', () => {
    const result = buildInlineSuffix([
      { path: '/a.ts', content: 'aaa', preamble: 'A:' },
      { path: '/b.ts', content: 'bbb', preamble: 'B:' },
    ]);
    expect(result).toBe('A:\naaa\n\nB:\nbbb');
  });

  it('returns an empty string for an empty array', () => {
    expect(buildInlineSuffix([])).toBe('');
  });
});

describe('hasCustomFraming', () => {
  it('is false without preamble/postamble', () => {
    expect(hasCustomFraming({ path: '/a', content: 'x' })).toBe(false);
  });

  it('is true with either field, including empty strings', () => {
    expect(hasCustomFraming({ path: '/a', content: 'x', preamble: 'p' })).toBe(true);
    expect(hasCustomFraming({ path: '/a', content: 'x', postamble: 'q' })).toBe(true);
    expect(hasCustomFraming({ path: '/a', content: 'x', preamble: '' })).toBe(true);
  });
});

describe('wrapInjectedFile', () => {
  it('returns bare content without custom framing', () => {
    expect(wrapInjectedFile({ path: '/a', content: 'body' })).toBe('body');
  });

  it('joins preamble, content, and postamble with newlines', () => {
    expect(
      wrapInjectedFile({ path: '/a', content: 'body', preamble: 'pre', postamble: 'post' })
    ).toBe('pre\nbody\npost');
  });

  it('skips the absent side', () => {
    expect(wrapInjectedFile({ path: '/a', content: 'body', preamble: 'pre' })).toBe('pre\nbody');
    expect(wrapInjectedFile({ path: '/a', content: 'body', postamble: 'post' })).toBe('body\npost');
  });
});

describe('buildSeparateBlockText', () => {
  it('uses the default header without custom framing', () => {
    expect(buildSeparateBlockText({ path: '/a.ts', content: 'aaa' })).toBe('=== /a.ts ===\naaa');
  });

  it('uses custom framing when given', () => {
    expect(
      buildSeparateBlockText({
        path: '/a.ts',
        content: 'aaa',
        preamble: 'Note:',
        postamble: 'End.',
      })
    ).toBe('Note:\naaa\nEnd.');
  });
});

describe('buildInlineSection', () => {
  it('uses the default header + intro line without custom framing', () => {
    expect(buildInlineSection({ path: '/a.ts', content: 'aaa' })).toBe(
      "=== /a.ts ===\nHere's the content of /a.ts:\naaa"
    );
  });

  it('includes the label in the intro line', () => {
    expect(buildInlineSection({ path: '/a.ts', content: 'aaa' }, ' with line numbers')).toBe(
      "=== /a.ts ===\nHere's the content of /a.ts with line numbers:\naaa"
    );
  });

  it('uses custom framing verbatim, ignoring the label', () => {
    expect(
      buildInlineSection({ path: '/a.ts', content: 'aaa', preamble: 'pre' }, ' with line numbers')
    ).toBe('pre\naaa');
  });
});

describe('buildInlineContent', () => {
  it('keeps a real message byte-for-byte, separators included', () => {
    expect(
      buildInlineContent('=== a ===\nx\n\n', '=== end of files ===\n\n', 'go\n', '\n\ny')
    ).toBe('=== a ===\nx\n\n=== end of files ===\n\ngo\n\n\ny');
  });

  it('trims the separators when there is no message text', () => {
    expect(buildInlineContent('=== a ===\nx\n\n', '=== end of files ===\n\n', '', '')).toBe(
      '=== a ===\nx\n\n=== end of files ==='
    );
    expect(buildInlineContent('', '', '', '\n\n=== b ===\ny')).toBe('=== b ===\ny');
  });
});

describe('buildCarriedUserContent', () => {
  const a = { path: '/a.md', content: 'alpha' };
  const b = { path: '/b.md', content: 'beta' };
  const carried = (
    mode: CarriedInjection['mode'],
    endMarker = false,
    after: CarriedInjection['after'] = [{ path: b.path, display: buildInlineSection(b), entry: b }]
  ): CarriedInjection => ({
    mode,
    before: [{ path: a.path, display: buildInlineSection(a), entry: a }],
    after,
    endMarker,
  });

  it('splices inline sections around the model text', () => {
    const built = buildCarriedUserContent(
      carried('inline', true),
      'go',
      '<meta>go</meta>',
      'chatgpt'
    );
    expect(built.content).toBe(
      `${buildInlineSection(a)}\n\n=== end of files ===\n\n<meta>go</meta>\n\n${buildInlineSection(b)}`
    );
    expect(built.fields).toEqual({});
    expect(built.leadingBlocks).toEqual([
      { type: 'injected_file', path: a.path, content: buildInlineSection(a) },
    ]);
    expect(built.trailingBlocks).toHaveLength(1);
  });

  it('drops the end marker once no leading file is kept', () => {
    const injection = { ...carried('inline', true), before: [] };
    expect(buildCarriedUserContent(injection, 'go', 'go', 'chatgpt').content).toBe(
      `go\n\n${buildInlineSection(b)}`
    );
  });

  it('stores raw entries for block-level modes and keeps the text clean', () => {
    const built = buildCarriedUserContent(carried('separate-block'), 'go', 'go', 'google');
    expect(built.content).toBe('go');
    expect(built.fields).toEqual({
      injectedFiles: [a],
      injectedFilesAfter: [b],
      injectionMode: 'separate-block',
    });
    expect(built.mockFiles).toEqual([]);
  });

  it('stores no fields when every file was removed', () => {
    const injection = { ...carried('as-file'), before: [], after: [] };
    expect(buildCarriedUserContent(injection, 'go', 'go', 'anthropic').fields).toEqual({});
  });

  it('returns mock files in leading-then-trailing order', () => {
    const built = buildCarriedUserContent(carried('mock-tool-call'), 'go', 'go', 'anthropic');
    expect(built.fields.injectionMode).toBe('mock-tool-call');
    expect(built.mockFiles.map(f => f.entry.path)).toEqual([a.path, b.path]);
  });

  it('downgrades mock-tool-call for claude-agent and for an empty message', () => {
    const agent = buildCarriedUserContent(carried('mock-tool-call'), 'go', 'go', 'claude-agent');
    expect(agent.fields.injectionMode).toBe('separate-block');
    expect(agent.mockFiles).toEqual([]);
    const empty = buildCarriedUserContent(carried('mock-tool-call'), '', '', 'anthropic');
    expect(empty.fields.injectionMode).toBe('separate-block');
  });

  it('refuses a block-level file without its stored entry', () => {
    const injection = carried('as-file', false, [{ path: b.path, display: 'x' }]);
    expect(() => buildCarriedUserContent(injection, 'go', 'go', 'anthropic')).toThrow(/b\.md/);
  });

  it('round-trips: the rebuilt message carries the same files again', () => {
    for (const mode of ['inline', 'separate-block'] as const) {
      const injection = carried(mode, mode === 'inline');
      const built = buildCarriedUserContent(injection, 'go', 'go', 'chatgpt');
      const rebuilt: MessageContent<unknown> = {
        type: 'text',
        content: built.content,
        renderingContent: [
          { category: 'backstage', blocks: built.leadingBlocks },
          { category: 'text', blocks: [{ type: 'text', text: 'go' }] },
          { category: 'backstage', blocks: built.trailingBlocks },
        ],
        ...built.fields,
      };
      const again = extractCarriedInjection(rebuilt);
      expect(again?.mode).toBe(mode);
      expect(again?.endMarker).toBe(injection.endMarker);
      expect(again?.before.map(f => f.display)).toEqual(injection.before.map(f => f.display));
      expect(again?.after.map(f => f.display)).toEqual(injection.after.map(f => f.display));
    }
  });
});

describe('buildMockToolCallPair', () => {
  it('pairs a filesystem readFile call with the framed file as its result', () => {
    const file = { path: '/a.md', content: 'alpha', preamble: '<a>' };
    const [call, result] = buildMockToolCallPair(file, 'bar text');
    expect(call.role).toBe('assistant');
    expect(call.content.toolCalls?.[0]).toMatchObject({
      name: 'filesystem',
      input: { action: 'readFile', path: '/a.md' },
    });
    expect(call.content.renderingContent?.[0].blocks).toEqual([
      { type: 'injected_file', path: '/a.md', content: 'bar text' },
    ]);
    expect(result.content.toolResults?.[0]).toEqual({
      type: 'tool_result',
      tool_use_id: call.content.toolCalls?.[0].id,
      content: '<a>\nalpha',
    });
  });
});
