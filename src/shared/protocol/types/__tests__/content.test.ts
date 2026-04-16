import { describe, expect, it } from 'vitest';
import { categorizeBlock, groupAndConsolidateBlocks, type RenderingContentBlock } from '../content';

describe('categorizeBlock', () => {
  it('should categorize thinking blocks as backstage', () => {
    expect(categorizeBlock({ type: 'thinking', thinking: 'test' })).toBe('backstage');
  });

  it('should categorize web_search blocks as backstage', () => {
    expect(categorizeBlock({ type: 'web_search', id: 'ws_1', query: 'test', results: [] })).toBe(
      'backstage'
    );
  });

  it('should categorize web_fetch blocks as backstage', () => {
    expect(categorizeBlock({ type: 'web_fetch', url: 'https://example.com' })).toBe('backstage');
  });

  it('should categorize text blocks as text', () => {
    expect(categorizeBlock({ type: 'text', text: 'Hello world' })).toBe('text');
  });
});

describe('groupAndConsolidateBlocks', () => {
  it('should return empty array for empty input', () => {
    const result = groupAndConsolidateBlocks([]);
    expect(result).toEqual([]);
  });

  it('should create a single text group for a single text block', () => {
    const blocks: RenderingContentBlock[] = [{ type: 'text', text: 'Hello world' }];
    const result = groupAndConsolidateBlocks(blocks);

    expect(result).toHaveLength(1);
    expect(result[0].category).toBe('text');
    expect(result[0].blocks).toHaveLength(1);
    expect(result[0].blocks[0]).toEqual({ type: 'text', text: 'Hello world' });
  });

  it('should consolidate consecutive text blocks into one', () => {
    const blocks: RenderingContentBlock[] = [
      { type: 'text', text: 'Hello ' },
      { type: 'text', text: 'world' },
      { type: 'text', text: '!' },
    ];
    const result = groupAndConsolidateBlocks(blocks);

    expect(result).toHaveLength(1);
    expect(result[0].category).toBe('text');
    expect(result[0].blocks).toHaveLength(1);
    expect(result[0].blocks[0]).toEqual({ type: 'text', text: 'Hello world!' });
  });

  it('should create a single backstage group for consecutive backstage blocks', () => {
    const blocks: RenderingContentBlock[] = [
      { type: 'thinking', thinking: 'Step 1' },
      { type: 'web_search', id: 'ws_2', query: 'test', results: [] },
      { type: 'thinking', thinking: 'Step 2' },
    ];
    const result = groupAndConsolidateBlocks(blocks);

    expect(result).toHaveLength(1);
    expect(result[0].category).toBe('backstage');
    expect(result[0].blocks).toHaveLength(3);
  });

  it('should not consolidate backstage blocks (only text)', () => {
    const blocks: RenderingContentBlock[] = [
      { type: 'thinking', thinking: 'Step 1' },
      { type: 'thinking', thinking: 'Step 2' },
    ];
    const result = groupAndConsolidateBlocks(blocks);

    expect(result).toHaveLength(1);
    expect(result[0].category).toBe('backstage');
    expect(result[0].blocks).toHaveLength(2);
    expect(result[0].blocks[0]).toEqual({ type: 'thinking', thinking: 'Step 1' });
    expect(result[0].blocks[1]).toEqual({ type: 'thinking', thinking: 'Step 2' });
  });

  it('should create alternating groups for interleaved content', () => {
    const blocks: RenderingContentBlock[] = [
      { type: 'thinking', thinking: 'Initial reasoning' },
      {
        type: 'web_search',
        id: 'ws_3',
        query: 'capital of Canada',
        results: [{ title: 'Ottawa', url: 'https://example.com' }],
      },
      { type: 'thinking', thinking: 'Found it' },
      { type: 'text', text: 'The capital is ' },
      { type: 'text', text: 'Ottawa' },
      { type: 'thinking', thinking: 'Now search weather' },
      { type: 'text', text: 'The weather is cold' },
    ];
    const result = groupAndConsolidateBlocks(blocks);

    expect(result).toHaveLength(4);

    // First group: backstage (thinking + search + thinking)
    expect(result[0].category).toBe('backstage');
    expect(result[0].blocks).toHaveLength(3);

    // Second group: text (consolidated)
    expect(result[1].category).toBe('text');
    expect(result[1].blocks).toHaveLength(1);
    expect(result[1].blocks[0]).toEqual({ type: 'text', text: 'The capital is Ottawa' });

    // Third group: backstage (thinking)
    expect(result[2].category).toBe('backstage');
    expect(result[2].blocks).toHaveLength(1);

    // Fourth group: text
    expect(result[3].category).toBe('text');
    expect(result[3].blocks).toHaveLength(1);
    expect(result[3].blocks[0]).toEqual({ type: 'text', text: 'The weather is cold' });
  });

  it('should simulate the multi-step thinking pattern from test data', () => {
    // Simulates: thinking → text → search → results → thinking → text (with citation) → text → thinking → ...
    const blocks: RenderingContentBlock[] = [
      { type: 'thinking', thinking: 'The user wants me to search...' },
      { type: 'text', text: '## Step 1: Comment on the Request\n\n...' },
      {
        type: 'web_search',
        id: 'ws_4',
        query: 'capital of Canada',
        results: [
          { title: 'Ottawa - Wikipedia', url: 'https://en.wikipedia.org/wiki/Ottawa' },
          { title: 'Britannica', url: 'https://www.britannica.com/place/Ottawa' },
        ],
      },
      {
        type: 'thinking',
        thinking: 'Great! The search results clearly show Ottawa is the capital.',
      },
      { type: 'text', text: '## Step 3: Result of First Search\n\nBased on the search results, ' },
      { type: 'text', text: 'Ottawa is the capital city of Canada<a href="...">src</a>' },
      { type: 'text', text: '. The search confirmed this.' },
      { type: 'web_search', id: 'ws_5', query: 'Ottawa weather tomorrow', results: [] },
      { type: 'thinking', thinking: 'Perfect! I got weather information.' },
      { type: 'text', text: '## Step 5: Weather results...' },
    ];

    const result = groupAndConsolidateBlocks(blocks);

    // Expected groups:
    // 1. backstage: [thinking]
    // 2. text: [consolidated text]
    // 3. backstage: [web_search, thinking]
    // 4. text: [consolidated text with citations]
    // 5. backstage: [web_search, thinking]
    // 6. text: [text]

    expect(result).toHaveLength(6);

    expect(result[0].category).toBe('backstage');
    expect(result[0].blocks).toHaveLength(1);

    expect(result[1].category).toBe('text');
    expect(result[1].blocks).toHaveLength(1);

    expect(result[2].category).toBe('backstage');
    expect(result[2].blocks).toHaveLength(2); // web_search + thinking

    expect(result[3].category).toBe('text');
    expect(result[3].blocks).toHaveLength(1);
    // Text should be consolidated
    expect((result[3].blocks[0] as { type: 'text'; text: string }).text).toContain(
      'Based on the search results'
    );
    expect((result[3].blocks[0] as { type: 'text'; text: string }).text).toContain(
      'confirmed this'
    );

    expect(result[4].category).toBe('backstage');
    expect(result[4].blocks).toHaveLength(2); // web_search + thinking

    expect(result[5].category).toBe('text');
    expect(result[5].blocks).toHaveLength(1);
  });
});
