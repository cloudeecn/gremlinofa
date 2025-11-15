import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import BackstageView from '../BackstageView';
import type {
  WebSearchRenderBlock,
  WebFetchRenderBlock,
  RenderingContentBlock,
} from '../../../types/content';

// Mock useIsMobile hook
vi.mock('../../../hooks/useIsMobile', () => ({
  useIsMobile: () => false,
}));

describe('BackstageView', () => {
  describe('basic rendering', () => {
    it('renders nothing when blocks array is empty', () => {
      const { container } = render(<BackstageView blocks={[]} />);
      expect(container.firstChild).toBeNull();
    });

    it('renders collapsible header with 💭 Think label', () => {
      const blocks: RenderingContentBlock[] = [
        { type: 'thinking', thinking: 'Test thinking content' },
      ];
      render(<BackstageView blocks={blocks} />);

      expect(screen.getByText('💭 Think')).toBeInTheDocument();
    });

    it('is collapsed by default', () => {
      const blocks: RenderingContentBlock[] = [{ type: 'thinking', thinking: 'Hidden content' }];
      render(<BackstageView blocks={blocks} />);

      // Should show the collapse arrow (▶)
      expect(screen.getByText('▶')).toBeInTheDocument();
    });

    it('can be expanded by default when defaultExpanded is true', () => {
      const blocks: RenderingContentBlock[] = [{ type: 'thinking', thinking: 'Visible content' }];
      render(<BackstageView blocks={blocks} defaultExpanded={true} />);

      // Should show the expand arrow (▼)
      expect(screen.getByText('▼')).toBeInTheDocument();
      expect(screen.getByText('Visible content')).toBeInTheDocument();
    });
  });

  describe('collapse/expand toggle', () => {
    it('expands when clicking the header button', () => {
      const blocks: RenderingContentBlock[] = [
        { type: 'thinking', thinking: 'Expandable content' },
      ];
      render(<BackstageView blocks={blocks} />);

      // Click to expand
      fireEvent.click(screen.getByRole('button'));

      expect(screen.getByText('▼')).toBeInTheDocument();
      expect(screen.getByText('Expandable content')).toBeInTheDocument();
    });

    it('collapses when clicking the header button again', () => {
      const blocks: RenderingContentBlock[] = [
        { type: 'thinking', thinking: 'Line 1\nLine 2\nLast line only shown in preview' },
      ];
      render(<BackstageView blocks={blocks} defaultExpanded={true} />);

      // Verify full content is shown when expanded
      expect(screen.getByText(/Line 1/)).toBeInTheDocument();

      // Click to collapse
      fireEvent.click(screen.getByRole('button'));

      expect(screen.getByText('▶')).toBeInTheDocument();
      // When collapsed, full content should not be shown (only preview)
      expect(screen.queryByText(/Line 1/)).not.toBeInTheDocument();
      // But preview (last line) is shown
      expect(screen.getByText('Last line only shown in preview')).toBeInTheDocument();
    });
  });

  describe('preview text', () => {
    it('shows last line of thinking as preview when collapsed', () => {
      const blocks: RenderingContentBlock[] = [
        { type: 'thinking', thinking: 'Line 1\nLine 2\nLast line preview' },
      ];
      render(<BackstageView blocks={blocks} />);

      expect(screen.getByText('Last line preview')).toBeInTheDocument();
    });

    it('shows search query as preview when first block is web_search', () => {
      const blocks: RenderingContentBlock[] = [
        {
          type: 'web_search',
          id: 'ws_1',
          query: 'test search query',
          results: [],
        } as WebSearchRenderBlock,
      ];
      render(<BackstageView blocks={blocks} />);

      expect(screen.getByText('Searched: "test search query"')).toBeInTheDocument();
    });

    it('shows fetch URL as preview when first block is web_fetch', () => {
      const blocks: RenderingContentBlock[] = [
        {
          type: 'web_fetch',
          url: 'https://example.com',
          title: 'Example Page',
        } as WebFetchRenderBlock,
      ];
      render(<BackstageView blocks={blocks} />);

      expect(screen.getByText('Fetched: Example Page')).toBeInTheDocument();
    });
  });

  describe('ThinkingSegment', () => {
    it('renders thinking content with 💭 icon', () => {
      const blocks: RenderingContentBlock[] = [
        { type: 'thinking', thinking: 'My thinking process' },
      ];
      render(<BackstageView blocks={blocks} defaultExpanded={true} />);

      // Find the thinking segment header
      expect(screen.getAllByText('💭').length).toBeGreaterThan(0);
      expect(screen.getByText('Thinking')).toBeInTheDocument();
      expect(screen.getByText('My thinking process')).toBeInTheDocument();
    });

    it('preserves whitespace in thinking content', () => {
      const blocks: RenderingContentBlock[] = [
        { type: 'thinking', thinking: 'Line 1\n  Indented line\nLine 3' },
      ];
      render(<BackstageView blocks={blocks} defaultExpanded={true} />);

      const thinkingDiv = screen.getByText(/Line 1/);
      expect(thinkingDiv).toHaveClass('whitespace-pre-wrap');
    });
  });

  describe('WebSearchSegment', () => {
    const searchBlock: WebSearchRenderBlock = {
      type: 'web_search',
      id: 'ws_2',
      query: 'capital of Canada',
      results: [
        { title: 'Ottawa - Wikipedia', url: 'https://en.wikipedia.org/wiki/Ottawa' },
        { title: 'Britannica', url: 'https://www.britannica.com/place/Ottawa' },
      ],
    };

    it('renders search query with 🔍 icon', () => {
      render(<BackstageView blocks={[searchBlock]} defaultExpanded={true} />);

      expect(screen.getByText('🔍')).toBeInTheDocument();
      expect(screen.getByText(/Searched: "capital of Canada"/)).toBeInTheDocument();
    });

    it('shows result count', () => {
      render(<BackstageView blocks={[searchBlock]} defaultExpanded={true} />);

      expect(screen.getByText('(2 results)')).toBeInTheDocument();
    });

    it('has collapsible results (collapsed by default)', () => {
      render(<BackstageView blocks={[searchBlock]} defaultExpanded={true} />);

      // Results should not be visible by default
      expect(screen.queryByText('Ottawa - Wikipedia')).not.toBeInTheDocument();
    });

    it('expands results when clicking search header', () => {
      render(<BackstageView blocks={[searchBlock]} defaultExpanded={true} />);

      // Click the search header to expand results
      const searchHeader = screen.getByText(/Searched: "capital of Canada"/).closest('button');
      fireEvent.click(searchHeader!);

      expect(screen.getByText('Ottawa - Wikipedia')).toBeInTheDocument();
      expect(screen.getByText('Britannica')).toBeInTheDocument();
    });

    it('renders result links with correct href and target', () => {
      render(<BackstageView blocks={[searchBlock]} defaultExpanded={true} />);

      // Expand results
      const searchHeader = screen.getByText(/Searched: "capital of Canada"/).closest('button');
      fireEvent.click(searchHeader!);

      const link = screen.getByText('Ottawa - Wikipedia');
      expect(link).toHaveAttribute('href', 'https://en.wikipedia.org/wiki/Ottawa');
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    });
  });

  describe('WebFetchSegment', () => {
    it('renders fetch with 🌐 icon', () => {
      const blocks: RenderingContentBlock[] = [
        {
          type: 'web_fetch',
          url: 'https://example.com/page',
          title: 'Example Page',
        } as WebFetchRenderBlock,
      ];
      render(<BackstageView blocks={blocks} defaultExpanded={true} />);

      expect(screen.getByText('🌐')).toBeInTheDocument();
      expect(screen.getByText('Fetched')).toBeInTheDocument();
    });

    it('renders title as link when title is provided', () => {
      const blocks: RenderingContentBlock[] = [
        {
          type: 'web_fetch',
          url: 'https://example.com/page',
          title: 'Example Page',
        } as WebFetchRenderBlock,
      ];
      render(<BackstageView blocks={blocks} defaultExpanded={true} />);

      const link = screen.getByText('Example Page');
      expect(link).toHaveAttribute('href', 'https://example.com/page');
    });

    it('renders URL as link when no title is provided', () => {
      const blocks: RenderingContentBlock[] = [
        {
          type: 'web_fetch',
          url: 'https://example.com/page',
        } as WebFetchRenderBlock,
      ];
      render(<BackstageView blocks={blocks} defaultExpanded={true} />);

      const link = screen.getByText('https://example.com/page');
      expect(link).toHaveAttribute('href', 'https://example.com/page');
    });
  });

  describe('multiple blocks', () => {
    it('renders multiple thinking blocks', () => {
      const blocks: RenderingContentBlock[] = [
        { type: 'thinking', thinking: 'First thought' },
        { type: 'thinking', thinking: 'Second thought' },
      ];
      render(<BackstageView blocks={blocks} defaultExpanded={true} />);

      expect(screen.getByText('First thought')).toBeInTheDocument();
      expect(screen.getByText('Second thought')).toBeInTheDocument();
    });

    it('renders mixed block types in order', () => {
      const blocks: RenderingContentBlock[] = [
        { type: 'thinking', thinking: 'Initial thinking' },
        {
          type: 'web_search',
          id: 'ws_3',
          query: 'test query',
          results: [{ title: 'Result', url: 'https://example.com' }],
        } as WebSearchRenderBlock,
        { type: 'thinking', thinking: 'Post-search thinking' },
      ];
      render(<BackstageView blocks={blocks} defaultExpanded={true} />);

      expect(screen.getByText('Initial thinking')).toBeInTheDocument();
      expect(screen.getByText(/Searched: "test query"/)).toBeInTheDocument();
      expect(screen.getByText('Post-search thinking')).toBeInTheDocument();
    });
  });
});
