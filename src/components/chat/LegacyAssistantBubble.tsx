import {
  stripMetadata,
  formatTimestamp,
  formatTokens,
  formatTokenCount,
} from '../../utils/messageFormatters';
import { renderMarkdownSafe } from '../../utils/markdownRenderer';
import { showAlert } from '../../utils/alerts';
import { useIsMobile } from '../../hooks/useIsMobile';
import type { LegacyAssistantBubbleProps } from './types';
import StopReasonBadge from './StopReasonBadge';

export default function LegacyAssistantBubble({ message }: LegacyAssistantBubbleProps) {
  const isMobile = useIsMobile();

  // Strip metadata from content before displaying
  const displayContent = stripMetadata(message.content.content);

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

  return (
    <>
      {/* Legacy assistant message content */}
      <div
        className={
          isMobile
            ? 'w-full bg-transparent py-2 text-gray-900'
            : 'w-full rounded-2xl bg-gray-100 px-4 py-3 text-gray-900 shadow-sm'
        }
      >
        <div
          className="prose prose-sm max-w-none text-[15px] leading-relaxed"
          dangerouslySetInnerHTML={{ __html: renderMarkdownSafe(displayContent) }}
        />
      </div>

      {/* Assistant metadata line */}
      <div
        className={`mt-1 flex w-full items-center justify-start gap-2 text-[10px] text-gray-500`}
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

        {message.metadata && (
          <>
            <span className="text-gray-400">|</span>

            {/* Token breakdown */}
            <span className="flex items-center gap-1">
              {formatTokens('↑', message.metadata.inputTokens)}
              {message.metadata.inputTokens ? ' ' : ''}
              {formatTokens('↓', message.metadata.outputTokens)}
              {formatTokens(' R:', message.metadata.reasoningTokens)}
              {formatTokens(' C↑', message.metadata.cacheCreationTokens)}
              {formatTokens(' C↓', message.metadata.cacheReadTokens)}
            </span>

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
    </>
  );
}
