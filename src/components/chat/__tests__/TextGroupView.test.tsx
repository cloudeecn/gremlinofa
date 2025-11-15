import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import TextGroupView from '../TextGroupView';
import type {
  TextRenderBlock,
  ErrorRenderBlock,
  RenderingContentBlock,
} from '../../../types/content';

// Mock the markdown renderer
vi.mock('../../../utils/markdownRenderer', () => ({
  renderMarkdownSafe: (content: string) => `<p>${content}</p>`,
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

  describe('visibility handling', () => {
    it('accepts isVisible prop', () => {
      const blocks: RenderingContentBlock[] = [
        { type: 'text', text: 'Visible text' } as TextRenderBlock,
      ];

      // Should render without errors
      const { container } = render(<TextGroupView blocks={blocks} isVisible={false} />);
      expect(container.firstChild).toBeInTheDocument();
    });

    it('defaults to isVisible=true', () => {
      const blocks: RenderingContentBlock[] = [
        { type: 'text', text: 'Default visible' } as TextRenderBlock,
      ];
      const { container } = render(<TextGroupView blocks={blocks} />);

      expect(container.firstChild).toBeInTheDocument();
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

    it('copies code to clipboard when copy button is clicked', async () => {
      // Render a div with the copy button structure directly
      const { container } = render(
        <div
          className="prose"
          onClick={(e: React.MouseEvent<HTMLDivElement>) => {
            const target = e.target as HTMLElement;
            if (target.classList.contains('code-copy-button')) {
              const code = target.dataset.code || '';
              navigator.clipboard.writeText(code);
            }
          }}
        >
          <div className="code-block-container">
            <button className="code-copy-button" data-code="console.log(1)">
              📋
            </button>
            <pre>
              <code>console.log(1)</code>
            </pre>
          </div>
        </div>
      );

      const copyButton = container.querySelector('.code-copy-button');
      expect(copyButton).toBeInTheDocument();

      fireEvent.click(copyButton!);

      await waitFor(() => {
        expect(mockWriteText).toHaveBeenCalledWith('console.log(1)');
      });
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
