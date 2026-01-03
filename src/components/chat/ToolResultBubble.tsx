import { useState } from 'react';
import type { RenderingBlockGroup, ToolResultRenderBlock } from '../../types/content';
import type { Message } from '../../types';
import { formatTimestamp } from '../../utils/messageFormatters';

export interface ToolResultBubbleProps {
  message: Message<unknown>;
}

/**
 * Renders a tool result message (role: USER but contains tool_result blocks).
 * Shows as a collapsible backstage-style element.
 */
export default function ToolResultBubble({ message }: ToolResultBubbleProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  // Extract tool_result blocks from renderingContent (normalized format for all APIs)
  const renderingContent = message.content.renderingContent as RenderingBlockGroup[] | undefined;
  const toolResults =
    renderingContent
      ?.flatMap(group => group.blocks)
      .filter((b): b is ToolResultRenderBlock => b.type === 'tool_result') ?? [];

  if (toolResults.length === 0) return null;

  const hasError = toolResults.some(r => r.is_error);

  return (
    <div className="flex flex-col items-start">
      <div className="max-w-[85%] overflow-hidden rounded-r-lg border-l-4 border-purple-400 bg-purple-50">
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm font-medium text-purple-800 transition-colors hover:bg-purple-100"
        >
          <span className="flex items-center gap-2">
            <span>{hasError ? '❌' : '✅'}</span>
            <span>tool_result</span>
            <span className="text-purple-600">{isExpanded ? '▼' : '▶'}</span>
          </span>
          {!isExpanded && (
            <span className="flex-1 truncate text-xs font-normal text-purple-600">
              {toolResults.length === 1
                ? toolResults[0].content.slice(0, 50)
                : `${toolResults.length} results`}
            </span>
          )}
        </button>

        {isExpanded && (
          <div className="border-t border-purple-200 bg-white px-4 py-3">
            {toolResults.map((result, index) => (
              <div key={index} className="mb-2 last:mb-0">
                {toolResults.length > 1 && (
                  <div className="mb-1 text-xs font-medium text-purple-700">
                    Result {index + 1}
                    {result.is_error && ' (error)'}
                  </div>
                )}
                <pre className="overflow-x-auto rounded bg-gray-100 p-2 text-xs whitespace-pre-wrap text-gray-700">
                  {result.content}
                </pre>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Timestamp */}
      <div className="mt-1 text-[10px] text-gray-500">{formatTimestamp(message.timestamp)}</div>
    </div>
  );
}
