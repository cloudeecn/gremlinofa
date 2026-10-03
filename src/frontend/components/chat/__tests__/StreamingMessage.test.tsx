import { fireEvent, render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import StreamingMessage from '../StreamingMessage';
import { clearMarkdownCache, markdownCacheSize } from '../../../lib/markdownRenderer';
import type { RenderingBlockGroup } from '../../../../shared/protocol/types/content';

// Mock useIsMobile hook
vi.mock('../../../hooks/useIsMobile', () => ({
  useIsMobile: vi.fn(() => false),
}));

import { useIsMobile } from '../../../hooks/useIsMobile';

describe('StreamingMessage', () => {
  beforeEach(() => {
    vi.mocked(useIsMobile).mockReturnValue(false);
  });

  describe('empty groups (waiting state)', () => {
    it('renders bouncing dots when groups is empty', () => {
      const { container } = render(<StreamingMessage groups={[]} />);

      // Check for bouncing dots
      const dots = container.querySelectorAll('.bouncing-dot');
      expect(dots.length).toBe(3);
    });

    it('renders same layout for mobile and desktop in waiting state', () => {
      // Waiting state (empty groups) uses a simple layout without mobile/desktop differentiation
      vi.mocked(useIsMobile).mockReturnValue(true);
      const { container, rerender } = render(<StreamingMessage groups={[]} />);

      const mobileContainer = container.querySelector('.mb-4.px-4');
      expect(mobileContainer).toBeInTheDocument();

      // Same layout for desktop
      vi.mocked(useIsMobile).mockReturnValue(false);
      rerender(<StreamingMessage groups={[]} />);

      const desktopContainer = container.querySelector('.mb-4.px-4');
      expect(desktopContainer).toBeInTheDocument();
    });
  });

  describe('bouncing dots indicator', () => {
    it('shows bouncing dots when streaming thinking', () => {
      const groups: RenderingBlockGroup[] = [
        {
          category: 'backstage',
          blocks: [{ type: 'thinking', thinking: 'Let me think...' }],
        },
      ];

      const { container } = render(<StreamingMessage groups={groups} />);

      // Check for bouncing dots
      const dots = container.querySelectorAll('.bouncing-dot');
      expect(dots.length).toBe(3);
    });

    it('shows bouncing dots when streaming text', () => {
      const groups: RenderingBlockGroup[] = [
        {
          category: 'text',
          blocks: [{ type: 'text', text: 'Hello world' }],
        },
      ];

      const { container } = render(<StreamingMessage groups={groups} />);

      // Check for bouncing dots
      const dots = container.querySelectorAll('.bouncing-dot');
      expect(dots.length).toBe(3);
    });

    it('shows bouncing dots when streaming web search', () => {
      const groups: RenderingBlockGroup[] = [
        {
          category: 'backstage',
          blocks: [{ type: 'web_search', id: 'ws_1', query: 'test query', results: [] }],
        },
      ];

      const { container } = render(<StreamingMessage groups={groups} />);

      // Check for bouncing dots
      const dots = container.querySelectorAll('.bouncing-dot');
      expect(dots.length).toBe(3);
    });

    it('shows bouncing dots when streaming web fetch', () => {
      const groups: RenderingBlockGroup[] = [
        {
          category: 'backstage',
          blocks: [{ type: 'web_fetch', url: 'https://example.com' }],
        },
      ];

      const { container } = render(<StreamingMessage groups={groups} />);

      // Check for bouncing dots
      const dots = container.querySelectorAll('.bouncing-dot');
      expect(dots.length).toBe(3);
    });

    it('shows bouncing dots even when error is present', () => {
      const groups: RenderingBlockGroup[] = [
        {
          category: 'error',
          blocks: [{ type: 'error', message: 'Something went wrong' }],
        },
      ];

      const { container } = render(<StreamingMessage groups={groups} />);

      // Check for bouncing dots
      const dots = container.querySelectorAll('.bouncing-dot');
      expect(dots.length).toBe(3);
    });
  });

  describe('backstage content rendering', () => {
    it('renders BackstageView for backstage category groups', () => {
      const groups: RenderingBlockGroup[] = [
        {
          category: 'backstage',
          blocks: [{ type: 'thinking', thinking: 'Processing your request...' }],
        },
      ];

      render(<StreamingMessage groups={groups} />);

      // With iconOnRight: true, icon on right (no state text label)
      expect(screen.getByText('💭')).toBeInTheDocument();
    });

    it('renders backstage collapsed by default (during streaming)', () => {
      const groups: RenderingBlockGroup[] = [
        {
          category: 'backstage',
          blocks: [{ type: 'thinking', thinking: 'Line 1\nLine 2\nPreview line' }],
        },
      ];

      render(<StreamingMessage groups={groups} />);

      // Backstage should be collapsed during streaming
      expect(screen.getByText('▶')).toBeInTheDocument(); // Collapsed arrow
      // Preview shows only the last line (for streaming visibility)
      expect(screen.getByText(/Preview line/)).toBeInTheDocument();
      // The "Thinking" label in expanded segment should NOT be visible when collapsed
      expect(screen.queryByText('Thinking')).not.toBeInTheDocument();
    });
  });

  describe('text content rendering', () => {
    it('renders markdown while streaming, like the finished message', () => {
      const groups: RenderingBlockGroup[] = [
        {
          category: 'text',
          blocks: [{ type: 'text', text: '**bold** and _italic_' }],
        },
      ];

      const { container } = render(<StreamingMessage groups={groups} />);

      expect(container.querySelector('strong')).toHaveTextContent('bold');
      expect(container.querySelector('em')).toHaveTextContent('italic');
    });

    it('renders every text block', () => {
      const groups: RenderingBlockGroup[] = [
        {
          category: 'text',
          blocks: [
            { type: 'text', text: 'First part' },
            { type: 'text', text: 'Second part' },
          ],
        },
      ];

      render(<StreamingMessage groups={groups} />);

      expect(screen.getByText('First part')).toBeInTheDocument();
      expect(screen.getByText('Second part')).toBeInTheDocument();
    });

    it('uses the finished message container on every screen size', () => {
      for (const isMobile of [false, true]) {
        vi.mocked(useIsMobile).mockReturnValue(isMobile);
        const groups: RenderingBlockGroup[] = [
          { category: 'text', blocks: [{ type: 'text', text: 'Hello' }] },
        ];

        const { container, unmount } = render(<StreamingMessage groups={groups} />);

        expect(container.querySelector('[class*="rounded-2xl"]')).toBeNull();
        expect(screen.getByText('Hello').closest('div.bg-transparent')).toBeInTheDocument();
        unmount();
      }
    });

    it('respects Disable Math', () => {
      const groups: RenderingBlockGroup[] = [
        { category: 'text', blocks: [{ type: 'text', text: 'Energy: $E = mc^2$' }] },
      ];

      const { container, rerender } = render(<StreamingMessage groups={groups} />);
      expect(container.querySelector('.katex')).toBeInTheDocument();

      rerender(<StreamingMessage groups={groups} disableMath />);
      expect(container.querySelector('.katex')).toBeNull();
      expect(screen.getByText(/\$E = mc\^2\$/)).toBeInTheDocument();
    });

    it('does not store partial text in the markdown cache', () => {
      clearMarkdownCache();
      const groups: RenderingBlockGroup[] = [
        { category: 'text', blocks: [{ type: 'text', text: 'partial reply' }] },
      ];

      render(<StreamingMessage groups={groups} />);

      expect(screen.getByText('partial reply')).toBeInTheDocument();
      expect(markdownCacheSize()).toBe(0);
    });
  });

  describe('error content rendering', () => {
    it('renders errors the same way as a finished message', () => {
      const groups: RenderingBlockGroup[] = [
        {
          category: 'error',
          blocks: [{ type: 'error', message: 'API Error: Rate limited' }],
        },
      ];

      const { container } = render(<StreamingMessage groups={groups} />);

      expect(screen.getByText('❌ Error')).toBeInTheDocument();
      expect(screen.getByText('API Error: Rate limited')).toBeInTheDocument();
      expect(container.querySelector('.error-container')).toHaveClass('bg-red-50');
    });

    it('lists every error once expanded', () => {
      const groups: RenderingBlockGroup[] = [
        {
          category: 'error',
          blocks: [
            { type: 'error', message: 'Error 1' },
            { type: 'error', message: 'Error 2' },
          ],
        },
      ];

      render(<StreamingMessage groups={groups} />);
      fireEvent.click(screen.getByText('❌ Error'));

      expect(screen.getByText('Error 1')).toBeInTheDocument();
      expect(screen.getByText('Error 2')).toBeInTheDocument();
    });
  });

  describe('multiple groups rendering', () => {
    it('renders groups in order', () => {
      const groups: RenderingBlockGroup[] = [
        {
          category: 'backstage',
          blocks: [{ type: 'thinking', thinking: 'First thinking preview' }],
        },
        {
          category: 'text',
          blocks: [{ type: 'text', text: 'First text' }],
        },
        {
          category: 'backstage',
          blocks: [{ type: 'thinking', thinking: 'Second thinking preview' }],
        },
      ];

      render(<StreamingMessage groups={groups} />);

      // Backstage is collapsed during streaming, check previews and text
      expect(screen.getByText('First thinking preview')).toBeInTheDocument(); // Preview
      expect(screen.getByText('First text')).toBeInTheDocument();
      expect(screen.getByText('Second thinking preview')).toBeInTheDocument(); // Preview
      // Both backstage headers should be rendered (with iconOnRight: true, icon on right)
      expect(screen.getAllByText('💭')).toHaveLength(2);
    });

    it('shows bouncing dots for multiple groups', () => {
      const groups: RenderingBlockGroup[] = [
        {
          category: 'text',
          blocks: [{ type: 'text', text: 'Some text' }],
        },
        {
          category: 'backstage',
          blocks: [{ type: 'thinking', thinking: 'Still thinking...' }],
        },
      ];

      const { container } = render(<StreamingMessage groups={groups} />);

      // Should always show bouncing dots
      const dots = container.querySelectorAll('.bouncing-dot');
      expect(dots.length).toBe(3);
    });
  });

  describe('interleaved content pattern', () => {
    it('handles thinking → text → search → thinking → text pattern', () => {
      const groups: RenderingBlockGroup[] = [
        {
          category: 'backstage',
          blocks: [{ type: 'thinking', thinking: 'Initial thought' }],
        },
        {
          category: 'text',
          blocks: [{ type: 'text', text: 'First response' }],
        },
        {
          category: 'backstage',
          blocks: [
            { type: 'web_search', id: 'ws_2', query: 'capital of Canada', results: [] },
            { type: 'thinking', thinking: 'Processing results' },
          ],
        },
        {
          category: 'text',
          blocks: [{ type: 'text', text: 'Final answer' }],
        },
      ];

      const { container } = render(<StreamingMessage groups={groups} />);

      // Backstage is collapsed during streaming - check previews instead of full content
      // First backstage: thinking with single line shows as preview
      expect(screen.getByText('Initial thought')).toBeInTheDocument();
      // Text groups are always visible
      expect(screen.getByText('First response')).toBeInTheDocument();
      // Second backstage: has web_search + thinking, preview shows LAST block (thinking)
      expect(screen.getByText('Processing results')).toBeInTheDocument();
      expect(screen.getByText('Final answer')).toBeInTheDocument();

      // Two backstage headers (collapsed) - with iconOnRight: true, icon on right
      expect(screen.getAllByText('💭')).toHaveLength(2);

      // Should show bouncing dots (not status text)
      const dots = container.querySelectorAll('.bouncing-dot');
      expect(dots.length).toBe(3);
    });
  });

  it('renders backstage, text and error groups', () => {
    const groups: RenderingBlockGroup[] = [
      {
        category: 'backstage',
        blocks: [{ type: 'thinking', thinking: 'Visible thinking' }],
      },
      {
        category: 'text',
        blocks: [{ type: 'text', text: 'Visible text' }],
      },
      {
        category: 'error',
        blocks: [{ type: 'error', message: 'Visible error' }],
      },
    ];

    render(<StreamingMessage groups={groups} />);

    expect(screen.getByText('Visible thinking')).toBeInTheDocument();
    expect(screen.getByText('Visible text')).toBeInTheDocument();
    expect(screen.getByText('Visible error')).toBeInTheDocument();
  });
});
