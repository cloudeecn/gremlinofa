import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { StreamingContentAssembler } from '../StreamingContentAssembler';
import type { StreamChunk } from '../../api/baseClient';
import type {
  TextRenderBlock,
  ThinkingRenderBlock,
  WebSearchRenderBlock,
  ErrorRenderBlock,
  WebFetchRenderBlock,
} from '../../../types/content';

describe('StreamingContentAssembler', () => {
  let assembler: StreamingContentAssembler;

  beforeEach(() => {
    assembler = new StreamingContentAssembler();
  });

  describe('initial state', () => {
    it('starts with empty groups', () => {
      expect(assembler.getGroups()).toEqual([]);
    });

    it('starts with empty lastEvent', () => {
      expect(assembler.getLastEvent()).toBe('');
    });
  });

  describe('reset', () => {
    it('clears all state', () => {
      // Add some content
      assembler.pushChunk({ type: 'thinking.start' });
      assembler.pushChunk({ type: 'thinking', content: 'test' });
      assembler.pushChunk({ type: 'thinking.end' });
      assembler.pushChunk({ type: 'event', content: 'some event' });

      // Reset
      assembler.reset();

      expect(assembler.getGroups()).toEqual([]);
      expect(assembler.getLastEvent()).toBe('');
    });
  });

  describe('thinking blocks', () => {
    it('creates thinking block on thinking.start', () => {
      assembler.pushChunk({ type: 'thinking.start' });

      const groups = assembler.getGroups();
      expect(groups).toHaveLength(1);
      expect(groups[0].category).toBe('backstage');
      expect(groups[0].blocks).toHaveLength(1);
      expect(groups[0].blocks[0].type).toBe('thinking');
      expect((groups[0].blocks[0] as ThinkingRenderBlock).thinking).toBe('');
    });

    it('appends content on thinking delta', () => {
      assembler.pushChunk({ type: 'thinking.start' });
      assembler.pushChunk({ type: 'thinking', content: 'Hello ' });
      assembler.pushChunk({ type: 'thinking', content: 'World' });

      const groups = assembler.getGroups();
      const thinkingBlock = groups[0].blocks[0] as ThinkingRenderBlock;
      expect(thinkingBlock.thinking).toBe('Hello World');
    });

    it('finalizes block on thinking.end', () => {
      assembler.pushChunk({ type: 'thinking.start' });
      assembler.pushChunk({ type: 'thinking', content: 'Done' });
      assembler.pushChunk({ type: 'thinking.end' });

      const groups = assembler.getGroups();
      expect(groups).toHaveLength(1);
      expect((groups[0].blocks[0] as ThinkingRenderBlock).thinking).toBe('Done');
    });

    it('ignores thinking delta without thinking.start', () => {
      assembler.pushChunk({ type: 'thinking', content: 'orphan' });

      const groups = assembler.getGroups();
      expect(groups).toHaveLength(0);
    });
  });

  describe('content blocks (text)', () => {
    it('creates text block on content.start', () => {
      assembler.pushChunk({ type: 'content.start' });

      const groups = assembler.getGroups();
      expect(groups).toHaveLength(1);
      expect(groups[0].category).toBe('text');
      expect(groups[0].blocks).toHaveLength(1);
      expect(groups[0].blocks[0].type).toBe('text');
      expect((groups[0].blocks[0] as TextRenderBlock).text).toBe('');
    });

    it('appends content on content delta', () => {
      assembler.pushChunk({ type: 'content.start' });
      assembler.pushChunk({ type: 'content', content: 'Hello ' });
      assembler.pushChunk({ type: 'content', content: 'World' });

      const groups = assembler.getGroups();
      const textBlock = groups[0].blocks[0] as TextRenderBlock;
      expect(textBlock.text).toBe('Hello World');
    });

    it('finalizes block on content.end', () => {
      assembler.pushChunk({ type: 'content.start' });
      assembler.pushChunk({ type: 'content', content: 'Done' });
      assembler.pushChunk({ type: 'content.end' });

      const groups = assembler.getGroups();
      expect(groups).toHaveLength(1);
      expect((groups[0].blocks[0] as TextRenderBlock).text).toBe('Done');
    });

    it('ignores content delta without content.start', () => {
      assembler.pushChunk({ type: 'content', content: 'orphan' });

      const groups = assembler.getGroups();
      expect(groups).toHaveLength(0);
    });
  });

  describe('text block consolidation', () => {
    it('reuses text block when content.start follows content.end', () => {
      // First text block
      assembler.pushChunk({ type: 'content.start' });
      assembler.pushChunk({ type: 'content', content: 'First ' });
      assembler.pushChunk({ type: 'content.end' });

      // Second text block (should reuse)
      assembler.pushChunk({ type: 'content.start' });
      assembler.pushChunk({ type: 'content', content: 'Second' });
      assembler.pushChunk({ type: 'content.end' });

      const groups = assembler.getGroups();
      expect(groups).toHaveLength(1);
      expect(groups[0].blocks).toHaveLength(1);
      expect((groups[0].blocks[0] as TextRenderBlock).text).toBe('First Second');
    });

    it('does not reuse after non-text block', () => {
      // First text block
      assembler.pushChunk({ type: 'content.start' });
      assembler.pushChunk({ type: 'content', content: 'First' });
      assembler.pushChunk({ type: 'content.end' });

      // Thinking block interrupts
      assembler.pushChunk({ type: 'thinking.start' });
      assembler.pushChunk({ type: 'thinking', content: 'thinking...' });
      assembler.pushChunk({ type: 'thinking.end' });

      // Second text block (new block, not reused)
      assembler.pushChunk({ type: 'content.start' });
      assembler.pushChunk({ type: 'content', content: 'Second' });
      assembler.pushChunk({ type: 'content.end' });

      const groups = assembler.getGroups();
      expect(groups).toHaveLength(3);
      expect((groups[0].blocks[0] as TextRenderBlock).text).toBe('First');
      expect((groups[2].blocks[0] as TextRenderBlock).text).toBe('Second');
    });
  });

  describe('web_search blocks', () => {
    it('creates web search block with query', () => {
      assembler.pushChunk({ type: 'web_search', id: 'ws_1', query: 'capital of Canada' });

      const groups = assembler.getGroups();
      expect(groups).toHaveLength(1);
      expect(groups[0].category).toBe('backstage');
      expect(groups[0].blocks).toHaveLength(1);

      const searchBlock = groups[0].blocks[0] as WebSearchRenderBlock;
      expect(searchBlock.type).toBe('web_search');
      expect(searchBlock.query).toBe('capital of Canada');
      expect(searchBlock.results).toEqual([]);
    });

    it('creates placeholder block on web_search.start', () => {
      assembler.pushChunk({ type: 'web_search.start', id: 'ws_1' });

      const groups = assembler.getGroups();
      expect(groups).toHaveLength(1);
      expect(groups[0].category).toBe('backstage');

      const searchBlock = groups[0].blocks[0] as WebSearchRenderBlock;
      expect(searchBlock.type).toBe('web_search');
      expect(searchBlock.id).toBe('ws_1');
      expect(searchBlock.query).toBe(''); // Empty placeholder
      expect(searchBlock.results).toEqual([]);
    });

    it('updates query on existing block when web_search follows web_search.start', () => {
      // Emit start first
      assembler.pushChunk({ type: 'web_search.start', id: 'ws_1' });
      // Then emit full chunk with query
      assembler.pushChunk({ type: 'web_search', id: 'ws_1', query: 'capital of Canada' });

      const groups = assembler.getGroups();
      expect(groups).toHaveLength(1);
      expect(groups[0].blocks).toHaveLength(1); // Only one block, not two

      const searchBlock = groups[0].blocks[0] as WebSearchRenderBlock;
      expect(searchBlock.query).toBe('capital of Canada');
    });

    it('maintains same block reference between start and full event', () => {
      assembler.pushChunk({ type: 'web_search.start', id: 'ws_1' });
      const block1 = assembler.getGroups()[0].blocks[0];

      assembler.pushChunk({ type: 'web_search', id: 'ws_1', query: 'test query' });
      const block2 = assembler.getGroups()[0].blocks[0];

      // Same object reference
      expect(block1).toBe(block2);
    });

    it('appends results with web_search.result', () => {
      assembler.pushChunk({ type: 'web_search', id: 'ws_1', query: 'test query' });
      assembler.pushChunk({
        type: 'web_search.result',
        tool_use_id: 'ws_1',
        title: 'Result 1',
        url: 'https://example1.com',
      });
      assembler.pushChunk({
        type: 'web_search.result',
        tool_use_id: 'ws_1',
        title: 'Result 2',
        url: 'https://example2.com',
      });

      const groups = assembler.getGroups();
      const searchBlock = groups[0].blocks[0] as WebSearchRenderBlock;
      expect(searchBlock.results).toHaveLength(2);
      expect(searchBlock.results[0]).toEqual({ title: 'Result 1', url: 'https://example1.com' });
      expect(searchBlock.results[1]).toEqual({ title: 'Result 2', url: 'https://example2.com' });
    });

    it('ignores web_search.result without matching web_search', () => {
      assembler.pushChunk({
        type: 'web_search.result',
        tool_use_id: 'ws_nonexistent',
        title: 'Orphan Result',
        url: 'https://example.com',
      });

      const groups = assembler.getGroups();
      expect(groups).toHaveLength(0);
    });

    it('ignores web_search.result with missing title or url', () => {
      assembler.pushChunk({ type: 'web_search', id: 'ws_1', query: 'test' });
      assembler.pushChunk({ type: 'web_search.result', tool_use_id: 'ws_1', title: 'No URL' });
      assembler.pushChunk({
        type: 'web_search.result',
        tool_use_id: 'ws_1',
        url: 'https://no-title.com',
      });
      assembler.pushChunk({ type: 'web_search.result', tool_use_id: 'ws_1' });

      const groups = assembler.getGroups();
      const searchBlock = groups[0].blocks[0] as WebSearchRenderBlock;
      expect(searchBlock.results).toHaveLength(0);
    });
  });

  describe('web_fetch blocks', () => {
    it('creates web fetch block with url', () => {
      assembler.pushChunk({ type: 'web_fetch', id: 'fetch_1', url: 'https://example.com/page' });

      const groups = assembler.getGroups();
      expect(groups).toHaveLength(1);
      expect(groups[0].category).toBe('backstage');
      expect(groups[0].blocks).toHaveLength(1);

      const fetchBlock = groups[0].blocks[0] as WebFetchRenderBlock;
      expect(fetchBlock.type).toBe('web_fetch');
      expect(fetchBlock.url).toBe('https://example.com/page');
    });

    it('creates placeholder block on web_fetch.start', () => {
      assembler.pushChunk({ type: 'web_fetch.start', id: 'fetch_1' });

      const groups = assembler.getGroups();
      expect(groups).toHaveLength(1);
      expect(groups[0].category).toBe('backstage');

      const fetchBlock = groups[0].blocks[0] as WebFetchRenderBlock;
      expect(fetchBlock.type).toBe('web_fetch');
      expect(fetchBlock.url).toBe(''); // Empty placeholder
    });

    it('updates url on existing block when web_fetch follows web_fetch.start', () => {
      // Emit start first
      assembler.pushChunk({ type: 'web_fetch.start', id: 'fetch_1' });
      // Then emit full chunk with url
      assembler.pushChunk({ type: 'web_fetch', id: 'fetch_1', url: 'https://example.com/page' });

      const groups = assembler.getGroups();
      expect(groups).toHaveLength(1);
      expect(groups[0].blocks).toHaveLength(1); // Only one block, not two

      const fetchBlock = groups[0].blocks[0] as WebFetchRenderBlock;
      expect(fetchBlock.url).toBe('https://example.com/page');
    });

    it('maintains same block reference between start and full event', () => {
      assembler.pushChunk({ type: 'web_fetch.start', id: 'fetch_1' });
      const block1 = assembler.getGroups()[0].blocks[0];

      assembler.pushChunk({ type: 'web_fetch', id: 'fetch_1', url: 'https://example.com' });
      const block2 = assembler.getGroups()[0].blocks[0];

      // Same object reference
      expect(block1).toBe(block2);
    });
  });

  describe('finalizeWithError', () => {
    it('creates error block with message only', () => {
      const result = assembler.finalizeWithError({ message: 'Something went wrong' });

      expect(result).toHaveLength(1);
      expect(result[0].category).toBe('error');
      expect(result[0].blocks).toHaveLength(1);

      const errorBlock = result[0].blocks[0] as ErrorRenderBlock;
      expect(errorBlock.type).toBe('error');
      expect(errorBlock.message).toBe('Something went wrong');
      expect(errorBlock.status).toBeUndefined();
      expect(errorBlock.stack).toBeUndefined();
    });

    it('creates error block with all fields', () => {
      const result = assembler.finalizeWithError({
        message: 'API Error',
        status: 500,
        stack: 'Error: API Error\n    at sendRequest',
      });

      const errorBlock = result[0].blocks[0] as ErrorRenderBlock;
      expect(errorBlock.message).toBe('API Error');
      expect(errorBlock.status).toBe(500);
      expect(errorBlock.stack).toBe('Error: API Error\n    at sendRequest');
    });

    it('appends error block to existing content', () => {
      // Add some content first
      assembler.pushChunk({ type: 'content.start' });
      assembler.pushChunk({ type: 'content', content: 'Partial response...' });
      assembler.pushChunk({ type: 'content.end' });

      const result = assembler.finalizeWithError({ message: 'Connection lost' });

      expect(result).toHaveLength(2);
      expect(result[0].category).toBe('text');
      expect((result[0].blocks[0] as TextRenderBlock).text).toBe('Partial response...');
      expect(result[1].category).toBe('error');
      expect((result[1].blocks[0] as ErrorRenderBlock).message).toBe('Connection lost');
    });

    it('preserves thinking blocks when adding error', () => {
      // Add thinking
      assembler.pushChunk({ type: 'thinking.start' });
      assembler.pushChunk({ type: 'thinking', content: 'Let me think...' });
      assembler.pushChunk({ type: 'thinking.end' });

      const result = assembler.finalizeWithError({ message: 'Stream interrupted' });

      expect(result).toHaveLength(2);
      expect(result[0].category).toBe('backstage');
      expect((result[0].blocks[0] as ThinkingRenderBlock).thinking).toBe('Let me think...');
      expect(result[1].category).toBe('error');
    });

    it('returns a copy and does not modify internal state', () => {
      assembler.pushChunk({ type: 'content.start' });
      assembler.pushChunk({ type: 'content', content: 'Original' });
      assembler.pushChunk({ type: 'content.end' });

      const originalGroups = assembler.getGroups();
      const result = assembler.finalizeWithError({ message: 'Error' });

      // Result has error block
      expect(result).toHaveLength(2);
      expect(result[1].category).toBe('error');

      // Internal state unchanged
      const groupsAfter = assembler.getGroups();
      expect(groupsAfter).toHaveLength(1);
      expect(groupsAfter[0].category).toBe('text');

      // Original groups array reference should still work
      expect(originalGroups).toHaveLength(1);
    });

    it('creates deep copy of groups', () => {
      assembler.pushChunk({ type: 'content.start' });
      assembler.pushChunk({ type: 'content', content: 'Text' });
      assembler.pushChunk({ type: 'content.end' });

      const result = assembler.finalizeWithError({ message: 'Error' });

      // Modify result
      result[0].blocks.push({ type: 'text', text: 'Should not affect original' });

      // Original unaffected
      const groups = assembler.getGroups();
      expect(groups[0].blocks).toHaveLength(1);
    });

    it('works with empty assembler', () => {
      const result = assembler.finalizeWithError({ message: 'No content received' });

      expect(result).toHaveLength(1);
      expect(result[0].category).toBe('error');
      expect((result[0].blocks[0] as ErrorRenderBlock).message).toBe('No content received');
    });

    it('handles complex interleaved content with error', () => {
      // Thinking
      assembler.pushChunk({ type: 'thinking.start' });
      assembler.pushChunk({ type: 'thinking', content: 'Analyzing...' });
      assembler.pushChunk({ type: 'thinking.end' });

      // Text
      assembler.pushChunk({ type: 'content.start' });
      assembler.pushChunk({ type: 'content', content: 'Here is my analysis:' });
      assembler.pushChunk({ type: 'content.end' });

      // Web search
      assembler.pushChunk({ type: 'web_search', id: 'ws_1', query: 'test' });

      const result = assembler.finalizeWithError({ message: 'Rate limit exceeded', status: 429 });

      expect(result).toHaveLength(4);
      expect(result.map(g => g.category)).toEqual(['backstage', 'text', 'backstage', 'error']);
    });
  });

  describe('event tracking', () => {
    it('updates lastEvent on event chunk', () => {
      assembler.pushChunk({ type: 'event', content: 'message_start' });
      expect(assembler.getLastEvent()).toBe('message_start');

      assembler.pushChunk({ type: 'event', content: 'content_block_start' });
      expect(assembler.getLastEvent()).toBe('content_block_start');
    });
  });

  describe('token_usage handling', () => {
    it('ignores token_usage chunks', () => {
      assembler.pushChunk({
        type: 'token_usage',
        inputTokens: 100,
        outputTokens: 50,
      });

      const groups = assembler.getGroups();
      expect(groups).toHaveLength(0);
    });
  });

  describe('on-the-fly grouping', () => {
    it('groups consecutive backstage blocks together', () => {
      assembler.pushChunk({ type: 'thinking.start' });
      assembler.pushChunk({ type: 'thinking', content: 'thinking 1' });
      assembler.pushChunk({ type: 'thinking.end' });

      assembler.pushChunk({ type: 'web_search', id: 'ws_1', query: 'test query' });

      assembler.pushChunk({ type: 'thinking.start' });
      assembler.pushChunk({ type: 'thinking', content: 'thinking 2' });
      assembler.pushChunk({ type: 'thinking.end' });

      const groups = assembler.getGroups();
      expect(groups).toHaveLength(1);
      expect(groups[0].category).toBe('backstage');
      expect(groups[0].blocks).toHaveLength(3);
    });

    it('creates new group when category changes', () => {
      // Backstage
      assembler.pushChunk({ type: 'thinking.start' });
      assembler.pushChunk({ type: 'thinking', content: 'thinking' });
      assembler.pushChunk({ type: 'thinking.end' });

      // Text
      assembler.pushChunk({ type: 'content.start' });
      assembler.pushChunk({ type: 'content', content: 'text' });
      assembler.pushChunk({ type: 'content.end' });

      // Backstage again
      assembler.pushChunk({ type: 'web_search', id: 'ws_2', query: 'search' });

      // Text again
      assembler.pushChunk({ type: 'content.start' });
      assembler.pushChunk({ type: 'content', content: 'more text' });
      assembler.pushChunk({ type: 'content.end' });

      const groups = assembler.getGroups();
      expect(groups).toHaveLength(4);
      expect(groups.map(g => g.category)).toEqual(['backstage', 'text', 'backstage', 'text']);
    });
  });

  describe('interleaved pattern', () => {
    it('handles thinking → text → search → thinking → text pattern', () => {
      // thinking
      assembler.pushChunk({ type: 'thinking.start' });
      assembler.pushChunk({ type: 'thinking', content: 'Initial reasoning' });
      assembler.pushChunk({ type: 'thinking.end' });

      // text
      assembler.pushChunk({ type: 'content.start' });
      assembler.pushChunk({ type: 'content', content: 'First response' });
      assembler.pushChunk({ type: 'content.end' });

      // web search
      assembler.pushChunk({ type: 'web_search', id: 'ws_3', query: 'capital of Canada' });
      assembler.pushChunk({
        type: 'web_search.result',
        tool_use_id: 'ws_3',
        title: 'Wiki',
        url: 'https://wiki.com',
      });

      // more thinking
      assembler.pushChunk({ type: 'thinking.start' });
      assembler.pushChunk({ type: 'thinking', content: 'Got the results' });
      assembler.pushChunk({ type: 'thinking.end' });

      // more text
      assembler.pushChunk({ type: 'content.start' });
      assembler.pushChunk({ type: 'content', content: 'The capital is Ottawa' });
      assembler.pushChunk({ type: 'content.end' });

      const groups = assembler.getGroups();
      expect(groups).toHaveLength(4);

      // First backstage (thinking)
      expect(groups[0].category).toBe('backstage');
      expect(groups[0].blocks).toHaveLength(1);
      expect((groups[0].blocks[0] as ThinkingRenderBlock).thinking).toBe('Initial reasoning');

      // First text
      expect(groups[1].category).toBe('text');
      expect(groups[1].blocks).toHaveLength(1);
      expect((groups[1].blocks[0] as TextRenderBlock).text).toBe('First response');

      // Second backstage (search + thinking)
      expect(groups[2].category).toBe('backstage');
      expect(groups[2].blocks).toHaveLength(2);
      expect((groups[2].blocks[0] as WebSearchRenderBlock).query).toBe('capital of Canada');
      expect((groups[2].blocks[1] as ThinkingRenderBlock).thinking).toBe('Got the results');

      // Second text
      expect(groups[3].category).toBe('text');
      expect(groups[3].blocks).toHaveLength(1);
      expect((groups[3].blocks[0] as TextRenderBlock).text).toBe('The capital is Ottawa');
    });
  });

  describe('object stability', () => {
    it('returns new array reference but same group objects', () => {
      assembler.pushChunk({ type: 'thinking.start' });
      assembler.pushChunk({ type: 'thinking', content: 'test' });

      const groups1 = assembler.getGroups();
      const group1 = groups1[0];

      assembler.pushChunk({ type: 'thinking', content: ' more' });

      const groups2 = assembler.getGroups();
      const group2 = groups2[0];

      // Arrays are different references
      expect(groups1).not.toBe(groups2);
      // Group objects are the same reference
      expect(group1).toBe(group2);
    });

    it('maintains block reference while appending content', () => {
      assembler.pushChunk({ type: 'thinking.start' });
      assembler.pushChunk({ type: 'thinking', content: 'hello' });

      const block1 = assembler.getGroups()[0].blocks[0];

      assembler.pushChunk({ type: 'thinking', content: ' world' });

      const block2 = assembler.getGroups()[0].blocks[0];

      expect(block1).toBe(block2);
      expect((block1 as ThinkingRenderBlock).thinking).toBe('hello world');
    });

    it('maintains text block reference during consolidation', () => {
      assembler.pushChunk({ type: 'content.start' });
      assembler.pushChunk({ type: 'content', content: 'first' });
      assembler.pushChunk({ type: 'content.end' });

      const block1 = assembler.getGroups()[0].blocks[0];

      assembler.pushChunk({ type: 'content.start' });
      assembler.pushChunk({ type: 'content', content: 'second' });
      assembler.pushChunk({ type: 'content.end' });

      const block2 = assembler.getGroups()[0].blocks[0];

      // Same block reference (consolidated)
      expect(block1).toBe(block2);
      expect((block1 as TextRenderBlock).text).toBe('firstsecond');
    });
  });

  describe('edge cases', () => {
    it('handles empty content chunks', () => {
      assembler.pushChunk({ type: 'content.start' });
      assembler.pushChunk({ type: 'content', content: '' });
      assembler.pushChunk({ type: 'content', content: 'text' });
      assembler.pushChunk({ type: 'content', content: '' });
      assembler.pushChunk({ type: 'content.end' });

      const groups = assembler.getGroups();
      expect((groups[0].blocks[0] as TextRenderBlock).text).toBe('text');
    });

    it('handles multiple web searches', () => {
      assembler.pushChunk({ type: 'web_search', id: 'ws_a', query: 'first query' });
      assembler.pushChunk({ type: 'web_search', id: 'ws_b', query: 'second query' });

      assembler.pushChunk({
        type: 'web_search.result',
        tool_use_id: 'ws_a',
        title: 'R1',
        url: 'https://r1.com',
      });

      assembler.pushChunk({
        type: 'web_search.result',
        tool_use_id: 'ws_b',
        title: 'R2',
        url: 'https://r2.com',
      });

      const groups = assembler.getGroups();
      expect(groups).toHaveLength(1);
      expect(groups[0].blocks).toHaveLength(2);

      const search1 = groups[0].blocks[0] as WebSearchRenderBlock;
      const search2 = groups[0].blocks[1] as WebSearchRenderBlock;

      expect(search1.query).toBe('first query');
      expect(search1.results).toEqual([{ title: 'R1', url: 'https://r1.com' }]);
      expect(search2.query).toBe('second query');
      expect(search2.results).toEqual([{ title: 'R2', url: 'https://r2.com' }]);
    });

    it('handles content.start without content.end', () => {
      assembler.pushChunk({ type: 'content.start' });
      assembler.pushChunk({ type: 'content', content: 'incomplete' });
      // No content.end

      assembler.pushChunk({ type: 'thinking.start' });
      assembler.pushChunk({ type: 'thinking', content: 'thinking' });
      assembler.pushChunk({ type: 'thinking.end' });

      const groups = assembler.getGroups();
      expect(groups).toHaveLength(2);
      expect((groups[0].blocks[0] as TextRenderBlock).text).toBe('incomplete');
    });

    it('handles unknown chunk types gracefully', () => {
      // @ts-expect-error Testing unknown chunk type
      assembler.pushChunk({ type: 'unknown_type', data: 'test' } as StreamChunk);

      const groups = assembler.getGroups();
      expect(groups).toHaveLength(0);
    });
  });

  describe('real-world data snapshot', () => {
    it('assembles multiple-step-thinking stream into correct groups', () => {
      // Load pre-generated StreamChunks from anthropicStreamMapper test
      const chunksFilePath = join(
        __dirname,
        '../../api/__tests__/anthropic-multiple-step-thinking-streamChunks.json'
      );
      const chunks: StreamChunk[] = JSON.parse(readFileSync(chunksFilePath, 'utf-8'));

      // Push all chunks through assembler
      for (const chunk of chunks) {
        assembler.pushChunk(chunk);
      }

      const groups = assembler.getGroups();

      // Basic structural validation
      expect(groups.length).toBeGreaterThan(0);

      // Count blocks by type
      let thinkingCount = 0;
      let textCount = 0;
      let webSearchCount = 0;

      for (const group of groups) {
        for (const block of group.blocks) {
          if (block.type === 'thinking') thinkingCount++;
          if (block.type === 'text') textCount++;
          if (block.type === 'web_search') webSearchCount++;
        }
      }

      // The stream has 3 thinking blocks
      expect(thinkingCount).toBe(3);

      // The stream has 2 web searches
      expect(webSearchCount).toBe(2);

      // Multiple text blocks (consolidated from many content blocks)
      expect(textCount).toBeGreaterThan(0);

      // Verify grouping pattern: backstage and text groups alternate
      const categories = groups.map(g => g.category);
      expect(categories).toContain('backstage');
      expect(categories).toContain('text');

      // Snapshot the final assembled groups
      expect(groups).toMatchSnapshot();
    });
  });
});
