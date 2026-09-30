import { describe, it, expect } from 'vitest';
import { extractCarriedInjection, splitInjectedFileBlocks } from '../carriedInjection';
import type { MessageContent, RenderingBlockGroup } from '../types';
import { buildInlineContent, buildInlineSection } from '../../services/api/fileInjectionHelper';

/** A user message as the minion tool stores it: file bars around the text group. */
function minionUserContent(
  text: string,
  before: string[],
  after: string[],
  extra: Partial<MessageContent<unknown>> = {}
): MessageContent<unknown> {
  const bar = (display: string, i: number) => ({
    type: 'injected_file' as const,
    path: `/f${i}.md`,
    content: display,
  });
  const groups: RenderingBlockGroup[] = [];
  if (before.length) groups.push({ category: 'backstage', blocks: before.map(bar) });
  groups.push({ category: 'text', blocks: text ? [{ type: 'text', text }] : [] });
  if (after.length) {
    groups.push({
      category: 'backstage',
      blocks: after.map((d, i) => bar(d, before.length + i)),
    });
  }
  return { type: 'text', content: '', renderingContent: groups, ...extra };
}

describe('splitInjectedFileBlocks', () => {
  it('splits at the text group, even an empty one', () => {
    const { before, after } = splitInjectedFileBlocks(
      minionUserContent('', ['a'], ['b']).renderingContent
    );
    expect(before.map(b => b.content)).toEqual(['a']);
    expect(after.map(b => b.content)).toEqual(['b']);
  });

  it('treats every bar as leading when there is no text group', () => {
    const groups: RenderingBlockGroup[] = [
      { category: 'backstage', blocks: [{ type: 'injected_file', path: '/a', content: 'a' }] },
    ];
    expect(splitInjectedFileBlocks(groups).before).toHaveLength(1);
  });
});

describe('extractCarriedInjection', () => {
  const a = { path: '/f0.md', content: 'alpha' };
  const b = { path: '/f1.md', content: 'beta', preamble: '<b>', postamble: '</b>' };
  const sectionA = buildInlineSection(a, ' with line numbers');
  const sectionB = buildInlineSection(b);

  it('returns undefined for a message without file bars', () => {
    expect(extractCarriedInjection(minionUserContent('hi', [], []))).toBeUndefined();
  });

  it('leaves out failed reads', () => {
    const content: MessageContent<unknown> = {
      type: 'text',
      content: 'go',
      renderingContent: [
        {
          category: 'backstage',
          blocks: [{ type: 'injected_file', path: '/a', content: 'ENOENT', error: true }],
        },
        { category: 'text', blocks: [{ type: 'text', text: 'go' }] },
      ],
    };
    expect(extractCarriedInjection(content)).toBeUndefined();
  });

  it('carries inline bars verbatim, line-number label included', () => {
    const content = minionUserContent('go', [sectionA], [sectionB], {
      content: buildInlineContent(
        `${sectionA}\n\n`,
        '=== end of files ===\n\n',
        'go',
        `\n\n${sectionB}`
      ),
    });
    expect(extractCarriedInjection(content)).toEqual({
      mode: 'inline',
      before: [{ path: '/f0.md', display: sectionA }],
      after: [{ path: '/f1.md', display: sectionB }],
      endMarker: true,
    });
  });

  it('sees no end marker when every leading file was custom-framed', () => {
    const content = minionUserContent('go', [sectionB], [], {
      content: buildInlineContent(`${sectionB}\n\n`, '', 'go', ''),
    });
    expect(extractCarriedInjection(content)?.endMarker).toBe(false);
  });

  it('finds the end marker in a trimmed inject-only message', () => {
    const content = minionUserContent('', [sectionA], [], {
      content: buildInlineContent(`${sectionA}\n\n`, '=== end of files ===\n\n', '', ''),
    });
    expect(extractCarriedInjection(content)?.endMarker).toBe(true);
  });

  it('pairs bars with stored entries in block-level modes', () => {
    const content = minionUserContent('go', [sectionA], [sectionB], {
      content: 'go',
      injectedFiles: [a],
      injectedFilesAfter: [b],
      injectionMode: 'as-file',
    });
    expect(extractCarriedInjection(content)).toEqual({
      mode: 'as-file',
      before: [{ path: '/f0.md', display: sectionA, entry: a }],
      after: [{ path: '/f1.md', display: sectionB, entry: b }],
      endMarker: false,
    });
  });

  it('keeps mock-tool-call with its entries', () => {
    const content = minionUserContent('go', [sectionA], [], {
      content: 'go',
      injectedFiles: [a],
      injectionMode: 'mock-tool-call',
    });
    expect(extractCarriedInjection(content)?.mode).toBe('mock-tool-call');
    expect(extractCarriedInjection(content)?.before[0].entry).toEqual(a);
  });

  it('falls back to inline when stored entries do not line up with the bars', () => {
    const content = minionUserContent('go', [sectionA, sectionB], [], {
      content: 'go',
      injectedFiles: [a],
      injectionMode: 'separate-block',
    });
    const carried = extractCarriedInjection(content);
    expect(carried?.mode).toBe('inline');
    expect(carried?.before.map(f => f.display)).toEqual([sectionA, sectionB]);
  });
});
