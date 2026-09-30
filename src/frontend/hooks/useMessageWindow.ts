import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { useStableCallback } from './useStableCallback';

/** Messages mounted when a chat opens; older ones mount as the user scrolls up. */
export const INITIAL_MOUNT_COUNT = 30;

/** Messages added each time the user nears either end of the mounted range. */
export const MOUNT_BATCH_SIZE = 20;

/** Minimum look-ahead beyond the viewport before the next batch mounts. */
const MIN_LOOKAHEAD_PX = 600;

/** Messages mounted above a jump target; the top sentinel fills in the rest. */
const JUMP_CONTEXT_ABOVE = 10;

/** A jump target lands this far below the container top. */
const JUMP_TOP_GAP_PX = 8;

interface MountRange {
  start: number;
  /** Exclusive. `null` follows the tail, so appended messages mount. */
  end: number | null;
}

interface ScrollAnchor {
  element: HTMLElement;
  top: number;
}

type PendingJump = { kind: 'index'; index: number } | { kind: 'latest' };

interface UseMessageWindowReturn {
  /** Index of the first mounted message. */
  start: number;
  /** Index after the last mounted message. */
  end: number;
  /** The range ends at the last message and grows with new ones. */
  followingTail: boolean;
  /** Older messages can still mount: render the top sentinel. */
  hasMoreAbove: boolean;
  /** Newer messages can still mount: render the bottom sentinel. */
  hasMoreBelow: boolean;
  topSentinelRef: RefObject<HTMLDivElement | null>;
  bottomSentinelRef: RefObject<HTMLDivElement | null>;
  /** Show message `index` at the top of the viewport, mounting around it if needed. */
  jumpTo: (index: number) => void;
  /** Mount the tail and scroll to the bottom. */
  jumpToLatest: (behavior?: ScrollBehavior) => void;
}

function tailRange(messageCount: number): MountRange {
  return { start: Math.max(0, messageCount - INITIAL_MOUNT_COUNT), end: null };
}

function scrollToTopOf(container: HTMLElement, element: HTMLElement) {
  const offset =
    element.getBoundingClientRect().top - container.getBoundingClientRect().top - JUMP_TOP_GAP_PX;
  container.scrollTop = Math.max(0, container.scrollTop + offset);
}

/**
 * Mount a window `[start, end)` of a chat instead of every message, so a
 * 1000-message chat renders ~30 bubbles.
 *
 * The window starts as the tail, fixed on the first render where the list is
 * ready (`ready` = snapshot replay finished) and non-empty. Sentinels at both
 * ends grow it by a batch as the user nears them. `jumpTo` moves it anywhere
 * in the chat; `jumpToLatest` moves it back to the tail. Messages that leave
 * the window unmount; mounted ones virtualize through `useVirtualScroll`.
 *
 * Growing upward inserts content above the viewport, so the scroll position
 * is compensated by the measured shift of the previously-first message.
 * Measuring (rather than assuming) keeps it correct whether or not the
 * browser already applied CSS scroll anchoring — iOS Safari historically
 * doesn't.
 */
