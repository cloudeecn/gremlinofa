import { useState } from 'react';
import type {
  RenderingContentBlock,
  ThinkingRenderBlock,
  WebSearchRenderBlock,
  WebFetchRenderBlock,
  ToolUseRenderBlock,
  ToolResultRenderBlock,
} from '../../types/content';
import { usePreferences } from '../../hooks/usePreferences';

export interface BackstageViewProps {
  blocks: RenderingContentBlock[];
  defaultExpanded?: boolean;
}

/**
 * BackstageView renders collapsible backstage content (thinking, web search, web fetch).
 * All backstage blocks in a group are rendered together under a single collapsible header.
 */
export default function BackstageView({ blocks, defaultExpanded = false }: BackstageViewProps) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);
  const { iconOnRight } = usePreferences();

  if (blocks.length === 0) return null;

  const getIcon = (block: RenderingContentBlock): string => {
    switch (block?.type) {
      case 'thinking':
        return '💭';
      case 'web_search':
        return '🔍';
      case 'web_fetch':
        return '🌐';
      case 'tool_use':
        return `${block.icon ?? '🔧'}`;
      case 'tool_result':
        return `${block.icon ?? (block.is_error ? '❌' : '✅')}`;
      case 'error':
        return '❌';
      case 'text':
      default:
        return '💬';
    }
  };

  const getStatusText = (): string => {
    const lastBlock = blocks[blocks.length - 1];
    switch (lastBlock?.type) {
      case 'thinking':
        return 'Think';
      case 'web_search':
        return 'Search';
      case 'web_fetch':
        return 'Fetch';
      case 'tool_use':
        return lastBlock.name;
      case 'tool_result':
        return lastBlock.name ?? 'Result';
      case 'error':
        return 'Error';
      case 'text':
      default:
        return '';
    }
  };

  // Get preview text from last block for collapsed state (shows current streaming content)
  const getPreviewText = (): string => {
    const lastBlock = blocks[blocks.length - 1];
    switch (lastBlock?.type) {
      case 'thinking': {
        // Extract only the last line to show what's currently being streamed
        const text = lastBlock.thinking || '';
        const lines = text.split('\n');
        return lines[lines.length - 1] || '';
      }
      case 'web_search':
        return `"${lastBlock.query || ''}"`;
      case 'web_fetch':
        return lastBlock.title || lastBlock.url || '';
      case 'tool_use':
        return lastBlock.renderedInput ?? JSON.stringify(lastBlock.input);
      case 'tool_result':
        return lastBlock.renderedContent ?? lastBlock.content;
      case 'text':
      case 'error':
      default:
        return '';
    }
  };

  // Check if last block is instant (tool_use/tool_result) for overflow-to-left rendering
  const isInstantBlock = (): boolean => {
    const lastBlock = blocks[blocks.length - 1];
    return lastBlock?.type !== 'thinking';
  };

  const getLastBlockIcon = (): string => {
    return getIcon(blocks[blocks.length - 1]);
  };

  const getPreviousBlockIcons = (): string[] => {
    return blocks.slice(0, blocks.length - 1).map(block => getIcon(block));
  };

  const instantBlock = isInstantBlock();

  return (
    <div className="backstage-container overflow-hidden rounded-r-lg border-l-4 border-purple-400 bg-purple-50">
      {/* Collapsible header */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm font-medium text-purple-800 transition-colors hover:bg-purple-100"
      >
        <span className="flex shrink-0 items-center gap-1">
          <span>
            {!iconOnRight && getLastBlockIcon()} {getStatusText()}
          </span>
          <span className="text-purple-600">{isExpanded ? '▼' : '▶'}</span>
        </span>
        {!isExpanded && (
          <>
            {instantBlock ? (
              // Overflow-to-left: outer clips, inner aligns right so end of text stays visible
              <>
                <span className="flex min-w-0 overflow-hidden">
                  <span className="flex max-w-full justify-end overflow-hidden text-xs font-normal whitespace-nowrap text-purple-600">
                    {getPreviewText()}
                  </span>
                </span>
                <span className="min-w-0 flex-1 overflow-hidden"></span>
              </>
            ) : (
              // Standard truncate for streaming content (thinking, search, fetch)
              <span className="min-w-0 flex-1 truncate text-xs font-normal whitespace-nowrap text-purple-600">
                {getPreviewText()}
              </span>
            )}
            <span className="flex shrink-0 items-center gap-1">
              {iconOnRight ? (
                // All icons on right: previous icons faded, last icon full opacity
                <>
                  <span className="text-shadow-[0 0] tracking-[-0.5em] opacity-50 text-shadow-white">
                    {getPreviousBlockIcons()}
                  </span>
                  <span className="mr-2">{getLastBlockIcon()}</span>
                </>
              ) : (
                // Default: previous icons on right (faded)
                <span className="text-shadow-[0 0] mr-2 tracking-[-0.5em] opacity-50 text-shadow-white">
                  {getPreviousBlockIcons()}
                </span>
              )}
            </span>
          </>
        )}
      </button>

      {/* Expanded content */}
      {isExpanded && (
        <div className="border-t border-purple-200 bg-white px-4 py-3">
          {blocks.map((block, index) => (
            <BackstageBlock key={index} block={block} />
          ))}
        </div>
      )}
    </div>
  );
}

