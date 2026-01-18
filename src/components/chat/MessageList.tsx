import { useEffect, useRef, useState } from 'react';
import type { MessageListProps } from './types';
import MessageBubble from './MessageBubble';
import StreamingMessage from './StreamingMessage';
import BouncingDots from './BouncingDots';
import CacheWarning from './CacheWarning';
import WebLLMLoadingView from './WebLLMLoadingView';
import PendingToolCallsBanner from './PendingToolCallsBanner';
import { useVirtualScroll } from '../../hooks/useVirtualScroll';
import { subscribeToLoadingState, type WebLLMLoadingState } from '../../services/api/webllmClient';

/** Interval for throttling scroll button visibility updates */
const SCROLL_BUTTON_THROTTLE_MS = 200;

export default function MessageList({
  messages,
  onAction,
  isLoading,
  streamingGroups,
  currentApiDefId,
  currentModelId,
  pendingToolCount,
  pendingToolMode,
  onPendingToolModeChange,
}: MessageListProps) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const shouldAutoScrollRef = useRef(true);
  const prevIsLoadingRef = useRef(isLoading);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const [webllmLoadingState, setWebllmLoadingState] = useState<WebLLMLoadingState | null>(null);

  // Throttling refs for scroll button updates
  const lastScrollButtonUpdateRef = useRef<number>(0);
  const pendingScrollButtonUpdateRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Virtual scrolling with 5 screen heights buffer (500% above + 500% below viewport)
  const { visibleMessageIds, registerMessage, measureHeight, getHeight } = useVirtualScroll(5);

  // Auto-scroll to bottom when new messages arrive or streaming updates
  useEffect(() => {
    if (shouldAutoScrollRef.current && scrollContainerRef.current) {
      scrollContainerRef.current.scrollTop = scrollContainerRef.current.scrollHeight;
    }
  }, [messages, streamingGroups]);

  // Auto-scroll correction after streaming ends (handles overscroll from markdown rendering/backstage collapse)
  useEffect(() => {
    const wasLoading = prevIsLoadingRef.current;
    prevIsLoadingRef.current = isLoading;

    // Only run when streaming just ended
    if (wasLoading && !isLoading && shouldAutoScrollRef.current && scrollContainerRef.current) {
      // Use requestAnimationFrame to wait for DOM updates after markdown rendering
      requestAnimationFrame(() => {
        if (scrollContainerRef.current) {
          const { scrollTop, scrollHeight, clientHeight } = scrollContainerRef.current;
          const maxScroll = scrollHeight - clientHeight;

          // If overscrolled (scrollTop > maxScroll), correct to bottom
          if (scrollTop > maxScroll) {
            console.debug('[MessageList] Correcting overscroll after streaming end');
            scrollContainerRef.current.scrollTop = maxScroll;
          }
        }
      });
    }
  }, [isLoading]);

  // Track if user has scrolled up (disable auto-scroll) and show/hide scroll button
  // Scroll button state is throttled to reduce re-renders during fast scrolling
  const handleScroll = () => {
    if (!scrollContainerRef.current) return;

    const { scrollTop, scrollHeight, clientHeight } = scrollContainerRef.current;
    const isNearBottom = scrollHeight - scrollTop - clientHeight < 100;

    // Always update auto-scroll ref immediately (no re-render)
    shouldAutoScrollRef.current = isNearBottom;

    // Throttle scroll button state updates
    const newShowButton = !isNearBottom;
    const now = Date.now();
    const timeSinceLastUpdate = now - lastScrollButtonUpdateRef.current;

    // Clear any pending update
    if (pendingScrollButtonUpdateRef.current) {
      clearTimeout(pendingScrollButtonUpdateRef.current);
      pendingScrollButtonUpdateRef.current = null;
    }

    if (timeSinceLastUpdate >= SCROLL_BUTTON_THROTTLE_MS) {
      // Enough time has passed, update immediately
      lastScrollButtonUpdateRef.current = now;
      setShowScrollButton(newShowButton);
    } else {
      // Schedule update for the remaining time
      const remainingTime = SCROLL_BUTTON_THROTTLE_MS - timeSinceLastUpdate;
      pendingScrollButtonUpdateRef.current = setTimeout(() => {
        lastScrollButtonUpdateRef.current = Date.now();
        setShowScrollButton(newShowButton);
        pendingScrollButtonUpdateRef.current = null;
      }, remainingTime);
    }
  };

  // Clean up pending timeout on unmount
  useEffect(() => {
    return () => {
      if (pendingScrollButtonUpdateRef.current) {
        clearTimeout(pendingScrollButtonUpdateRef.current);
      }
    };
  }, []);

  // Subscribe to WebLLM loading state (for model download/load progress)
  useEffect(() => {
    const unsubscribe = subscribeToLoadingState(state => {
      // Only update state when loading is active or just finished
      if (state.isLoading) {
        setWebllmLoadingState(state);
      } else {
        setWebllmLoadingState(null);
      }
    });
    return unsubscribe;
  }, []);

  // Scroll to bottom handler for the button
  const handleScrollToBottom = () => {
    // Clear any pending scroll button update to prevent it from overriding our state
    if (pendingScrollButtonUpdateRef.current) {
      clearTimeout(pendingScrollButtonUpdateRef.current);
      pendingScrollButtonUpdateRef.current = null;
    }

    if (scrollContainerRef.current) {
      scrollContainerRef.current.scrollTop = scrollContainerRef.current.scrollHeight;
      shouldAutoScrollRef.current = true;
      setShowScrollButton(false);
    }
  };

  return (
    <div className="relative flex-1">
      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        className="ios-scroll absolute inset-0 min-h-0 max-w-full overflow-x-hidden overflow-y-auto overscroll-y-contain bg-white"
      >
        <div className="py-4">
          {/* Render all messages */}
          {messages.map(message => (
            <MessageBubble
              key={message.id}
              message={message}
              onAction={onAction}
              isVisible={visibleMessageIds.has(message.id)}
              onRegister={registerMessage}
              onMeasureHeight={measureHeight}
              cachedHeight={getHeight(message.id)}
            />
          ))}

          {/* Render streaming message if active */}
          {isLoading && streamingGroups.length > 0 && <StreamingMessage groups={streamingGroups} />}

          {/* Loading indicator when no streaming content yet */}
          {isLoading && streamingGroups.length === 0 && (
            <div className="mb-4 flex justify-start px-4">
              <div className="rounded-2xl bg-gray-100 px-4 py-3 text-gray-600 shadow-sm">
                <BouncingDots />
              </div>
            </div>
          )}

          {/* Cache invalidation warning */}
          {!isLoading && (
            <CacheWarning
              messages={messages}
              currentApiDefId={currentApiDefId}
              currentModelId={currentModelId}
            />
          )}

          {/* WebLLM model loading progress (shows regardless of current model) */}
          {webllmLoadingState && webllmLoadingState.modelId && (
            <WebLLMLoadingView
              modelName={webllmLoadingState.modelId}
              progress={{
                text: webllmLoadingState.statusText,
                progress: webllmLoadingState.progress,
              }}
            />
          )}

          {/* Pending tool calls banner */}
          {!isLoading &&
            pendingToolCount !== undefined &&
            pendingToolCount > 0 &&
            pendingToolMode &&
            onPendingToolModeChange && (
              <PendingToolCallsBanner
                toolCount={pendingToolCount}
                mode={pendingToolMode}
                onModeChange={onPendingToolModeChange}
              />
            )}
        </div>
      </div>

      {/* Scroll to bottom floating button */}
      {showScrollButton && (
        <button
          onClick={handleScrollToBottom}
          className="scroll-to-bottom-button absolute right-4 bottom-4 z-10 flex h-10 w-10 items-center justify-center rounded-full bg-gray-800 text-white shadow-lg transition-all hover:scale-105 hover:bg-gray-700"
          aria-label="Scroll to bottom"
        >
          <span className="text-lg">↓</span>
        </button>
      )}
    </div>
  );
}
