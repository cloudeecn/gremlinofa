import type { RenderingBlockGroup } from '../../../shared/protocol/types/content';
import {
  stripMetadata,
  formatTimestamp,
  formatTokenGroup,
  formatTokenCount,
} from '../../lib/messageFormatters';
import { showAlert } from '../../lib/alerts';
import type { AssistantMessageBubbleProps } from './types';
import BackstageView from './BackstageView';
import ErrorBlockView from './ErrorBlockView';
import TextGroupView from './TextGroupView';
import StopReasonBadge from './StopReasonBadge';

export default function AssistantMessageBubble({
  message,
  onDeleteMessage,
  isVisible,
  focusMode,
  disableMath,
}: AssistantMessageBubbleProps) {
  const renderingContent = message.content.renderingContent as RenderingBlockGroup[];

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(stripMetadata(message.content.content));
      showAlert('Copied', 'Message copied to clipboard');
    } catch (_error) {
      showAlert('Error', 'Failed to copy message');
    }
  };

  const handleDumpMessage = async () => {
    try {
      const messageJson = JSON.stringify(message, null, 2);
      await navigator.clipboard.writeText(messageJson);
      showAlert('Copied', 'Message JSON copied to clipboard');
    } catch (_error) {
      showAlert('Error', 'Failed to copy message JSON');
    }
  };

  // Format context window display
  const formatContextWindow = () => {
    if (!message.metadata?.contextWindowUsage) return '';

    const usage = formatTokenCount(message.metadata.contextWindowUsage);
    if (message.metadata.contextWindow) {
      const max = formatTokenCount(message.metadata.contextWindow);
      return `${usage}/${max}`;
    }
    return usage;
  };

  const visibleGroups = focusMode
    ? renderingContent.filter(g => g.category !== 'backstage')
    : renderingContent;

  const isDummy = message.content.modelFamily === 'ds01-dummy-system';
  const dummyBrief = isDummy
    ? (((message.metadata as Record<string, unknown> | undefined)?.dummyBrief as string) ??
      'intercepted')
    : undefined;

  return (
    <>
      {/* Assistant message content */}
      <div className="w-full">
        {isDummy && dummyBrief && (
          <div className="mb-1 text-xs text-green-700">✨ DUMMY System: {dummyBrief}</div>
        )}
        {visibleGroups.map((group, index) => (
          <div key={index} className="mb-2 last:mb-0">
            {group.category === 'backstage' ? (
              <BackstageView blocks={group.blocks} />
            ) : group.category === 'error' ? (
              <ErrorBlockView blocks={group.blocks} />
            ) : (
              <div className="w-full bg-transparent py-2 text-gray-900">
                <TextGroupView
                  blocks={group.blocks}
                  isVisible={isVisible}
                  disableMath={disableMath}
                />
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Assistant metadata line (hidden in focus mode) */}
      {!focusMode && (
        <div
          className={`mt-1 flex w-full items-center justify-start gap-2 text-[10px] ${isDummy ? 'text-green-700' : 'text-gray-500'}`}
        >
          <span>{formatTimestamp(message.timestamp)}</span>
          <button
            onClick={handleCopy}
            className="transition-colors hover:text-gray-700"
            title="Copy message"
          >
            📋
          </button>
          <button
            onClick={handleDumpMessage}
            className="transition-colors hover:text-gray-700"
            title="Copy message JSON"
          >
            🔍
          </button>
          {onDeleteMessage && (
            <button
              onClick={() => onDeleteMessage(message.id)}
              className="transition-colors hover:text-red-600"
              title="Delete this message"
            >
              ❌
            </button>
          )}

          {message.metadata && (
            <>
              <span className="text-gray-400">|</span>

              {/* Token breakdown */}
              {isDummy ? (
                <span>✨ DUMMY</span>
              ) : (
                <span className="flex items-center gap-1">
                  {formatTokenGroup('↑', message.metadata.inputTokens, [
                    { prefix: 'C↑', value: message.metadata.cacheCreationTokens },
                    { prefix: 'C↓', value: message.metadata.cacheReadTokens },
                  ])}
                  {message.metadata.inputTokens ? ' ' : ''}
                  {formatTokenGroup('↓', message.metadata.outputTokens, [
                    { prefix: 'R:', value: message.metadata.reasoningTokens },
                  ])}
                </span>
              )}

              {/* Context window and cost */}
              {(message.metadata.contextWindowUsage ||
                message.metadata.messageCost !== undefined) && (
                <>
                  <span className="text-gray-400">|</span>
                  <span>
                    {formatContextWindow()}
                    {message.metadata.messageCost !== undefined &&
                      ` $${message.metadata.messageCost.toFixed(3)}`}
                  </span>
                </>
              )}
            </>
          )}

          {/* Stop reason badge for non-normal endings */}
          {message.content.stopReason && message.content.stopReason !== 'end_turn' && (
            <>
              <span className="text-gray-400">|</span>
              <StopReasonBadge stopReason={message.content.stopReason} />
            </>
          )}
        </div>
      )}
    </>
  );
}