interface BackstageBlockProps {
  block: RenderingContentBlock;
}

function BackstageBlock({ block }: BackstageBlockProps) {
  switch (block.type) {
    case 'thinking':
      return <ThinkingSegment block={block} />;
    case 'web_search':
      return <WebSearchSegment block={block} />;
    case 'web_fetch':
      return <WebFetchSegment block={block} />;
    case 'tool_use':
      return <ToolUseSegment block={block} />;
    case 'tool_result':
      return <ToolResultSegment block={block} />;
    case 'text':
    case 'error':
    default:
      return null;
  }
}

interface ThinkingSegmentProps {
  block: ThinkingRenderBlock;
}

function ThinkingSegment({ block }: ThinkingSegmentProps) {
  return (
    <div className="backstage-segment mb-3 last:mb-0">
      <div className="mb-1 flex items-center gap-1 text-xs font-medium text-purple-700">
        <span>💭</span>
        <span>Thinking</span>
      </div>
      <div className="text-sm whitespace-pre-wrap text-gray-700">{block.thinking}</div>
    </div>
  );
}

interface WebSearchSegmentProps {
  block: WebSearchRenderBlock;
}

function WebSearchSegment({ block }: WebSearchSegmentProps) {
  const [resultsExpanded, setResultsExpanded] = useState(false);

  return (
    <div className="backstage-segment mb-3 last:mb-0">
      <button
        onClick={() => setResultsExpanded(!resultsExpanded)}
        className="mb-1 flex items-center gap-1 text-xs font-medium text-purple-700 hover:text-purple-900"
      >
        <span>🔍</span>
        <span>Searched: &quot;{block.query}&quot;</span>
        <span className="text-purple-500">{resultsExpanded ? '▼' : '▶'}</span>
        <span className="text-purple-500">({block.results.length} results)</span>
      </button>

      {resultsExpanded && (
        <div className="web-search-results ml-4 border-l-2 border-purple-200 pl-3">
          {block.results.map((result, index) => (
            <div key={index} className="mb-2 last:mb-0">
              <a
                href={result.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-blue-600 hover:underline"
              >
                {result.title}
              </a>
              <div className="truncate text-xs text-gray-500">{result.url}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

interface WebFetchSegmentProps {
  block: WebFetchRenderBlock;
}

function WebFetchSegment({ block }: WebFetchSegmentProps) {
  return (
    <div className="backstage-segment mb-3 last:mb-0">
      <div className="mb-1 flex items-center gap-1 text-xs font-medium text-purple-700">
        <span>🌐</span>
        <span>Fetched</span>
      </div>
      <a
        href={block.url}
        target="_blank"
        rel="noopener noreferrer"
        className="text-sm text-blue-600 hover:underline"
      >
        {block.title || block.url}
      </a>
      {block.title && <div className="truncate text-xs text-gray-500">{block.url}</div>}
    </div>
  );
}

interface ToolUseSegmentProps {
  block: ToolUseRenderBlock;
}

function ToolUseSegment({ block }: ToolUseSegmentProps) {
  const [inputExpanded, setInputExpanded] = useState(false);

  // Use persisted fields if available, fall back to JSON for backward compatibility
  const icon = block.icon ?? '🔧';
  const hasInput = Object.keys(block.input).length > 0;
  const renderedInput =
    block.renderedInput ?? (hasInput ? JSON.stringify(block.input, null, 2) : '');

  return (
    <div className="backstage-segment mb-3 last:mb-0">
      <div className="mb-1 flex items-center gap-1 text-xs font-medium text-purple-700">
        <span>{icon}</span>
        <span>Called: {block.name}</span>
        {hasInput && (
          <button
            onClick={() => setInputExpanded(!inputExpanded)}
            className="text-purple-500 hover:text-purple-700"
          >
            {inputExpanded ? '▼' : '▶'}
          </button>
        )}
      </div>

      {hasInput && inputExpanded && (
        <pre className="ml-4 overflow-x-auto rounded bg-gray-100 p-2 text-xs text-gray-700">
          {renderedInput}
        </pre>
      )}
    </div>
  );
}

interface ToolResultSegmentProps {
  block: ToolResultRenderBlock;
}

function ToolResultSegment({ block }: ToolResultSegmentProps) {
  const [contentExpanded, setContentExpanded] = useState(false);

  // Use persisted fields if available, fall back to defaults for backward compatibility
  const defaultIcon = block.is_error ? '❌' : '✅';
  const icon = block.icon ?? defaultIcon;
  const renderedContent = block.renderedContent ?? block.content;

  return (
    <div className="backstage-segment mb-3 last:mb-0">
      <button
        onClick={() => setContentExpanded(!contentExpanded)}
        className={`mb-1 flex items-center gap-1 text-xs font-medium hover:text-purple-900 ${
          block.is_error ? 'text-red-600' : 'text-purple-700'
        }`}
      >
        <span>{icon}</span>
        <span>{block.name ?? 'Result'}</span>
        <span className="text-purple-500">{contentExpanded ? '▼' : '▶'}</span>
      </button>

      {contentExpanded && (
        <pre className="ml-4 overflow-x-auto rounded bg-gray-100 p-2 text-xs whitespace-pre-wrap text-gray-700">
          {renderedContent}
        </pre>
      )}
    </div>
  );
}
