import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import StreamingMessage from '../StreamingMessage';
import type { RenderingBlockGroup } from '../../../types/content';

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

      // With iconOnRight: true, label on left, icon on right
      expect(screen.getByText('Think')).toBeInTheDocument();
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
    it('renders raw text without markdown processing', () => {
      const groups: RenderingBlockGroup[] = [
        {
          category: 'text',
          blocks: [{ type: 'text', text: '**bold** and _italic_' }],
        },
      ];

      render(<StreamingMessage groups={groups} />);

      // Should show raw markdown syntax, not rendered HTML
      expect(screen.getByText('**bold** and _italic_')).toBeInTheDocument();
    });

    it('concatenates multiple text blocks', () => {
      const groups: RenderingBlockGroup[] = [
        {
          category: 'text',
          blocks: [
            { type: 'text', text: 'First part ' },
            { type: 'text', text: 'Second part' },
          ],
        },
      ];

      render(<StreamingMessage groups={groups} />);

      expect(screen.getByText('First part Second part')).toBeInTheDocument();
    });

    it('applies whitespace-pre-wrap class for proper formatting', () => {
      const groups: RenderingBlockGroup[] = [
        {
          category: 'text',
          blocks: [{ type: 'text', text: 'Line 1\nLine 2' }],
        },
      ];

      const { container } = render(<StreamingMessage groups={groups} />);

      // Find the element with whitespace-pre-wrap class
      const textContainer = container.querySelector('.whitespace-pre-wrap');
      expect(textContainer).toBeInTheDocument();
      expect(textContainer?.textContent).toBe('Line 1\nLine 2');
    });

    it('applies desktop bubble styling', () => {
      vi.mocked(useIsMobile).mockReturnValue(false);

      const groups: RenderingBlockGroup[] = [
        {
          category: 'text',
          blocks: [{ type: 'text', text: 'Hello' }],
        },
      ];

      render(<StreamingMessage groups={groups} />);

      const bubble = screen.getByText('Hello').closest('div[class*="rounded-2xl"]');
      expect(bubble).toHaveClass('bg-gray-100');
      expect(bubble).toHaveClass('shadow-sm');
    });

    it('applies mobile transparent styling', () => {
      vi.mocked(useIsMobile).mockReturnValue(true);

      const groups: RenderingBlockGroup[] = [
        {
          category: 'text',
          blocks: [{ type: 'text', text: 'Hello' }],
        },
      ];

      render(<StreamingMessage groups={groups} />);

      const bubble = screen.getByText('Hello').closest('div[class*="bg-transparent"]');
      expect(bubble).toBeInTheDocument();
    });

    it('does not render text view when blocks are empty', () => {
      const groups: RenderingBlockGroup[] = [
        {
          category: 'text',
          blocks: [{ type: 'text', text: '' }],
        },
      ];

      render(<StreamingMessage groups={groups} />);

      // Should only show status text, no bubble
      const bubbles = document.querySelectorAll('[class*="rounded-2xl bg-gray-100"]');
      expect(bubbles.length).toBe(0);
    });
  });

  describe('error content rendering', () => {
    it('renders error blocks with warning icon', () => {
      const groups: RenderingBlockGroup[] = [
        {
          category: 'error',
          blocks: [{ type: 'error', message: 'API Error: Rate limited' }],
        },
      ];

      render(<StreamingMessage groups={groups} />);

      expect(screen.getByText('⚠️')).toBeInTheDocument();
      expect(screen.getByText('API Error: Rate limited')).toBeInTheDocument();
    });

    it('renders multiple error blocks', () => {
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

      expect(screen.getByText('Error 1')).toBeInTheDocument();
      expect(screen.getByText('Error 2')).toBeInTheDocument();
    });

    it('applies error styling with red border', () => {
      const groups: RenderingBlockGroup[] = [
        {
          category: 'error',
          blocks: [{ type: 'error', message: 'Test error' }],
        },
      ];

      render(<StreamingMessage groups={groups} />);

      const errorBlock = screen.getByText('Test error').closest('div');
      expect(errorBlock).toHaveClass('border-red-300');
      expect(errorBlock).toHaveClass('bg-red-50');
      expect(errorBlock).toHaveClass('text-red-700');
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
      // Both backstage headers should be rendered (with iconOnRight: true, label and icon separate)
      expect(screen.getAllByText('Think')).toHaveLength(2);
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

      // Two backstage headers (collapsed) - with iconOnRight: true, label and icon separate
      expect(screen.getAllByText('Think')).toHaveLength(2);
      expect(screen.getAllByText('💭')).toHaveLength(2);

      // Should show bouncing dots (not status text)
      const dots = container.querySelectorAll('.bouncing-dot');
      expect(dots.length).toBe(3);
    });
  });
});