export function useMessageWindow(
  messages: readonly { id: string }[],
  ready: boolean,
  scrollContainerRef: RefObject<HTMLDivElement | null>,
  getElement: (messageId: string) => HTMLElement | undefined
): UseMessageWindowReturn {
  const messageCount = messages.length;
  const [range, setRange] = useState<MountRange | null>(null);
  if (range === null) {
    if (ready && messageCount > 0) setRange(tailRange(messageCount));
  } else if (messageCount === 0) {
    setRange(null);
  } else if (range.start >= messageCount) {
    // Truncated past the window (rollback, reconnect): nothing left to show
    setRange(tailRange(messageCount));
  } else if (range.end !== null && range.end >= messageCount) {
    setRange({ start: range.start, end: null });
  }

  const followingTail = range === null || range.end === null;
  const start = Math.min(range?.start ?? tailRange(messageCount).start, messageCount);
  const end = range?.end == null ? messageCount : Math.min(range.end, messageCount);
  const hasMoreAbove = range !== null && start > 0;
  const hasMoreBelow = !followingTail && end < messageCount;

  const anchorRef = useRef<ScrollAnchor | null>(null);
  const pendingJumpRef = useRef<PendingJump | null>(null);
  const [jumpSeq, setJumpSeq] = useState(0);
  const topSentinelRef = useRef<HTMLDivElement | null>(null);
  const bottomSentinelRef = useRef<HTMLDivElement | null>(null);

  // Effects, not ref callbacks: child refs attach before the parent's, so on
  // first mount a sentinel's ref would run before the scroll container's.
  // Re-created per range edge, so each batch gets a fresh initial report —
  // short messages keep mounting batches until the look-ahead is filled.
  useEffect(() => {
    const sentinel = topSentinelRef.current;
    const container = scrollContainerRef.current;
    if (!hasMoreAbove || !sentinel || !container) return;

    const lookaheadPx = Math.max(container.clientHeight, MIN_LOOKAHEAD_PX);
    const observer = new IntersectionObserver(
      entries => {
        if (!entries.some(entry => entry.isIntersecting)) return;
        observer.disconnect();

        const firstMounted = container.querySelector<HTMLElement>('[data-message-id]');
        anchorRef.current = firstMounted
          ? { element: firstMounted, top: firstMounted.getBoundingClientRect().top }
          : null;
        setRange(current =>
          current ? { ...current, start: Math.max(0, current.start - MOUNT_BATCH_SIZE) } : current
        );
      },
      { root: container, rootMargin: `${lookaheadPx}px 0px 0px 0px`, threshold: 0 }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [start, hasMoreAbove, scrollContainerRef]);

  // Content added below the viewport doesn't move it: no compensation needed.
  useEffect(() => {
    const sentinel = bottomSentinelRef.current;
    const container = scrollContainerRef.current;
    if (!hasMoreBelow || !sentinel || !container) return;

    const lookaheadPx = Math.max(container.clientHeight, MIN_LOOKAHEAD_PX);
    const observer = new IntersectionObserver(
      entries => {
        if (!entries.some(entry => entry.isIntersecting)) return;
        observer.disconnect();
        setRange(current =>
          current && current.end !== null
            ? { ...current, end: current.end + MOUNT_BATCH_SIZE }
            : current
        );
      },
      { root: container, rootMargin: `0px 0px ${lookaheadPx}px 0px`, threshold: 0 }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [end, hasMoreBelow, scrollContainerRef]);

  // Runs before paint, so the inserted batch never shows at the wrong offset.
  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    anchorRef.current = null;
    const container = scrollContainerRef.current;
    if (!anchor || !container || !anchor.element.isConnected) return;

    const shift = anchor.element.getBoundingClientRect().top - anchor.top;
    if (shift !== 0) {
      container.scrollTop += shift;
    }
  }, [start, scrollContainerRef]);

  // Lands a jump once its range has mounted. After the compensation effect,
  // so a batch that raced the jump can't move the target afterwards.
  useLayoutEffect(() => {
    const jump = pendingJumpRef.current;
    pendingJumpRef.current = null;
    const container = scrollContainerRef.current;
    if (!jump || !container) return;

    if (jump.kind === 'latest') {
      container.scrollTop = container.scrollHeight;
      return;
    }
    const target = messages[jump.index] && getElement(messages[jump.index].id);
    if (target) scrollToTopOf(container, target);
  }, [jumpSeq, messages, getElement, scrollContainerRef]);

  const jumpTo = useStableCallback((index: number) => {
    const container = scrollContainerRef.current;
    const target = index >= start && index < end ? getElement(messages[index].id) : undefined;
    if (target && container) {
      scrollToTopOf(container, target);
      return;
    }
    const nextStart = Math.max(0, Math.min(index, messageCount - 1) - JUMP_CONTEXT_ABOVE);
    const nextEnd = nextStart + JUMP_CONTEXT_ABOVE + MOUNT_BATCH_SIZE;
    anchorRef.current = null;
    pendingJumpRef.current = { kind: 'index', index };
    setRange({ start: nextStart, end: nextEnd >= messageCount ? null : nextEnd });
    setJumpSeq(seq => seq + 1);
  });

  const jumpToLatest = useStableCallback((behavior: ScrollBehavior = 'instant') => {
    const container = scrollContainerRef.current;
    if (followingTail) {
      if (!container) return;
      if (behavior === 'smooth') {
        container.scrollTo({ top: container.scrollHeight, behavior });
      } else {
        container.scrollTop = container.scrollHeight;
      }
      return;
    }
    anchorRef.current = null;
    pendingJumpRef.current = { kind: 'latest' };
    setRange(tailRange(messageCount));
    setJumpSeq(seq => seq + 1);
  });

  return {
    start,
    end,
    followingTail,
    hasMoreAbove,
    hasMoreBelow,
    topSentinelRef,
    bottomSentinelRef,
    jumpTo,
    jumpToLatest,
  };
}
