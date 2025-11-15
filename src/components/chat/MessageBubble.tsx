import { useCallback, useEffect, useRef, useState } from 'react';
import { MessageRole, type MessageAttachment } from '../../types';
import type { RenderingBlockGroup } from '../../types/content';
import { storage } from '../../services/storage';
import type { MessageBubbleProps } from './types';
import UserMessageBubble from './UserMessageBubble';
import AssistantMessageBubble from './AssistantMessageBubble';
import LegacyAssistantBubble from './LegacyAssistantBubble';
import ToolResultBubble from './ToolResultBubble';

export default function MessageBubble({
  message,
  onAction,
  isVisible,
  onRegister,
  onMeasureHeight,
  cachedHeight,
}: MessageBubbleProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [attachments, setAttachments] = useState<MessageAttachment[]>([]);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);

  const isUser = message.role === MessageRole.USER;

  // Load attachments from storage when visible
  useEffect(() => {
    if (!isVisible || !message.content.attachmentIds?.length) return;

    const loadAttachments = async () => {
      try {
        const loaded = await storage.getAttachments(message.id);
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

  // Check if we have renderingContent (new format) vs legacy format
  const renderingContent = message.content.renderingContent as RenderingBlockGroup[] | undefined;
  const hasRenderingContent = !isUser && renderingContent && renderingContent.length > 0;

  // Detect tool_result message (USER role but contains tool_result blocks in fullContent)
  const fullContent = message.content.fullContent;
  const isToolResult =
    isUser &&
    Array.isArray(fullContent) &&
    fullContent.some(
      (b: Record<string, unknown>) =>
        typeof b === 'object' && b !== null && b.type === 'tool_result'
    );

  return (
    <div
      ref={measureRef}
      className={`mb-4 px-4 ${isUser && !isToolResult ? 'flex flex-col items-end' : ''}`}
    >
      {isUser && !isToolResult && (
        <UserMessageBubble message={message} attachments={attachments} onAction={onAction} />
      )}

      {isToolResult && <ToolResultBubble message={message} />}

      {hasRenderingContent && <AssistantMessageBubble message={message} isVisible={isVisible} />}

      {!isUser && !hasRenderingContent && <LegacyAssistantBubble message={message} />}
    </div>
  );
}
