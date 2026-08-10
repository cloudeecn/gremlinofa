import { useState } from 'react';
import type { RenderingBlockGroup } from '../../../shared/protocol/types/content';
import { stripMetadata, formatContextWindow } from '../../lib/messageFormatters';
import { showAlert } from '../../lib/alerts';
import { coerceToString } from '../../../shared/lib/coerceToString';
import type { AssistantMessageBubbleProps } from './types';
import BackstageView from './BackstageView';
import ClaudeAgentDebugModal from './ClaudeAgentDebugModal';
import ErrorBlockView from './ErrorBlockView';
import TextGroupView from './TextGroupView';
import StopReasonBadge from './StopReasonBadge';
import MessageInfoBar, { INFO_BAR_BUTTON } from './MessageInfoBar';

export default function AssistantMessageBubble({
  message,
  onAction,
  onDeleteMessage,
  isVisible,
  focusMode,
  disableMath,
  isLastMessage,
}: AssistantMessageBubbleProps) {
  const renderingContent = (message.content.renderingContent ?? []) as RenderingBlockGroup[];
  const [showAgentDebug, setShowAgentDebug] = useState(false);
  const claudeAgentUuid = message.metadata?.claudeAgentMessageUuid;

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

  const visibleGroups = focusMode
    ? renderingContent.filter(g => g.category !== 'backstage')
    : renderingContent;

  const isDummy = message.content.modelFamily === 'ds01-dummy-system';
  const dummyBrief = isDummy
    ? coerceToString((message.metadata as Record<string, unknown> | undefined)?.dummyBrief) ||
      'intercepted'
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

      {/* Assistant info bar (hidden in focus mode) */}
      {!focusMode && (
        <MessageInfoBar
          timestamp={message.timestamp}
          tone={isDummy ? 'dummy' : 'default'}
          model={
            isDummy
              ? undefined
              : { requested: message.metadata?.model, served: message.metadata?.servedModel }
          }
          contextText={formatContextWindow(
            message.metadata?.contextWindowUsage,
            message.metadata?.contextWindow
          )}
          cost={message.metadata?.messageCost}
          tokens={isDummy ? undefined : message.metadata}
          badge={
            isDummy ? (
              <span>✨ DUMMY</span>
            ) : message.content.stopReason && message.content.stopReason !== 'end_turn' ? (
              <StopReasonBadge stopReason={message.content.stopReason} />
            ) : undefined
          }
          actions={
            <>
              <button
                onClick={handleCopy}
                className={`${INFO_BAR_BUTTON} hover:text-gray-700`}
                title="Copy message"
              >
                📋
              </button>
              <button
                onClick={handleDumpMessage}
                className={`${INFO_BAR_BUTTON} hover:text-gray-700`}
                title="Copy message JSON"
              >
                🔍
              </button>
              {claudeAgentUuid && (
                <button
                  onClick={() => setShowAgentDebug(true)}
                  className={`${INFO_BAR_BUTTON} hover:text-gray-700`}
                  title="View SDK session entry"
                >
                  🔬
                </button>
              )}
              {onAction && !isLastMessage && (
                <button
                  onClick={() => onAction('rollback', message.id)}
                  className={`${INFO_BAR_BUTTON} hover:text-orange-600`}
                  title="Roll back to here"
                >
                  ⏪
                </button>
              )}
              {onDeleteMessage && (
                <button
                  onClick={() => onDeleteMessage(message.id)}
                  className={`${INFO_BAR_BUTTON} hover:text-red-600`}
                  title="Delete this message"
                >
                  ❌
                </button>
              )}
            </>
          }
        />
      )}

      {claudeAgentUuid && showAgentDebug && (
        <ClaudeAgentDebugModal
          onClose={() => setShowAgentDebug(false)}
          sessionId={message.metadata?.claudeAgentSessionId}
          messageUuid={claudeAgentUuid}
        />
      )}
    </>
  );
}
