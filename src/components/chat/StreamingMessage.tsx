import { useIsMobile } from '../../hooks/useIsMobile';
import type { RenderingBlockGroup } from '../../types/content';
import type { StreamingMessageProps } from './types';
import BackstageView from './BackstageView';
import BouncingDots from './BouncingDots';

export default function StreamingMessage({ groups }: StreamingMessageProps) {
  const isMobile = useIsMobile();

  // Show waiting indicator when no content yet
  if (groups.length === 0) {
    return (
      <div className="mb-4 px-4">
        <div className={`${isMobile ? 'w-full' : 'max-w-[85%]'}`}>
          <div
            className={`${
              isMobile ? 'py-2' : 'rounded-2xl bg-gray-50 px-4 py-3'
            } flex items-center`}
          >
            <BouncingDots />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mb-4 px-4">
      <div className={`${isMobile ? 'w-full' : 'max-w-[85%]'}`}>
        {/* Render each group */}
        {groups.map((group, groupIndex) => (
          <div key={groupIndex} className="mb-2 last:mb-0">
            {group.category === 'backstage' ? (
              <BackstageView blocks={group.blocks} defaultExpanded={false} />
            ) : group.category === 'error' ? (
              <StreamingErrorView blocks={group.blocks} />
            ) : (
              <StreamingTextView blocks={group.blocks} isMobile={isMobile} />
            )}
          </div>
        ))}

        {/* Streaming indicator */}
        <div className="mt-1">
          <BouncingDots />
        </div>
      </div>
    </div>
  );
}

/**
 * Render text blocks with raw text (no markdown during streaming).
 * Uses whitespace-pre-wrap for proper formatting.
 */
function StreamingTextView({
  blocks,
  isMobile,
}: {
  blocks: RenderingBlockGroup['blocks'];
  isMobile: boolean;
}) {
  // Concatenate all text from text blocks
  const text = blocks
    .filter(block => block.type === 'text')
    .map(block => (block as { type: 'text'; text: string }).text)
    .join('');

  if (!text) return null;

  return (
    <div
      className={
        isMobile
          ? 'w-full bg-transparent py-2 text-gray-900'
          : 'rounded-2xl bg-gray-100 px-4 py-3 text-gray-900 shadow-sm'
      }
    >
      <div className="prose prose-sm max-w-none text-[15px] leading-relaxed whitespace-pre-wrap">
        {text}
      </div>
    </div>
  );
}

/**
 * Render error blocks during streaming.
 */
function StreamingErrorView({ blocks }: { blocks: RenderingBlockGroup['blocks'] }) {
  return (
    <>
      {blocks
        .filter(block => block.type === 'error')
        .map((block, index) => (
          <div
            key={index}
            className="error-block my-2 rounded border border-red-300 bg-red-50 p-3 text-sm text-red-700"
          >
            <span className="mr-2">⚠️</span>
            {(block as { type: 'error'; message: string }).message}
          </div>
        ))}
    </>
  );
}
