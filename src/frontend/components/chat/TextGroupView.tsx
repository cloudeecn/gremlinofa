import { useCallback } from 'react';
import type {
  RenderingContentBlock,
  TextRenderBlock,
  ErrorRenderBlock,
  FallbackRenderBlock,
} from '../../../shared/protocol/types/content';
import { renderMarkdownSafe } from '../../lib/markdownRenderer';

export interface TextGroupViewProps {
  blocks: RenderingContentBlock[];
  isVisible?: boolean;
  disableMath?: boolean;
}

/**
 * TextGroupView renders text content blocks with markdown rendering and syntax highlighting.
 * Handles both text and error blocks.
 * Syntax highlighting is done during markdown parsing (marked → hljs → DOMPurify).
 */
export default function TextGroupView({ blocks, disableMath }: TextGroupViewProps) {
  if (blocks.length === 0) return null;

  return (
    <div className="text-group-view">
      {blocks.map((block, index) => (
        <TextBlock key={index} block={block} disableMath={disableMath} />
      ))}
    </div>
  );
}

interface TextBlockProps {
  block: RenderingContentBlock;
  disableMath?: boolean;
}

function TextBlock({ block, disableMath }: TextBlockProps) {
  switch (block.type) {
    case 'text':
      return <TextSegment block={block} disableMath={disableMath} />;
    case 'error':
      return <ErrorSegment block={block} />;
    case 'fallback':
      return <FallbackSegment block={block} />;
    case 'thinking':
    case 'web_search':
    case 'web_fetch':
    case 'tool_use':
    case 'injected_file':
    case 'tool_info':
    case 'tool_result':
    case 'unknown_block':
    default:
      return null;
  }
}

interface TextSegmentProps {
  block: TextRenderBlock;
  disableMath?: boolean;
}

function TextSegment({ block, disableMath }: TextSegmentProps) {
  const handleClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target.classList.contains('code-copy-button')) {
      e.preventDefault();
      const code = target.dataset.code || '';
      navigator.clipboard.writeText(code).then(() => {
        // Show "Copied!" feedback
        const originalText = target.textContent;
        target.textContent = '✓';
        target.classList.add('copied');
        setTimeout(() => {
          target.textContent = originalText;
          target.classList.remove('copied');
        }, 1500);
      });
    }
  }, []);

  return (
    <div
      className="prose prose-sm max-w-none text-[15px] leading-relaxed"
      onClick={handleClick}
      dangerouslySetInnerHTML={{ __html: renderMarkdownSafe(block.text, { disableMath }) }}
    />
  );
}

interface ErrorSegmentProps {
  block: ErrorRenderBlock;
}

function ErrorSegment({ block }: ErrorSegmentProps) {
  return (
    <div className="error-block my-2 rounded border border-red-300 bg-red-50 p-3 text-sm text-red-700">
      <span className="mr-2">⚠️</span>
      {block.message}
    </div>
  );
}

interface FallbackSegmentProps {
  block: FallbackRenderBlock;
}

function FallbackSegment({ block }: FallbackSegmentProps) {
  const { fromModel, toModel } = block;
  const message = toModel
    ? `This request was handled by ${toModel}${fromModel ? ` instead of ${fromModel}` : ''}.`
    : 'This request was handled by a different model.';
  return (
    <div className="fallback-block my-2 rounded border-l-4 border-amber-400 bg-amber-50 p-3 text-sm text-amber-800">
      <span className="mr-2">ℹ️</span>
      {message}
    </div>
  );
}
