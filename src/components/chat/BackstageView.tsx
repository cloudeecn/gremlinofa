import { useState } from 'react';
import type {
  RenderingContentBlock,
  ThinkingRenderBlock,
  WebSearchRenderBlock,
  WebFetchRenderBlock,
  ToolUseRenderBlock,
  ToolResultRenderBlock,
} from '../../types/content';

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

  if (blocks.length === 0) return null;

  // Get icon for last block (shows current activity type)
  const getStatus = (): string => {
    const lastBlock = blocks[blocks.length - 1];
    switch (lastBlock?.type) {
      case 'thinking':
        return '💭 Think';
      case 'web_search':
        return '🔍 Search';
      case 'web_fetch':
        return '🌐 Browse';
      case 'tool_use':
        return '🔧 Tool';
      case 'tool_result':
        return '📤 Result';
      case 'text':
      case 'error':
      default:
        return '💬 Wat?';
    }
  };

  // Get preview text from last block for collapsed state (shows current streaming content)
  const getPreviewText = (): string => {
    const lastBlock = blocks[blocks.length - 1];
    switch (lastBlock?.type) {
      case 'thinking': {
        const thinking = lastBlock.thinking || '';
        const lastLine = thinking.trim().split('\n').pop() || '';
        return lastLine;
      }
      case 'web_search':
        return `Searched: "${lastBlock.query || ''}"`;
      case 'web_fetch':
        return `Fetched: ${lastBlock.title || lastBlock.url || ''}`;
      case 'tool_use':
        return lastBlock.name;
      case 'tool_result':
        return lastBlock.is_error ? '❌ Error' : lastBlock.content.slice(0, 50);
      case 'text':
      case 'error':
      default:
        return '';
    }
  };

  const status = getStatus();

  return (
    <div className="backstage-container overflow-hidden rounded-r-lg border-l-4 border-purple-400 bg-purple-50">
      {/* Collapsible header */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm font-medium text-purple-800 transition-colors hover:bg-purple-100"
      >
        <span className="flex items-center gap-2">
          <span>{status}</span>
          <span className="text-purple-600">{isExpanded ? '▼' : '▶'}</span>
        </span>
        {!isExpanded && (
          <span className="flex-1 truncate text-xs font-normal text-purple-600">
            {getPreviewText()}
          </span>
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
  const hasInput = Object.keys(block.input).length > 0;
  const inputJson = hasInput ? JSON.stringify(block.input, null, 2) : '';

  return (
    <div className="backstage-segment mb-3 last:mb-0">
      <div className="mb-1 flex items-center gap-1 text-xs font-medium text-purple-700">
        <span>🔧</span>
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
          {inputJson}
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

  return (
    <div className="backstage-segment mb-3 last:mb-0">
      <button
        onClick={() => setContentExpanded(!contentExpanded)}
        className={`mb-1 flex items-center gap-1 text-xs font-medium hover:text-purple-900 ${
          block.is_error ? 'text-red-600' : 'text-purple-700'
        }`}
      >
        <span>{block.is_error ? '❌' : '✅'}</span>
        <span>tool_result</span>
        <span className="text-purple-500">{contentExpanded ? '▼' : '▶'}</span>
      </button>

      {contentExpanded && (
        <pre className="ml-4 overflow-x-auto rounded bg-gray-100 p-2 text-xs whitespace-pre-wrap text-gray-700">
          {block.content}
        </pre>
      )}
    </div>
  );
}
