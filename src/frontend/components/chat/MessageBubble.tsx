import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { type MessageAttachment } from '../../../shared/protocol/types';
import type { RenderingBlockGroup } from '../../../shared/protocol/types/content';
import { gremlinClient } from '../../client';
import { isToolResultMessage } from '../../lib/messageFormatters';
import type { MessageBubbleProps } from './types';
import UserMessageBubble from './UserMessageBubble';
import AssistantMessageBubble from './AssistantMessageBubble';
import ToolResultBubble from './ToolResultBubble';

function MessageBubble({
  message,
  onAction,
  actions,
  onDeleteMessage,
  isHidden,
  onRegister,
  onMeasureHeight,
  getHeight,
  focusMode,
  expandMinions,
  disableMath,
  isLastMessage,
  isClaudeAgentChat,
  expandedGroups,
}: MessageBubbleProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [attachments, setAttachments] = useState<MessageAttachment[]>([]);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);

  const isUser = message.role === 'user';

  // Load attachments the first time the message renders in full. The bubble
  // stays mounted behind its placeholder, so scrolling back into view must not
  // fetch and decrypt them again.
  const attachmentIds = message.content.attachmentIds;
  const attachmentKey = attachmentIds?.length ? `${message.id}:${attachmentIds.join(',')}` : null;
  const [loadedAttachmentKey, setLoadedAttachmentKey] = useState<string | null>(null);
  useEffect(() => {
    if (isHidden || !attachmentKey || loadedAttachmentKey === attachmentKey) return;

    let cancelled = false;
    gremlinClient
      .getAttachments(message.id)
      .then(loaded => {
        if (cancelled) return;
        setLoadedAttachmentKey(attachmentKey);
        setAttachments(loaded);
      })
      .catch(error => {
        console.error('Failed to load attachments:', error);
      });
    return () => {
      cancelled = true;
    };
  }, [isHidden, attachmentKey, loadedAttachmentKey, message.id]);

  // Ref callback: Register with IntersectionObserver and measure immediately
  const measureRef = useCallback(
    (node: HTMLDivElement | null) => {
      containerRef.current = node;

      if (node) {
        // Register with IntersectionObserver
        onRegister(message.id, node);

        // Measure height synchronously
        const height = node.getBoundingClientRect().height;
        if (height > 0) {
          onMeasureHeight(message.id, height);
        }
      } else {
        // Unregister when unmounting
        onRegister(message.id, null);
      }
    },
    [message.id, onRegister, onMeasureHeight]
  );

  // Measure height with ResizeObserver while rendered in full (for dynamic changes like thinking expansion)
  useEffect(() => {
    if (isHidden || !containerRef.current) return;

    const container = containerRef.current;

    // Create ResizeObserver to track height changes
    resizeObserverRef.current = new ResizeObserver(entries => {
      for (const entry of entries) {
        const height = entry.target.getBoundingClientRect().height;
        if (height > 0) {
          onMeasureHeight(message.id, height);
        }
      }
    });

    resizeObserverRef.current.observe(container);

    return () => {
      resizeObserverRef.current?.disconnect();
      resizeObserverRef.current = null;
    };
  }, [isHidden, message.id, onMeasureHeight]);

  // Placeholder only for messages the observer moved out of the buffer AND that
  // have a real measurement (no estimated heights). Read here, not passed as a
  // prop, so a height change doesn't re-render a visible bubble.
  const placeholderHeight = isHidden ? getHeight(message.id) : undefined;
  if (placeholderHeight) {
    return (
      <div
        ref={measureRef}
        style={{ height: `${placeholderHeight}px` }}
        className="mb-4 px-4"
        aria-hidden="true"
      />
    );
  }

  const renderingContent = message.content.renderingContent as RenderingBlockGroup[] | undefined;

  const isToolResult = isToolResultMessage(message);

  // In focus mode, hide tool result messages unless expandMinions is on and they have complex results
  if (focusMode && isToolResult) {
    const hasComplexResults =
      expandMinions &&
      renderingContent
        ?.flatMap(g => g.blocks)
        .some(b => b.type === 'tool_result' && b.renderingGroups && b.renderingGroups.length > 0);

    if (!hasComplexResults) {
      // Zero height (no margin) so hidden tool results don't stack up as gaps;
      // still registered so the element keeps its slot in the observers.
      return <div ref={measureRef} aria-hidden="true" />;
    }
  }

  return (
    <div
      ref={measureRef}
      className={`group/message mb-4 px-4 ${isUser && !isToolResult ? 'flex flex-col items-end' : ''}`}
    >
      {isUser && !isToolResult && (
        <UserMessageBubble
          message={message}
          attachments={attachments}
          loadingAttachmentCount={
            attachmentKey && loadedAttachmentKey !== attachmentKey ? attachmentIds!.length : 0
          }
          onAction={focusMode ? undefined : onAction}
          actions={actions}
          onDeleteMessage={onDeleteMessage}
          focusMode={focusMode}
          isLastMessage={isLastMessage}
          isClaudeAgentChat={isClaudeAgentChat}
        />
      )}

      {isToolResult && (
        <ToolResultBubble
          message={message}
          onAction={focusMode ? undefined : onAction}
          onDeleteMessage={onDeleteMessage}
          focusMode={focusMode}
          expandMinions={expandMinions}
          disableMath={disableMath}
          isLastMessage={isLastMessage}
        />
      )}

      {!isUser && (
        <AssistantMessageBubble
          message={message}
          onAction={focusMode ? undefined : onAction}
          onDeleteMessage={onDeleteMessage}
          focusMode={focusMode}
          disableMath={disableMath}
          isLastMessage={isLastMessage}
          expandedGroups={expandedGroups}
        />
      )}
    </div>
  );
}

// Memoized so typing, streaming ticks and visibility flushes only re-render
// the bubbles whose props changed; the markdown below is the expensive part.
export default memo(MessageBubble);
