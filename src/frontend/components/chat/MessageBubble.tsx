import { useCallback, useEffect, useRef, useState } from 'react';
import { type MessageAttachment } from '../../../shared/protocol/types';
import type { RenderingBlockGroup } from '../../../shared/protocol/types/content';
import { gremlinClient } from '../../client';
import type { MessageBubbleProps } from './types';
import UserMessageBubble from './UserMessageBubble';
import AssistantMessageBubble from './AssistantMessageBubble';
import ToolResultBubble from './ToolResultBubble';

export default function MessageBubble({
  message,
  onAction,
  onDeleteMessage,
  isVisible,
  onRegister,
  onMeasureHeight,
  cachedHeight,
  focusMode,
  expandMinions,
  disableMath,
}: MessageBubbleProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [attachments, setAttachments] = useState<MessageAttachment[]>([]);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);

  const isUser = message.role === 'user';

  // Load attachments from storage when visible
  useEffect(() => {
    if (!isVisible || !message.content.attachmentIds?.length) return;

    const loadAttachments = async () => {
      try {
        const loaded = await gremlinClient.getAttachments(message.id);
        setAttachments(loaded);
      } catch (error) {
        console.error('Failed to load attachments:', error);
      }
    };

    loadAttachments();
  }, [isVisible, message.content.attachmentIds, message.id]);

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

  // Measure height with ResizeObserver when visible (for dynamic changes like thinking expansion)
  useEffect(() => {
    if (!isVisible || !containerRef.current) return;

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
  }, [isVisible, message.id, onMeasureHeight]);

  // Render placeholder if not visible and we have a cached height
  // Only virtualize if we have a real measurement (no estimated heights)
  if (!isVisible && cachedHeight) {
    return (
      <div
        ref={measureRef}
        style={{ height: `${cachedHeight}px` }}
        className="mb-4 px-4"
        aria-hidden="true"
      />
    );
  }

  const renderingContent = message.content.renderingContent as RenderingBlockGroup[] | undefined;

  // Detect tool_result message via renderingContent (normalized format works for all APIs)
  const isToolResult =
    isUser && renderingContent?.some(group => group.blocks.some(b => b.type === 'tool_result'));

  // In focus mode, hide tool result messages unless expandMinions is on and they have complex results
  if (focusMode && isToolResult) {
    const hasComplexResults =
      expandMinions &&
      renderingContent
        ?.flatMap(g => g.blocks)
        .some(b => b.type === 'tool_result' && b.renderingGroups && b.renderingGroups.length > 0);

    if (!hasComplexResults) {
      return <div ref={measureRef} className="mb-4 px-4" aria-hidden="true" />;
    }
  }

  return (
    <div
      ref={measureRef}
      className={`mb-4 px-4 ${isUser && !isToolResult ? 'flex flex-col items-end' : ''}`}
    >
      {isUser && !isToolResult && (
        <UserMessageBubble
          message={message}
          attachments={attachments}
          onAction={focusMode ? undefined : onAction}
          onDeleteMessage={onDeleteMessage}
          focusMode={focusMode}
        />
      )}

      {isToolResult && (
        <ToolResultBubble
          message={message}
          onAction={focusMode ? undefined : onAction}
          onDeleteMessage={onDeleteMessage}
          focusMode={focusMode}
          expandMinions={expandMinions}
        />
      )}

      {!isUser && (
        <AssistantMessageBubble
          message={message}
          onDeleteMessage={onDeleteMessage}
          isVisible={isVisible}
          focusMode={focusMode}
          disableMath={disableMath}
        />
      )}
    </div>
  );
}
