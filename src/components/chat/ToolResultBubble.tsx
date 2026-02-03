import { useState } from 'react';
import type { RenderingBlockGroup, ToolResultRenderBlock } from '../../types/content';
import type { Message } from '../../types';
import { formatTimestamp } from '../../utils/messageFormatters';
import { usePreferences } from '../../hooks/usePreferences';

export interface ToolResultBubbleProps {
  message: Message<unknown>;
  onAction?: (action: 'copy' | 'fork' | 'edit' | 'delete', messageId: string) => void;
}

/**
 * Renders a tool result message (role: USER but contains tool_result blocks).
 * Styled to match BackstageView - purple theme, collapsible, shows tool name.
 */
export default function ToolResultBubble({ message, onAction }: ToolResultBubbleProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const { iconOnRight } = usePreferences();

  // Extract tool_result blocks from renderingContent (normalized format for all APIs)
  const renderingContent = message.content.renderingContent as RenderingBlockGroup[] | undefined;
  const toolResults =
    renderingContent
      ?.flatMap(group => group.blocks)
      .filter((b): b is ToolResultRenderBlock => b.type === 'tool_result') ?? [];

  if (toolResults.length === 0) return null;

  const hasError = toolResults.some(r => r.is_error);
  const lastResult = toolResults[toolResults.length - 1];

  // Use persisted fields, with fallbacks for old messages
  const icon = lastResult.icon ?? (hasError ? '❌' : '✅');
  const statusText = lastResult.name ?? 'Result';
  const previewText = lastResult.renderedContent ?? lastResult.content;

  return (
    <div className="flex flex-col items-start">
      <div className="w-full overflow-hidden rounded-r-lg border-l-4 border-purple-400 bg-purple-50">
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm font-medium text-purple-800 transition-colors hover:bg-purple-100"
        >
          <span className="flex shrink-0 items-center gap-1">
            <span>
              {!iconOnRight && icon} {statusText}
            </span>
            <span className="text-purple-600">{isExpanded ? '▼' : '▶'}</span>
          </span>
          {!isExpanded && (
            <>
              {/* Overflow-to-left: outer clips, inner aligns right so end of text stays visible */}
              <span className="flex min-w-0 overflow-hidden">
                <span className="flex max-w-full justify-end overflow-hidden text-xs font-normal whitespace-nowrap text-purple-600">
                  {toolResults.length === 1 ? previewText : `${toolResults.length} results`}
                </span>
              </span>
              <span className="min-w-0 flex-1 overflow-hidden"></span>
              {/* Show result icons on right */}
              {toolResults.length > 1 && (
                <span className="flex shrink-0 items-center gap-1">
                  {iconOnRight ? (
                    // All icons on right: previous icons faded, last icon full opacity
                    <>
                      <span className="text-shadow-[0 0] tracking-[-0.5em] opacity-50 text-shadow-white">
                        {toolResults.slice(0, -1).map(r => r.icon ?? (r.is_error ? '❌' : '✅'))}
                      </span>
                      <span className="mr-2">{icon}</span>
                    </>
                  ) : (
                    // Default: previous icons on right (faded)
                    <span className="text-shadow-[0 0] mr-2 tracking-[-0.5em] opacity-50 text-shadow-white">
                      {toolResults.slice(0, -1).map(r => r.icon ?? (r.is_error ? '❌' : '✅'))}
                    </span>
                  )}
                </span>
              )}
              {/* Single result with iconOnRight: show the icon */}
              {toolResults.length === 1 && iconOnRight && (
                <span className="mr-2 shrink-0">{icon}</span>
              )}
            </>
          )}
        </button>

        {isExpanded && (
          <div className="border-t border-purple-200 bg-white px-4 py-3">
            {toolResults.map((result, index) => (
              <div key={index} className="mb-3 last:mb-0">
                <button
                  onClick={e => e.stopPropagation()}
                  className={`mb-1 flex items-center gap-1 text-xs font-medium ${
                    result.is_error ? 'text-red-600' : 'text-purple-700'
                  }`}
                >
                  <span>{result.icon ?? (result.is_error ? '❌' : '✅')}</span>
                  <span>{result.name ?? 'Result'}</span>
                  {toolResults.length > 1 && (
                    <span className="text-purple-500">
                      ({index + 1}/{toolResults.length})
                    </span>
                  )}
                </button>
                <pre className="ml-4 overflow-x-auto rounded bg-gray-100 p-2 text-xs whitespace-pre-wrap text-gray-700">
                  {result.renderedContent ?? result.content}
                </pre>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Timestamp and actions */}
      <div className="mt-1 flex items-center gap-2">
        <span className="text-[10px] text-gray-500">{formatTimestamp(message.timestamp)}</span>
        {onAction && (
          <button
            onClick={() => onAction('delete', message.id)}
            className="text-[10px] text-gray-400 transition-colors hover:text-red-600"
            title="Delete this message and all after"
          >
            🗑️
          </button>
        )}
      </div>
    </div>
  );
}
