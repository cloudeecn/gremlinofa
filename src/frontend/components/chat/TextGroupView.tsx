import { useCallback, useMemo } from 'react';
import type {
  RenderingContentBlock,
  TextRenderBlock,
  ErrorRenderBlock,
  FallbackRenderBlock,
  NotifyRenderBlock,
} from '../../../shared/protocol/types/content';
import { copyText } from '../../lib/clipboard';
import { renderMarkdownSafe } from '../../lib/markdownRenderer';

export interface TextGroupViewProps {
  blocks: RenderingContentBlock[];
  disableMath?: boolean;
  /** Live reply: render without storing each partial text in the markdown cache */
  streaming?: boolean;
}

/**
 * TextGroupView renders text content blocks with markdown rendering and syntax highlighting.
 * Handles both text and error blocks.
 * Syntax highlighting is done during markdown parsing (marked → hljs → DOMPurify).
 */
export default function TextGroupView({ blocks, disableMath, streaming }: TextGroupViewProps) {
  if (blocks.length === 0) return null;

  return (
    <div className="text-group-view">
      {blocks.map((block, index) => (
        <TextBlock key={index} block={block} disableMath={disableMath} streaming={streaming} />
      ))}
    </div>
  );
}

interface TextBlockProps {
  block: RenderingContentBlock;
  disableMath?: boolean;
  streaming?: boolean;
}

function TextBlock({ block, disableMath, streaming }: TextBlockProps) {
  switch (block.type) {
    case 'text':
      return <TextSegment block={block} disableMath={disableMath} streaming={streaming} />;
    case 'error':
      return <ErrorSegment block={block} />;
    case 'fallback':
      return <FallbackSegment block={block} />;
    case 'notify':
      return <NotifySegment block={block} />;
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
  streaming?: boolean;
}

function TextSegment({ block, disableMath, streaming }: TextSegmentProps) {
  const handleClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (!target.classList.contains('code-copy-button')) return;
    e.preventDefault();
    // Still showing feedback from the last click
    if (target.classList.contains('copied') || target.classList.contains('failed')) return;
    void copyText(target.dataset.code || '').then(copied => {
      const originalText = target.textContent;
      const feedbackClass = copied ? 'copied' : 'failed';
      target.textContent = copied ? '✓' : '✗';
      target.classList.add(feedbackClass);
      setTimeout(() => {
        target.textContent = originalText;
        target.classList.remove(feedbackClass);
      }, 1500);
    });
  }, []);

  // Memoize the wrapper object, not just the string: React 19 compares
  // `dangerouslySetInnerHTML` by object identity and reassigns innerHTML on any
  // new object — re-parsing the whole message and wiping selection and the
  // code-copy ✓ on every re-render.
  const innerHtml = useMemo(
    () => ({ __html: renderMarkdownSafe(block.text, { disableMath, cache: !streaming }) }),
    [block.text, disableMath, streaming]
  );

  return (
    <div
      className="prose prose-sm max-w-none text-[15px] leading-relaxed"
      onClick={handleClick}
      dangerouslySetInnerHTML={innerHtml}
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

interface NotifySegmentProps {
  block: NotifyRenderBlock;
}

function NotifySegment({ block }: NotifySegmentProps) {
  const isWarning = block.color === 'error' || block.priority === 'immediate';
  const tone = isWarning
    ? 'border-red-300 bg-red-50 text-red-700'
    : 'border-gray-300 bg-gray-50 text-gray-600';
  return (
    <div className={`notify-block my-2 rounded border-l-4 p-3 text-sm ${tone}`}>
      <span className="mr-2">🔔</span>
      {block.text}
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
