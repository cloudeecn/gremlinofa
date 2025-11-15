import { useState, useEffect } from 'react';
import type { RenderingContentBlock, ErrorRenderBlock } from '../../types/content';
import { mapStackString, isProductionBuild } from '../../utils/stackTraceMapper';

export interface ErrorBlockViewProps {
  blocks: RenderingContentBlock[];
  defaultExpanded?: boolean;
}

/**
 * ErrorBlockView renders error blocks with collapsible stack traces.
 * Shows error message by default, expands to reveal stack trace when clicked.
 */
export default function ErrorBlockView({ blocks, defaultExpanded = false }: ErrorBlockViewProps) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);

  // Filter to only error blocks
  const errorBlocks = blocks.filter((b): b is ErrorRenderBlock => b.type === 'error');

  if (errorBlocks.length === 0) return null;

  // Get preview from first error
  const firstError = errorBlocks[0];
  const previewMessage = firstError.message.split('\n')[0]; // First line only
  const hasStack = errorBlocks.some(b => b.stack);

  return (
    <div className="error-container overflow-hidden rounded-r-lg border-l-4 border-red-400 bg-red-50">
      {/* Collapsible header */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm font-medium text-red-800 transition-colors hover:bg-red-100"
      >
        <span className="flex items-center gap-2">
          <span>❌ Error</span>
          {hasStack && <span className="text-red-600">{isExpanded ? '▼' : '▶'}</span>}
        </span>
        {!isExpanded && (
          <span className="flex-1 truncate text-xs font-normal text-red-600">{previewMessage}</span>
        )}
      </button>

      {/* Expanded content */}
      {isExpanded && (
        <div className="border-t border-red-200 bg-white px-4 py-3">
          {errorBlocks.map((block, index) => (
            <ErrorSegment key={index} block={block} />
          ))}
        </div>
      )}
    </div>
  );
}

interface ErrorSegmentProps {
  block: ErrorRenderBlock;
}

function ErrorSegment({ block }: ErrorSegmentProps) {
  // null = not started, undefined = mapping in progress, string = mapped result
  const [mappedStack, setMappedStack] = useState<string | null | undefined>(
    block.stack && isProductionBuild() ? undefined : null
  );

  // Map stack trace to original source locations in production
  useEffect(() => {
    if (!block.stack || !isProductionBuild()) return;

    let cancelled = false;
    mapStackString(block.stack).then(mapped => {
      if (!cancelled) {
        setMappedStack(mapped);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [block.stack]);

  const isMapping = mappedStack === undefined;
  const displayStack = mappedStack || block.stack;

  return (
    <div className="error-segment mb-3 last:mb-0">
      {/* Status code if present */}
      {block.status && (
        <div className="mb-1 text-xs font-medium text-red-700">HTTP {block.status}</div>
      )}

      {/* Error message */}
      <div className="mb-2 text-sm whitespace-pre-wrap text-red-800">{block.message}</div>

      {/* Stack trace */}
      {block.stack && (
        <div className="mt-2 overflow-x-auto rounded bg-gray-100 p-2">
          <div className="mb-1 flex items-center gap-2">
            {mappedStack && (
              <span className="rounded bg-green-100 px-1.5 py-0.5 text-xs text-green-700">
                Source Mapped
              </span>
            )}
            {isMapping && (
              <span className="rounded bg-yellow-100 px-1.5 py-0.5 text-xs text-yellow-700">
                Mapping...
              </span>
            )}
          </div>
          <pre className="text-xs text-gray-700">{displayStack}</pre>
        </div>
      )}
    </div>
  );
}
