import {
  memo,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import type { MessageListProps } from './types';
import MessageBubble from './MessageBubble';
import ChatScrubber from './ChatScrubber';
import StreamingMessage from './StreamingMessage';
import BouncingDots from './BouncingDots';
import CacheWarning from './CacheWarning';
import PendingToolCallsBanner from './PendingToolCallsBanner';
import SuspendedAfterToolsBanner from './SuspendedAfterToolsBanner';
import { useVirtualScroll } from '../../hooks/useVirtualScroll';
import { useMessageWindow } from '../../hooks/useMessageWindow';
import { useStableCallback } from '../../hooks/useStableCallback';

function MessageList({
  messages,
  onAction,
  actions,
  onDeleteMessage,
  isLoading,
  streamingGroups,
  currentApiDefId,
  currentModelId,
  pendingToolCount,
  onPendingToolReject,
  onPendingToolAccept,
  suspendedAfterTools,
  onContinueAfterToolStop,
  focusMode,
  expandMinions,
  disableMath,
  alwaysAutoScroll,
  snapshotLoading,
  dummyHookStatus,
  isClaudeAgentChat,
  ref,
}: MessageListProps) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const scrollContainerId = useId();
  const shouldAutoScrollRef = useRef(true);
  const prevScrollTopRef = useRef(0);
  const prevIsLoadingRef = useRef(isLoading);

  // Virtual scrolling with 5 screen heights buffer. View toggles change message
  // heights, so they reset the hidden set instead of leaving stale placeholders.
  const { hiddenMessageIds, registerMessage, measureHeight, getHeight, getElement } =
    useVirtualScroll(scrollContainerRef, 5, `${!!focusMode}|${!!disableMath}|${!!expandMinions}`);

  // Mount a window of a long chat: the tail at first, grown by sentinels at
  // either end, moved anywhere by the scrubber
  const {
    start,
    end,
    followingTail,
    hasMoreAbove,
    hasMoreBelow,
    topSentinelRef,
    bottomSentinelRef,
    jumpTo,
    jumpToLatest,
  } = useMessageWindow(messages, !snapshotLoading, scrollContainerRef, getElement);

  // A jump into history stops following the live output; going back to the
  // latest messages resumes it.
  const handleJump = useCallback(
    (index: number) => {
      shouldAutoScrollRef.current = false;
      jumpTo(index);
    },
    [jumpTo]
  );
  const handleJumpToLatest = useCallback(
    (behavior?: ScrollBehavior) => {
      shouldAutoScrollRef.current = true;
      jumpToLatest(behavior);
    },
    [jumpToLatest]
  );

  useImperativeHandle(ref, () => ({ jumpToLatest: handleJumpToLatest }), [handleJumpToLatest]);

  // Backstage groups expanded in the live reply. The reply becomes the message
  // at `index` (the list length while it streams), so that bubble starts with
  // the same groups open. StreamingMessage reads it too, so it survives the
  // tail unmounting during a scrubber jump.
  const [streamExpanded, setStreamExpanded] = useState<{
    index: number;
    groups: ReadonlySet<number>;
  } | null>(null);
  // Done once a message follows the handed-over one, or a rollback removed it
  if (
    streamExpanded &&
    (streamExpanded.index < messages.length - 1 || streamExpanded.index > messages.length)
  ) {
    setStreamExpanded(null);
  }
  const handleStreamGroupExpanded = useStableCallback((groupIndex: number, expanded: boolean) => {
    const index = messages.length;
    setStreamExpanded(prev => {
      const groups = new Set(prev?.index === index ? prev.groups : []);
      if (expanded) groups.add(groupIndex);
      else groups.delete(groupIndex);
      return { index, groups };
    });
  });

  // Auto-scroll to bottom when new messages arrive or streaming updates.
  // Layout effect: lands before paint, so an opened chat never flashes its top.
  // Suppressed during snapshot replay to avoid per-message scroll jitter, and
  // while the window sits in history (the tail isn't mounted).
  useLayoutEffect(() => {
    if (
      followingTail &&
      !snapshotLoading &&
      shouldAutoScrollRef.current &&
      scrollContainerRef.current
    ) {
      scrollContainerRef.current.scrollTop = scrollContainerRef.current.scrollHeight;
    }
  }, [messages, streamingGroups, snapshotLoading, followingTail]);

  // When snapshot finishes, scroll to bottom — but only if the user was
  // already following the tail (auto-scroll active). Preserves scroll
  // position for users reading history on a spotty connection.
  useEffect(() => {
    if (snapshotLoading === false && shouldAutoScrollRef.current && scrollContainerRef.current) {
      requestAnimationFrame(() => {
        if (scrollContainerRef.current) {
          scrollContainerRef.current.scrollTop = scrollContainerRef.current.scrollHeight;
        }
      });
    }
  }, [snapshotLoading]);

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

  // Disable auto-scroll in focus mode (reading back, not following live output)
  useEffect(() => {
    if (focusMode && !alwaysAutoScroll) {
      shouldAutoScrollRef.current = false;
    }
  }, [focusMode, alwaysAutoScroll]);

  // When always-auto-scroll is toggled on, re-enable and snap to bottom
  useEffect(() => {
    if (alwaysAutoScroll) {
      handleJumpToLatest();
    }
  }, [alwaysAutoScroll, handleJumpToLatest]);

  // Track if user has scrolled up (disable auto-scroll). Scrolling never
  // re-renders the list: the scrubber tracks position on its own.
  const handleScroll = () => {
    if (!scrollContainerRef.current) return;

    const { scrollTop, scrollHeight, clientHeight } = scrollContainerRef.current;
    const isNearBottom = scrollHeight - scrollTop - clientHeight < 100;

    // Distinguish user scrolls from DOM-growth scroll events using scroll direction.
    // DOM growth increases scrollHeight while scrollTop stays put, so scrollTop >= prev.
    // Only user-initiated upward scrolls should disable auto-scroll.
    const scrolledUp = scrollTop < prevScrollTopRef.current;
    prevScrollTopRef.current = scrollTop;

    // Near the bottom of a window in history is not the live tail
    if (!followingTail) {
      shouldAutoScrollRef.current = false;
    } else if (alwaysAutoScroll) {
      shouldAutoScrollRef.current = true;
    } else if (scrolledUp) {
      shouldAutoScrollRef.current = isNearBottom;
    } else if (isNearBottom) {
      shouldAutoScrollRef.current = true;
    }
    // else: DOM grew or user scrolled down but not near bottom — keep current value
  };

  return (
    <div className="relative flex-1">
      <div
        ref={scrollContainerRef}
        id={scrollContainerId}
        onScroll={handleScroll}
        className="ios-scroll absolute inset-0 min-h-0 max-w-full scrollbar-none overflow-x-hidden overflow-y-auto overscroll-contain bg-white"
      >
        <div className="py-4">
          {/* Initial snapshot still replaying: nothing to show yet */}
          {snapshotLoading && messages.length === 0 && (
            <div className="flex justify-center py-8" data-testid="snapshot-loading">
              <BouncingDots />
            </div>
          )}

          {/* Reaching this mounts the next batch of older messages */}
          {hasMoreAbove && <div ref={topSentinelRef} className="h-px" aria-hidden="true" />}

          {messages.slice(start, end).map((message, offset) => (
            <MessageBubble
              key={message.id}
              message={message}
              onAction={onAction}
              actions={actions}
              onDeleteMessage={onDeleteMessage}
              isHidden={hiddenMessageIds.has(message.id)}
              onRegister={registerMessage}
              onMeasureHeight={measureHeight}
              getHeight={getHeight}
              focusMode={focusMode}
              expandMinions={expandMinions}
              disableMath={disableMath}
              isLastMessage={start + offset === messages.length - 1}
              isClaudeAgentChat={isClaudeAgentChat}
              expandedGroups={
                streamExpanded?.index === start + offset ? streamExpanded.groups : undefined
              }
            />
          ))}

          {/* Reaching this mounts the next batch of newer messages */}
          {hasMoreBelow && <div ref={bottomSentinelRef} className="h-px" aria-hidden="true" />}

          {/* Live output and the banners below belong after the last message */}
          {followingTail && (
            <>
              {/* Render streaming message if active */}
              {isLoading && streamingGroups.length > 0 && (
                <StreamingMessage
                  groups={streamingGroups}
                  focusMode={focusMode}
                  disableMath={disableMath}
                  dummyHookStatus={dummyHookStatus}
                  expandedGroups={
                    streamExpanded?.index === messages.length ? streamExpanded.groups : undefined
                  }
                  onGroupExpandedChange={handleStreamGroupExpanded}
                />
              )}

              {/* Loading indicator when no streaming content yet */}
              {isLoading && streamingGroups.length === 0 && (
                <div className="mb-4 px-4">
                  <div className={'w-full'}>
                    {dummyHookStatus?.state === 'intercepting' && (
                      <div className="mb-1 text-xs text-green-700">
                        ✨ DUMMY System: Intercepting...
                      </div>
                    )}
                    <div className="mt-1">
                      <BouncingDots />
                    </div>
                  </div>
                </div>
              )}

              {/* Cache invalidation warning */}
              {!isLoading && !snapshotLoading && (
                <CacheWarning
                  messages={messages}
                  currentApiDefId={currentApiDefId}
                  currentModelId={currentModelId}
                />
              )}

              {/* Pending tool calls banner */}
              {!isLoading &&
                !snapshotLoading &&
                pendingToolCount !== undefined &&
                pendingToolCount > 0 &&
                onPendingToolReject &&
                onPendingToolAccept && (
                  <PendingToolCallsBanner
                    toolCount={pendingToolCount}
                    onReject={onPendingToolReject}
                    onAccept={onPendingToolAccept}
                  />
                )}

              {/* Suspended after tools banner */}
              {!isLoading && !snapshotLoading && suspendedAfterTools && onContinueAfterToolStop && (
                <SuspendedAfterToolsBanner onContinue={onContinueAfterToolStop} />
              )}
            </>
          )}
        </div>
      </div>

      <ChatScrubber
        messages={messages}
        start={start}
        end={end}
        followingTail={followingTail}
        scrollContainerRef={scrollContainerRef}
        scrollContainerId={scrollContainerId}
        getElement={getElement}
        onJump={handleJump}
        onJumpToLatest={handleJumpToLatest}
      />
    </div>
  );
}

// Memoized so keystrokes in the chat input (ChatView state) skip the list.
// Callers must pass stable callbacks — see `useStableCallback` in ChatView.
export default memo(MessageList);
