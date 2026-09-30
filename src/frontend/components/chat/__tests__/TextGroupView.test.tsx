import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import TextGroupView from '../TextGroupView';
import type {
  TextRenderBlock,
  ErrorRenderBlock,
  FallbackRenderBlock,
  NotifyRenderBlock,
  RenderingContentBlock,
} from '../../../../shared/protocol/types/content';

// Mock the markdown renderer
const renderMarkdownSafe = vi.fn(
  (content: string, _options?: { disableMath?: boolean; cache?: boolean }) => `<p>${content}</p>`
);
vi.mock('../../../lib/markdownRenderer', () => ({
  renderMarkdownSafe: (content: string, options?: { disableMath?: boolean; cache?: boolean }) =>
    renderMarkdownSafe(content, options),
}));

// Mock clipboard API
const mockWriteText = vi.fn().mockResolvedValue(undefined);
Object.defineProperty(navigator, 'clipboard', {
  value: { writeText: mockWriteText },
  writable: true,
});

describe('TextGroupView', () => {
  describe('basic rendering', () => {
    it('renders nothing when blocks array is empty', () => {
      const { container } = render(<TextGroupView blocks={[]} />);
      expect(container.firstChild).toBeNull();
    });

    it('renders text block with markdown', () => {
      const blocks: RenderingContentBlock[] = [
        { type: 'text', text: 'Hello world' } as TextRenderBlock,
      ];
      render(<TextGroupView blocks={blocks} />);

      expect(screen.getByText('Hello world')).toBeInTheDocument();
    });

    it('renders text with proper prose classes', () => {
      const blocks: RenderingContentBlock[] = [
        { type: 'text', text: 'Styled content' } as TextRenderBlock,
      ];
      const { container } = render(<TextGroupView blocks={blocks} />);

      const proseDiv = container.querySelector('.prose');
      expect(proseDiv).toBeInTheDocument();
      expect(proseDiv).toHaveClass('prose-sm', 'max-w-none');
    });
  });

  describe('error blocks', () => {
    it('renders error block with warning icon', () => {
      const blocks: RenderingContentBlock[] = [
        { type: 'error', message: 'Something went wrong' } as ErrorRenderBlock,
      ];
      render(<TextGroupView blocks={blocks} />);

      expect(screen.getByText('⚠️')).toBeInTheDocument();
      expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    });

    it('renders error block with red styling', () => {
      const blocks: RenderingContentBlock[] = [
        { type: 'error', message: 'Error message' } as ErrorRenderBlock,
      ];
      const { container } = render(<TextGroupView blocks={blocks} />);

      const errorDiv = container.querySelector('.error-block');
      expect(errorDiv).toBeInTheDocument();
      expect(errorDiv).toHaveClass('border-red-300', 'bg-red-50', 'text-red-700');
    });
  });

  describe('fallback blocks', () => {
    it('states the model handoff with amber styling', () => {
      const blocks: RenderingContentBlock[] = [
        {
          type: 'fallback',
          fromModel: 'claude-fable-5',
          toModel: 'claude-opus-4-8',
        } as FallbackRenderBlock,
      ];
      const { container } = render(<TextGroupView blocks={blocks} />);

      expect(
        screen.getByText('This request was handled by claude-opus-4-8 instead of claude-fable-5.')
      ).toBeInTheDocument();
      // Factual only — no claim about a "risky" prompt.
      expect(screen.queryByText(/risky/i)).not.toBeInTheDocument();
      const notice = container.querySelector('.fallback-block');
      expect(notice).toBeInTheDocument();
      expect(notice).toHaveClass('border-amber-400', 'bg-amber-50', 'text-amber-800');
    });

    it('falls back to a generic statement when models are unknown', () => {
      const blocks: RenderingContentBlock[] = [{ type: 'fallback' } as FallbackRenderBlock];
      render(<TextGroupView blocks={blocks} />);

      expect(
        screen.getByText('This request was handled by a different model.')
      ).toBeInTheDocument();
    });
  });

  describe('notify blocks', () => {
    it('renders the notification text with a bell and neutral styling', () => {
      const blocks: RenderingContentBlock[] = [
        {
          type: 'notify',
          text: 'Fable 5 is now using usage credits',
          key: 'fable-usage-credits',
          priority: 'medium',
        } as NotifyRenderBlock,
      ];
      const { container } = render(<TextGroupView blocks={blocks} />);

      expect(screen.getByText('🔔')).toBeInTheDocument();
      expect(screen.getByText('Fable 5 is now using usage credits')).toBeInTheDocument();
      const banner = container.querySelector('.notify-block');
      expect(banner).toHaveClass('border-gray-300', 'bg-gray-50', 'text-gray-600');
    });

    it('tints the banner red for color=error', () => {
      const blocks: RenderingContentBlock[] = [
        {
          type: 'notify',
          text: 'Error compacting conversation',
          color: 'error',
        } as NotifyRenderBlock,
      ];
      const { container } = render(<TextGroupView blocks={blocks} />);

      const banner = container.querySelector('.notify-block');
      expect(banner).toHaveClass('border-red-300', 'bg-red-50', 'text-red-700');
    });

    it('tints the banner red for priority=immediate', () => {
      const blocks: RenderingContentBlock[] = [
        {
          type: 'notify',
          text: 'Fast mode request rejected',
          priority: 'immediate',
        } as NotifyRenderBlock,
      ];
      const { container } = render(<TextGroupView blocks={blocks} />);

      const banner = container.querySelector('.notify-block');
      expect(banner).toHaveClass('border-red-300', 'bg-red-50', 'text-red-700');
    });
  });

  describe('multiple blocks', () => {
    it('renders multiple text blocks in order', () => {
      const blocks: RenderingContentBlock[] = [
        { type: 'text', text: 'First paragraph' } as TextRenderBlock,
        { type: 'text', text: 'Second paragraph' } as TextRenderBlock,
      ];
      render(<TextGroupView blocks={blocks} />);

      expect(screen.getByText('First paragraph')).toBeInTheDocument();
      expect(screen.getByText('Second paragraph')).toBeInTheDocument();
    });

    it('renders mixed text and error blocks', () => {
      const blocks: RenderingContentBlock[] = [
        { type: 'text', text: 'Some text' } as TextRenderBlock,
        { type: 'error', message: 'An error occurred' } as ErrorRenderBlock,
      ];
      render(<TextGroupView blocks={blocks} />);

      expect(screen.getByText('Some text')).toBeInTheDocument();
      expect(screen.getByText('An error occurred')).toBeInTheDocument();
    });
  });

  describe('markdown memoization', () => {
    beforeEach(() => {
      renderMarkdownSafe.mockClear();
    });

    it('does not re-render markdown when the text is unchanged', () => {
      const blocks: RenderingContentBlock[] = [{ type: 'text', text: 'Stable' } as TextRenderBlock];
      const { rerender } = render(<TextGroupView blocks={blocks} />);
      rerender(<TextGroupView blocks={[...blocks]} />);
      rerender(<TextGroupView blocks={[{ type: 'text', text: 'Stable' } as TextRenderBlock]} />);

      expect(renderMarkdownSafe).toHaveBeenCalledTimes(1);
    });

    it('keeps the rendered DOM across re-renders (no innerHTML reassignment)', () => {
      const { container, rerender } = render(
        <TextGroupView blocks={[{ type: 'text', text: 'Keep me' } as TextRenderBlock]} />
      );
      // Stand-in for DOM state a reassignment would wipe (selection, code-copy ✓)
      container.querySelector('p')!.setAttribute('data-marker', 'alive');

      rerender(<TextGroupView blocks={[{ type: 'text', text: 'Keep me' } as TextRenderBlock]} />);

      expect(container.querySelector('p')!.getAttribute('data-marker')).toBe('alive');
    });

    it('re-renders markdown when the text or disableMath changes', () => {
      const { rerender } = render(
        <TextGroupView blocks={[{ type: 'text', text: 'One' } as TextRenderBlock]} />
      );
      rerender(<TextGroupView blocks={[{ type: 'text', text: 'Two' } as TextRenderBlock]} />);
      rerender(
        <TextGroupView blocks={[{ type: 'text', text: 'Two' } as TextRenderBlock]} disableMath />
      );

      expect(renderMarkdownSafe).toHaveBeenCalledTimes(3);
      expect(renderMarkdownSafe).toHaveBeenLastCalledWith('Two', {
        disableMath: true,
        cache: true,
      });
    });

    it('keeps a live reply out of the markdown cache', () => {
      render(
        <TextGroupView blocks={[{ type: 'text', text: 'Partial' } as TextRenderBlock]} streaming />
      );

      expect(renderMarkdownSafe).toHaveBeenLastCalledWith('Partial', {
        disableMath: undefined,
        cache: false,
      });
    });
  });

  describe('citation rendering', () => {
    it('renders citation links from pre-processed text', () => {
      const textWithCitation =
        'Ottawa is the capital<a href="https://example.com" class="citation-link">src</a> of Canada';
      const blocks: RenderingContentBlock[] = [
        { type: 'text', text: textWithCitation } as TextRenderBlock,
      ];

      render(<TextGroupView blocks={blocks} />);

      // The markdown renderer mock wraps it in <p>, but citation should be in there
      expect(screen.getByText(/Ottawa is the capital/)).toBeInTheDocument();
    });
  });

  describe('unknown block types', () => {
    it('ignores unknown block types gracefully', () => {
      const blocks: RenderingContentBlock[] = [
        { type: 'text', text: 'Known text' } as TextRenderBlock,
        { type: 'unknown' as 'text', text: 'Unknown' } as TextRenderBlock,
      ];

      // Should not throw
      const { container } = render(<TextGroupView blocks={blocks} />);
      expect(container.firstChild).toBeInTheDocument();
    });
  });

  describe('code copy button', () => {
    beforeEach(() => {
      mockWriteText.mockClear();
    });

    // The mocked renderer wraps the text in <p>, so a button in the text is
    // what the real renderer's code-copy button looks like to the click handler
    const codeBlock: TextRenderBlock = {
      type: 'text',
      text: '<button class="code-copy-button" data-code="console.log(1)">📋</button>',
    };

    it('copies the code and shows ✓', async () => {
      const { container } = render(<TextGroupView blocks={[codeBlock]} />);
      const copyButton = container.querySelector<HTMLElement>('.code-copy-button')!;

      fireEvent.click(copyButton);

      await waitFor(() => expect(copyButton).toHaveTextContent('✓'));
      expect(mockWriteText).toHaveBeenCalledWith('console.log(1)');
      expect(copyButton).toHaveClass('copied');
    });

    it('shows ✗ when the copy fails', async () => {
      mockWriteText.mockRejectedValueOnce(new Error('denied'));
      const { container } = render(<TextGroupView blocks={[codeBlock]} />);
      const copyButton = container.querySelector<HTMLElement>('.code-copy-button')!;

      fireEvent.click(copyButton);

      await waitFor(() => expect(copyButton).toHaveTextContent('✗'));
      expect(copyButton).toHaveClass('failed');
    });

    it('does not trigger copy for non-copy-button clicks', () => {
      const blocks: RenderingContentBlock[] = [
        { type: 'text', text: 'Regular text' } as TextRenderBlock,
      ];

      render(<TextGroupView blocks={blocks} />);
      fireEvent.click(screen.getByText('Regular text'));

      expect(mockWriteText).not.toHaveBeenCalled();
    });
  });
});
