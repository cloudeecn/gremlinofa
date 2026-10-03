import { useState } from 'react';
import type { RenderingBlockGroup } from '../../../shared/protocol/types/content';
import { stripMetadata, formatContextWindow } from '../../lib/messageFormatters';
import { coerceToString } from '../../../shared/lib/coerceToString';
import CopyButton from '../ui/CopyButton';
import type { AssistantMessageBubbleProps } from './types';
import AssistantGroups from './AssistantGroups';
import ClaudeAgentDebugModal from './ClaudeAgentDebugModal';
import StopReasonBadge from './StopReasonBadge';
import MessageInfoBar, { INFO_BAR_BUTTON } from './MessageInfoBar';

export default function AssistantMessageBubble({
  message,
  onAction,
  onDeleteMessage,
  disableMath,
  isLastMessage,
  expandedGroups,
}: AssistantMessageBubbleProps) {
  const renderingContent = (message.content.renderingContent ?? []) as RenderingBlockGroup[];
  const [showAgentDebug, setShowAgentDebug] = useState(false);
  const claudeAgentUuid = message.metadata?.claudeAgentMessageUuid;

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
        <AssistantGroups
          groups={renderingContent}
          disableMath={disableMath}
          expandedGroups={expandedGroups}
        />
      </div>

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
        quickActions={
          <CopyButton
            getText={() => stripMetadata(message.content.content)}
            label="📋"
            title="Copy message"
            className={`${INFO_BAR_BUTTON} hover:text-gray-700`}
          />
        }
        actions={
          <>
            <CopyButton
              getText={() => JSON.stringify(message, null, 2)}
              label="🔍"
              title="Copy message JSON"
              className={`${INFO_BAR_BUTTON} hover:text-gray-700`}
            />
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
