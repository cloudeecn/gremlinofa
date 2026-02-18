import { useState } from 'react';
import type { RenderingBlockGroup, ToolResultRenderBlock } from '../../types/content';
import type { Message } from '../../types';
import { formatTimestamp, formatTokens } from '../../utils/messageFormatters';
import { usePreferences } from '../../hooks/usePreferences';
import ToolResultView from './ToolResultView';

export interface ToolResultBubbleProps {
  message: Message<unknown>;
  onAction?: (action: 'copy' | 'fork' | 'edit' | 'delete' | 'resend', messageId: string) => void;
}

/**
 * Renders a tool result message (role: USER but contains tool_result blocks).
 *
 * Two rendering paths based on renderingGroups:
 * 1. Results with renderingGroups → ToolResultView (complex, expanded view)
 * 2. Simple results → collapsible purple group
 */
export default function ToolResultBubble({ message, onAction }: ToolResultBubbleProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const { iconOnRight } = usePreferences();

  // Extract tool_result blocks from renderingContent
  const renderingContent = message.content.renderingContent as RenderingBlockGroup[] | undefined;
  const toolResults =
    renderingContent
      ?.flatMap(group => group.blocks)
      .filter((b): b is ToolResultRenderBlock => b.type === 'tool_result') ?? [];

  if (toolResults.length === 0) return null;

  // Split by whether they have renderingGroups (complex vs simple)
  const simpleResults = toolResults.filter(
    r => !r.renderingGroups || r.renderingGroups.length === 0
  );
  const complexResults = toolResults.filter(r => r.renderingGroups && r.renderingGroups.length > 0);

  const hasSimple = simpleResults.length > 0;
  const hasError = simpleResults.some(r => r.is_error);

  // For simple results header display
  const lastSimple = simpleResults[simpleResults.length - 1];
  const simpleIcon = lastSimple?.icon ?? (hasError ? '❌' : '✅');
  const simplePreviewText = lastSimple?.renderedContent ?? lastSimple?.content ?? '';

  // Status-aware summary for multiple results
  const getStatusSummary = (): string => {
    if (simpleResults.length === 1 && simpleResults[0].status !== 'pending')
      return simplePreviewText;
    const pending = toolResults.filter(r => !r.status || r.status === 'pending').length;
    const running = simpleResults.filter(r => r.status === 'running').length;
    const completed = simpleResults.filter(
      r => r.status === 'complete' || r.status === 'error'
    ).length;
    // All complete (or old messages without status field) → simple count
    if (pending === 0 && running === 0) return `${simpleResults.length} results`;
    const parts: string[] = [];
    if (pending > 0) parts.push(`${pending} pending`);
    if (running > 0) parts.push(`${running} running`);
    if (completed > 0) parts.push(`${completed} completed`);
    return parts.join(' ');
  };

  return (
    <div className="flex flex-col items-start">
      {/* Simple tool results in collapsible group */}
      {hasSimple && (
        <div className="mb-2 w-full overflow-hidden rounded-r-lg border-l-4 border-purple-400 bg-purple-50">
          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm font-medium text-purple-800 transition-colors hover:bg-purple-100"
          >
            <span className="flex shrink-0 items-center gap-1">
              <span>{!iconOnRight && simpleIcon}</span>
              <span className="text-purple-600">{isExpanded ? '▼' : '▶'}</span>
            </span>
            {!isExpanded && (
              <>
                {/* Overflow-to-left: outer clips, inner aligns right so end of text stays visible */}
                <span className="flex min-w-0 overflow-hidden">
                  <span className="flex max-w-full justify-end overflow-hidden text-xs font-normal whitespace-nowrap text-purple-600">
                    {getStatusSummary()}
                  </span>
                </span>
                <span className="min-w-0 flex-1 overflow-hidden"></span>
                {/* Show result icons on right */}
                {simpleResults.length > 1 && (
                  <span className="flex shrink-0 items-center gap-1">
                    {iconOnRight ? (
                      <>
                        <span className="text-shadow-[0 0] tracking-[-0.5em] opacity-50 text-shadow-white">
                          {simpleResults
                            .slice(0, -1)
                            .map(r => r.icon ?? (r.is_error ? '❌' : '✅'))}
                        </span>
                        <span className="mr-2">{simpleIcon}</span>
                      </>
                    ) : (
                      <span className="text-shadow-[0 0] mr-2 tracking-[-0.5em] opacity-50 text-shadow-white">
                        {simpleResults.slice(0, -1).map(r => r.icon ?? (r.is_error ? '❌' : '✅'))}
                      </span>
                    )}
                  </span>
                )}
                {simpleResults.length === 1 && iconOnRight && (
                  <span className="mr-2 shrink-0">{simpleIcon}</span>
                )}
              </>
            )}
          </button>

          {isExpanded && (
            <div className="border-t border-purple-200 bg-white px-4 py-3">
              {simpleResults.map((result, index) => (
                <div key={index} className="mb-3 last:mb-0">
                  <button
                    onClick={e => e.stopPropagation()}
                    className={`mb-1 flex items-center gap-1 text-xs font-medium ${
                      result.is_error ? 'text-red-600' : 'text-purple-700'
                    }`}
                  >
                    <span>{result.icon ?? (result.is_error ? '❌' : '✅')}</span>
                    {simpleResults.length > 1 && (
                      <span className="text-purple-500">
                        ({index + 1}/{simpleResults.length})
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
      )}

      {/* Complex results (with renderingGroups) rendered via ToolResultView */}
      {complexResults.map((result, index) => (
        <div key={`complex-${index}`} className="mb-2 w-full">
          <ToolResultView block={result} />
        </div>
      ))}

      {/* Timestamp, cost, and actions — hidden while any tool is still in progress */}
      {toolResults.every(r => !r.status || r.status === 'complete' || r.status === 'error') && (
        <div className="mt-1 flex items-center gap-2">
          <span className="text-[10px] text-gray-500">{formatTimestamp(message.timestamp)}</span>
          {(message.metadata?.messageCost ?? 0) > 0 && message.metadata && (
            <span className="text-[10px] text-gray-500">
              <span className="text-gray-400">|</span>{' '}
              {formatTokens('↑', message.metadata.inputTokens)}
              {message.metadata.inputTokens ? ' ' : ''}
              {formatTokens('↓', message.metadata.outputTokens)} $
              {message.metadata.messageCost!.toFixed(3)}
            </span>
          )}
          {onAction && (
            <>
              <button
                onClick={() => onAction('resend', message.id)}
                className="text-[10px] text-gray-400 transition-colors hover:text-blue-600"
                title="Resend from here"
              >
                🔄
              </button>
              <button
                onClick={() => onAction('delete', message.id)}
                className="text-[10px] text-gray-400 transition-colors hover:text-red-600"
                title="Delete this message and all after"
              >
                🗑️
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
