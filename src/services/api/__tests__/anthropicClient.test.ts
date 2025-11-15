import { describe, expect, it } from 'vitest';
import { AnthropicClient } from '../anthropicClient';
import testMessageContent from './anthropic-multiple-step-thinking-message.json';
import expectedRenderingContent from './anthropic-multiple-step-thinking-renderingContent.json';

describe('AnthropicClient.migrateMessageRendering', () => {
  const client = new AnthropicClient();

  describe('basic functionality', () => {
    it('should return empty renderingContent for empty array', () => {
      const result = client.migrateMessageRendering([], null);

      expect(result.renderingContent).toEqual([]);
      expect(result.stopReason).toBe('end_turn');
    });

    it('should handle string fullContent (legacy format)', () => {
      const result = client.migrateMessageRendering('Hello world', null);

      expect(result.renderingContent).toHaveLength(1);
      expect(result.renderingContent[0].category).toBe('text');
      expect(result.renderingContent[0].blocks).toHaveLength(1);
      expect(result.renderingContent[0].blocks[0]).toEqual({ type: 'text', text: 'Hello world' });
    });

    it('should handle empty string fullContent', () => {
      const result = client.migrateMessageRendering('', null);

      expect(result.renderingContent).toEqual([]);
    });

    it('should handle whitespace-only string fullContent', () => {
      const result = client.migrateMessageRendering('   ', null);

      expect(result.renderingContent).toEqual([]);
    });
  });

  describe('stop reason mapping', () => {
    it('should map end_turn stop reason', () => {
      const result = client.migrateMessageRendering([{ type: 'text', text: 'Hello' }], 'end_turn');
      expect(result.stopReason).toBe('end_turn');
    });

    it('should map max_tokens stop reason', () => {
      const result = client.migrateMessageRendering(
        [{ type: 'text', text: 'Hello' }],
        'max_tokens'
      );
      expect(result.stopReason).toBe('max_tokens');
    });

    it('should map stop_sequence stop reason', () => {
      const result = client.migrateMessageRendering(
        [{ type: 'text', text: 'Hello' }],
        'stop_sequence'
      );
      expect(result.stopReason).toBe('stop_sequence');
    });

    it('should map tool_use to end_turn', () => {
      const result = client.migrateMessageRendering([{ type: 'text', text: 'Hello' }], 'tool_use');
      expect(result.stopReason).toBe('end_turn');
    });

    it('should pass through unknown stop reasons', () => {
      const result = client.migrateMessageRendering(
        [{ type: 'text', text: 'Hello' }],
        'custom_reason'
      );
      expect(result.stopReason).toBe('custom_reason');
    });

    it('should default to end_turn for null stop reason', () => {
      const result = client.migrateMessageRendering([{ type: 'text', text: 'Hello' }], null);
      expect(result.stopReason).toBe('end_turn');
    });
  });

  describe('thinking blocks', () => {
    it('should convert thinking blocks to ThinkingRenderBlock', () => {
      const fullContent = [{ type: 'thinking', thinking: 'Let me think about this...' }];

      const result = client.migrateMessageRendering(fullContent, null);

      expect(result.renderingContent).toHaveLength(1);
      expect(result.renderingContent[0].category).toBe('backstage');
      expect(result.renderingContent[0].blocks).toHaveLength(1);
      expect(result.renderingContent[0].blocks[0]).toEqual({
        type: 'thinking',
        thinking: 'Let me think about this...',
      });
    });

    it('should skip empty thinking blocks', () => {
      const fullContent = [
        { type: 'thinking', thinking: '   ' },
        { type: 'text', text: 'Hello' },
      ];

      const result = client.migrateMessageRendering(fullContent, null);

      expect(result.renderingContent).toHaveLength(1);
      expect(result.renderingContent[0].category).toBe('text');
    });
  });

  describe('text blocks', () => {
    it('should convert text blocks to TextRenderBlock', () => {
      const fullContent = [{ type: 'text', text: 'Hello world' }];

      const result = client.migrateMessageRendering(fullContent, null);

      expect(result.renderingContent).toHaveLength(1);
      expect(result.renderingContent[0].category).toBe('text');
      expect(result.renderingContent[0].blocks[0]).toEqual({ type: 'text', text: 'Hello world' });
    });

    it('should consolidate consecutive text blocks', () => {
      const fullContent = [
        { type: 'text', text: 'Hello ' },
        { type: 'text', text: 'world' },
        { type: 'text', text: '!' },
      ];

      const result = client.migrateMessageRendering(fullContent, null);

      expect(result.renderingContent).toHaveLength(1);
      expect(result.renderingContent[0].blocks).toHaveLength(1);
      expect(result.renderingContent[0].blocks[0]).toEqual({ type: 'text', text: 'Hello world!' });
    });

    it('should skip empty text blocks', () => {
      const fullContent = [
        { type: 'text', text: '' },
        { type: 'text', text: 'Hello' },
        { type: 'text', text: '   ' },
      ];

      const result = client.migrateMessageRendering(fullContent, null);

      expect(result.renderingContent).toHaveLength(1);
      expect(result.renderingContent[0].blocks).toHaveLength(1);
      expect(result.renderingContent[0].blocks[0]).toEqual({ type: 'text', text: 'Hello' });
    });
  });

  describe('text blocks with citations', () => {
    it('should render citations as <a> tags', () => {
      const fullContent = [
        {
          type: 'text',
          text: 'Ottawa is the capital',
          citations: [
            {
              type: 'web_search_result_location',
              url: 'https://en.wikipedia.org/wiki/Ottawa',
              title: 'Ottawa - Wikipedia',
              cited_text: 'Ottawa is the capital city of Canada.',
            },
          ],
        },
      ];

      const result = client.migrateMessageRendering(fullContent, null);

      expect(result.renderingContent).toHaveLength(1);
      const textBlock = result.renderingContent[0].blocks[0] as { type: 'text'; text: string };

      expect(textBlock.text).toContain('Ottawa is the capital');
      expect(textBlock.text).toContain('<a href="https://en.wikipedia.org/wiki/Ottawa"');
      expect(textBlock.text).toContain('target="_blank"');
      expect(textBlock.text).toContain('rel="noopener noreferrer"');
      expect(textBlock.text).toContain('title="Ottawa - Wikipedia"');
      expect(textBlock.text).toContain('data-cited="Ottawa is the capital city of Canada."');
      expect(textBlock.text).toContain('class="citation-link"');
      expect(textBlock.text).toContain('>src</a>');
    });

    it('should escape HTML in citation attributes', () => {
      const fullContent = [
        {
          type: 'text',
          text: 'Test',
          citations: [
            {
              type: 'web_search_result_location',
              url: 'https://example.com?a=1&b=2',
              title: 'Title with "quotes"',
              cited_text: "Text with <tags> & 'quotes'",
            },
          ],
        },
      ];

      const result = client.migrateMessageRendering(fullContent, null);

      const textBlock = result.renderingContent[0].blocks[0] as { type: 'text'; text: string };

      expect(textBlock.text).toContain('&amp;');
      expect(textBlock.text).toContain('&quot;');
      expect(textBlock.text).toContain('&lt;');
      expect(textBlock.text).toContain('&gt;');
    });

    it('should skip non-web_search_result_location citations', () => {
      const fullContent = [
        {
          type: 'text',
          text: 'Test text',
          citations: [
            {
              type: 'other_citation_type',
              url: 'https://example.com',
            },
          ],
        },
      ];

      const result = client.migrateMessageRendering(fullContent, null);

      const textBlock = result.renderingContent[0].blocks[0] as { type: 'text'; text: string };
      expect(textBlock.text).toBe('Test text');
      expect(textBlock.text).not.toContain('<a');
    });
  });

  describe('web_search blocks', () => {
    it('should convert server_tool_use web_search and results to WebSearchRenderBlock', () => {
      const fullContent = [
        {
          type: 'server_tool_use',
          name: 'web_search',
          input: { query: 'capital of Canada' },
        },
        {
          type: 'web_search_tool_result',
          content: [
            {
              type: 'web_search_result',
              title: 'Ottawa - Wikipedia',
              url: 'https://en.wikipedia.org/wiki/Ottawa',
            },
            {
              type: 'web_search_result',
              title: 'Britannica',
              url: 'https://www.britannica.com/place/Ottawa',
            },
          ],
        },
      ];

      const result = client.migrateMessageRendering(fullContent, null);

      expect(result.renderingContent).toHaveLength(1);
      expect(result.renderingContent[0].category).toBe('backstage');
      expect(result.renderingContent[0].blocks).toHaveLength(1);

      const searchBlock = result.renderingContent[0].blocks[0] as {
        type: 'web_search';
        query: string;
        results: Array<{ title: string; url: string }>;
      };
      expect(searchBlock.type).toBe('web_search');
      expect(searchBlock.query).toBe('capital of Canada');
      expect(searchBlock.results).toHaveLength(2);
      expect(searchBlock.results[0]).toEqual({
        title: 'Ottawa - Wikipedia',
        url: 'https://en.wikipedia.org/wiki/Ottawa',
      });
    });

    it('should handle web_search without results', () => {
      const fullContent = [
        {
          type: 'server_tool_use',
          name: 'web_search',
          input: { query: 'test query' },
        },
        {
          type: 'web_search_tool_result',
          content: [],
        },
      ];

      const result = client.migrateMessageRendering(fullContent, null);

      expect(result.renderingContent).toHaveLength(1);
      const searchBlock = result.renderingContent[0].blocks[0] as {
        type: 'web_search';
        results: Array<{ title: string; url: string }>;
      };
      expect(searchBlock.results).toHaveLength(0);
    });
  });

  describe('web_fetch blocks', () => {
    it('should convert server_tool_use web_fetch to WebFetchRenderBlock', () => {
      const fullContent = [
        {
          type: 'server_tool_use',
          name: 'web_fetch',
          input: { url: 'https://example.com/page' },
        },
      ];

      const result = client.migrateMessageRendering(fullContent, null);

      expect(result.renderingContent).toHaveLength(1);
      expect(result.renderingContent[0].category).toBe('backstage');

      const fetchBlock = result.renderingContent[0].blocks[0] as {
        type: 'web_fetch';
        url: string;
        title?: string;
      };
      expect(fetchBlock.type).toBe('web_fetch');
      expect(fetchBlock.url).toBe('https://example.com/page');
    });
  });

  describe('interleaved content grouping', () => {
    it('should group consecutive backstage blocks together', () => {
      const fullContent = [
        { type: 'thinking', thinking: 'Step 1' },
        {
          type: 'server_tool_use',
          name: 'web_search',
          input: { query: 'test' },
        },
        {
          type: 'web_search_tool_result',
          content: [{ type: 'web_search_result', title: 'Result', url: 'https://example.com' }],
        },
        { type: 'thinking', thinking: 'Step 2' },
      ];

      const result = client.migrateMessageRendering(fullContent, null);

      expect(result.renderingContent).toHaveLength(1);
      expect(result.renderingContent[0].category).toBe('backstage');
      expect(result.renderingContent[0].blocks).toHaveLength(3); // thinking + web_search + thinking
    });

    it('should separate text groups from backstage groups', () => {
      const fullContent = [
        { type: 'thinking', thinking: 'Thinking...' },
        { type: 'text', text: 'Response text' },
        { type: 'thinking', thinking: 'More thinking...' },
        { type: 'text', text: 'More response' },
      ];

      const result = client.migrateMessageRendering(fullContent, null);

      expect(result.renderingContent).toHaveLength(4);
      expect(result.renderingContent[0].category).toBe('backstage');
      expect(result.renderingContent[1].category).toBe('text');
      expect(result.renderingContent[2].category).toBe('backstage');
      expect(result.renderingContent[3].category).toBe('text');
    });
  });

  describe('real-world test data', () => {
    it('should correctly process the multi-step thinking message', () => {
      const result = client.migrateMessageRendering(testMessageContent, 'end_turn');

      // Verify stop reason
      expect(result.stopReason).toBe('end_turn');

      // Verify we have multiple groups (alternating backstage and text)
      expect(result.renderingContent.length).toBeGreaterThan(5);

      // First group should be backstage (initial thinking)
      expect(result.renderingContent[0].category).toBe('backstage');
      expect(result.renderingContent[0].blocks[0]).toHaveProperty('type', 'thinking');

      // Find all thinking blocks
      const thinkingBlocks = result.renderingContent
        .filter(g => g.category === 'backstage')
        .flatMap(g => g.blocks)
        .filter(b => b.type === 'thinking');

      expect(thinkingBlocks.length).toBe(3); // Three thinking blocks in the test data

      // Find all web search blocks
      const searchBlocks = result.renderingContent
        .filter(g => g.category === 'backstage')
        .flatMap(g => g.blocks)
        .filter(b => b.type === 'web_search');

      expect(searchBlocks.length).toBe(2); // Two web searches in the test data

      // Verify first search has results
      const firstSearch = searchBlocks[0] as {
        type: 'web_search';
        query: string;
        results: Array<{ title: string; url: string }>;
      };
      expect(firstSearch.query).toBe('capital of Canada');
      expect(firstSearch.results.length).toBeGreaterThan(0);
      expect(firstSearch.results[0].title).toBe('Ottawa - Wikipedia');

      // Verify text blocks contain expected content
      const textBlocks = result.renderingContent
        .filter(g => g.category === 'text')
        .flatMap(g => g.blocks)
        .filter(b => b.type === 'text');

      // Check for consolidated text
      const allText = textBlocks.map(b => (b as { text: string }).text).join('');
      expect(allText).toContain('Step 1: Comment on the Request');
      expect(allText).toContain('Step 3: Result of First Search');
      expect(allText).toContain('Step 5: Result of Second Search');
      expect(allText).toContain('Summary');

      // Check for citations (should be rendered as <a> tags)
      expect(allText).toContain('citation-link');
      expect(allText).toContain('Ottawa - Wikipedia');
    });

    it('should produce text blocks with citations from test data', () => {
      const result = client.migrateMessageRendering(testMessageContent, 'end_turn');

      // Find text blocks with citations
      const textBlocks = result.renderingContent
        .filter(g => g.category === 'text')
        .flatMap(g => g.blocks)
        .filter(b => b.type === 'text');

      const textsWithCitations = textBlocks.filter(b =>
        (b as { text: string }).text.includes('citation-link')
      );

      // Test data has multiple citations
      expect(textsWithCitations.length).toBeGreaterThan(0);

      // Check the Ottawa citation
      const ottawaCitation = textsWithCitations.find(b =>
        (b as { text: string }).text.includes('Ottawa is the capital')
      );
      expect(ottawaCitation).toBeDefined();

      const citationText = (ottawaCitation as { text: string }).text;
      expect(citationText).toContain('https://en.wikipedia.org/wiki/Ottawa');
    });

    it('should match the expected renderingContent snapshot', () => {
      const result = client.migrateMessageRendering(testMessageContent, 'end_turn');

      // This is a snapshot comparison test
      // The expected JSON was generated from the actual output
      // to validate the rendering structure for UI components
      expect(result.renderingContent).toEqual(expectedRenderingContent);
    });
  });
});
