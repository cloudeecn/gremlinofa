import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
} from 'react';
import type { Message } from '../../../shared/protocol/types';
import { useIsTouchDevice } from '../../hooks/useIsTouchDevice';
import { useStableCallback } from '../../hooks/useStableCallback';
import {
  formatTimestamp,
  isToolResultMessage,
  messagePreviewLine,
  userMessageText,
} from '../../lib/messageFormatters';

/** The rail sits this far inside the list's top and bottom edges. */
const RAIL_INSET_PX = 8;
const THUMB_HEIGHT_PX = { mouse: 32, touch: 40 };
/** Touch target around the thumb: Apple's 44pt minimum. */
const TOUCH_HIT_PX = 44;
/** A drag this close to a tick lands on that message. */
const SNAP_DISTANCE_PX = { mouse: 6, touch: 14 };
/** The rail fades this long after the last activity; a finger needs longer to reach it. */
const FADE_DELAY_MS = { mouse: 1500, touch: 2500 };
/** Scroll events this soon after a wheel, touch or key event are the user's (incl. momentum). */
const USER_SCROLL_WINDOW_MS = 1000;
/** Same threshold MessageList uses to decide whether to follow new output. */
const AT_BOTTOM_PX = 100;
/** Pointer travel before pressing the thumb counts as dragging it. */
const DRAG_THRESHOLD_PX = 3;
/** PageUp/PageDown step, as a fraction of the chat. */
const PAGE_STEP = 0.05;

interface ChatScrubberProps {
  messages: Message<unknown>[];
  /** Mounted range `[start, end)` from useMessageWindow. */
  start: number;
  end: number;
  followingTail: boolean;
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  scrollContainerId: string;
  getElement: (messageId: string) => HTMLElement | undefined;
  onJump: (index: number) => void;
  onJumpToLatest: (behavior?: ScrollBehavior) => void;
}

interface Preview {
  index: number;
  /** Thumb-center position in rail coordinates. */
  y: number;
  touch: boolean;
}

interface Drag {
  pointerId: number;
  touch: boolean;
  /** Pointer offset from the thumb center, so grabbing off-center doesn't jerk the thumb. */
  grabOffset: number;
  startY: number;
  moved: boolean;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

/** A message the user wrote: gets a tick on the rail. */
function isPromptMessage(message: Message<unknown>): boolean {
  if (message.role !== 'user' || isToolResultMessage(message)) return false;
  return !!message.content.attachmentIds?.length || /\S/.test(userMessageText(message));
}

/**
 * Index position (message index + fraction scrolled through it) at viewport
 * line `y`, by binary search over the mounted range. Null while an element
 * isn't registered yet.
 */
function positionAt(
  y: number,
  messages: Message<unknown>[],
  start: number,
  end: number,
  getElement: (messageId: string) => HTMLElement | undefined
): number | null {
  let low = start;
  let high = end;
  while (low < high) {
    const mid = (low + high) >> 1;
    const element = getElement(messages[mid].id);
    if (!element) return null;
    if (element.getBoundingClientRect().bottom > y) high = mid;
    else low = mid + 1;
  }
  if (low === end) return end;
  const element = getElement(messages[low].id);
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  return low + (rect.height > 0 ? clamp((y - rect.top) / rect.height, 0, 1) : 0);
}

/** Nearest tick within `maxDistance` of `y`; `tickYs` is ascending. */
function nearestTick(tickYs: number[], y: number, maxDistance: number): number | null {
  let low = 0;
  let high = tickYs.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (tickYs[mid] < y) low = mid + 1;
    else high = mid;
  }
  let best: number | null = null;
  for (const candidate of [low - 1, low]) {
    if (candidate < 0 || candidate >= tickYs.length) continue;
    const distance = Math.abs(tickYs[candidate] - y);
    if (distance <= maxDistance && (best === null || distance < Math.abs(tickYs[best] - y))) {
      best = candidate;
    }
  }
  return best;
}

/**
 * Scroll rail for the chat list, positioned by message index rather than
 * pixels: the list only mounts a window of the chat, so the native scrollbar
 * would only cover that window. Drag the thumb (or click the track) to jump
 * anywhere; ticks mark the messages the user wrote; a "latest" pill replaces
 * the old scroll-to-bottom button.
 *
 * Scroll position updates write the thumb's transform directly, so scrolling
 * re-renders nothing. On touch screens only the visible thumb takes touches,
 * so a swipe near the edge still scrolls the list.
 */
function ChatScrubber({
  messages,
  start,
  end,
  followingTail,
  scrollContainerRef,
  scrollContainerId,
  getElement,
  onJump,
  onJumpToLatest,
}: ChatScrubberProps) {
  const isTouchLayout = useIsTouchDevice();
  const thumbHeight = isTouchLayout ? THUMB_HEIGHT_PX.touch : THUMB_HEIGHT_PX.mouse;
  const messageCount = messages.length;

  const [active, setActive] = useState(false);
  // Nothing to scrub while the whole chat fits on screen
  const [scrollable, setScrollable] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const [railHeight, setRailHeight] = useState(0);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [dragging, setDragging] = useState(false);

  const railRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const previewIndexRef = useRef<number | null>(null);
  const topIndexRef = useRef(0);
  const thumbCenterRef = useRef(0);
  const ariaIndexRef = useRef<number | null>(null);
  // The rail stays up while the pointer is over it or it has keyboard focus
  const heldRef = useRef({ hover: false, focus: false });
  const fadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const frameRef = useRef<number | null>(null);
  const lastUserInputRef = useRef({ at: 0, touch: false });

  // "N new" counts messages that arrived while the user was away from the latest
  const [seenCount, setSeenCount] = useState(messageCount);
  const caughtUp = atBottom && followingTail;
  if ((caughtUp && seenCount !== messageCount) || seenCount > messageCount) {
    setSeenCount(messageCount);
  }
  const unseenCount = caughtUp ? 0 : Math.max(0, messageCount - seenCount);

  const travel = Math.max(0, railHeight - thumbHeight);
  const lastIndex = Math.max(1, messageCount - 1);

  const { tickIndices, tickYs, tickPath } = useMemo(() => {
    const indices: number[] = [];
    messages.forEach((message, index) => {
      if (isPromptMessage(message)) indices.push(index);
    });
    const ys = indices.map(index => thumbHeight / 2 + (index / lastIndex) * travel);
    // One rect per pixel row: a 1000-message chat shouldn't mean 1000 DOM nodes
    const rows = new Set(ys.map(y => Math.round(y)));
    let path = '';
    for (const row of rows) path += `M0 ${row}h7v1h-7z`;
    return { tickIndices: indices, tickYs: ys, tickPath: path };
  }, [messages, thumbHeight, lastIndex, travel]);

  const moveThumb = (centerY: number) => {
    thumbCenterRef.current = centerY;
    const thumb = thumbRef.current;
    if (!thumb) return;
    const hitHeight = isTouchLayout ? TOUCH_HIT_PX : thumbHeight;
    thumb.style.transform = `translateY(${centerY - hitHeight / 2}px)`;
  };

  const measure = useStableCallback(() => {
    frameRef.current = null;
    const container = scrollContainerRef.current;
    if (!container) return;

    const { scrollTop, scrollHeight, clientHeight } = container;
    setRailHeight(Math.max(0, clientHeight - RAIL_INSET_PX * 2));
    setScrollable(start > 0 || !followingTail || scrollHeight > clientHeight + 1);
    setAtBottom(scrollHeight - scrollTop - clientHeight < AT_BOTTOM_PX);

    const bounds = container.getBoundingClientRect();
    const top = positionAt(bounds.top, messages, start, end, getElement);
    const bottom = positionAt(bounds.bottom, messages, start, end, getElement);
    if (top === null || bottom === null) return;

    // Messages above the viewport over all messages outside it: 0 at the
    // first message, 1 at the last, whatever slice is mounted.
    const outside = top + (messageCount - bottom);
    const progress = outside > 0 ? top / outside : 0;
    const topIndex = clamp(Math.round(top), 0, Math.max(0, messageCount - 1));
    topIndexRef.current = topIndex;
    if (!dragRef.current) moveThumb(thumbHeight / 2 + progress * travel);

    const rail = railRef.current;
    if (rail && ariaIndexRef.current !== topIndex && messages[topIndex]) {
      ariaIndexRef.current = topIndex;
      rail.setAttribute('aria-valuenow', String(topIndex + 1));
      rail.setAttribute(
        'aria-valuetext',
        `Message ${topIndex + 1} of ${messageCount}, ${formatTimestamp(messages[topIndex].timestamp)}`
      );
    }
  });

  const scheduleMeasure = useStableCallback(() => {
    if (frameRef.current === null) frameRef.current = requestAnimationFrame(measure);
  });

  /** Show the rail and restart its fade timer; it stays while held or dragged. */
  const wake = useStableCallback((touch: boolean = false) => {
    setActive(true);
    if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current);
    fadeTimerRef.current = setTimeout(
      () => {
        fadeTimerRef.current = null;
        const held = heldRef.current;
        if (!held.hover && !held.focus && !dragRef.current) setActive(false);
      },
      touch ? FADE_DELAY_MS.touch : FADE_DELAY_MS.mouse
    );
  });

  // Rail height follows the list: rotation and the mobile keyboard resize it
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const resizeObserver = new ResizeObserver(scheduleMeasure);
    resizeObserver.observe(container);
    return () => resizeObserver.disconnect();
  }, [scrollContainerRef, scheduleMeasure]);

  // Only scrolling the user caused wakes the rail — not auto-follow during streaming
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const markInput = (event: Event) => {
      lastUserInputRef.current = { at: Date.now(), touch: event.type.startsWith('touch') };
    };
    const handleScroll = () => {
      scheduleMeasure();
      const input = lastUserInputRef.current;
      const now = Date.now();
      if (now - input.at < USER_SCROLL_WINDOW_MS) {
        // Momentum keeps producing scroll events after the finger lifts
        input.at = now;
        wake(input.touch);
      }
    };
    container.addEventListener('scroll', handleScroll, { passive: true });
    container.addEventListener('wheel', markInput, { passive: true });
    container.addEventListener('touchmove', markInput, { passive: true });
    container.addEventListener('keydown', markInput);
    return () => {
      container.removeEventListener('scroll', handleScroll);
      container.removeEventListener('wheel', markInput);
      container.removeEventListener('touchmove', markInput);
      container.removeEventListener('keydown', markInput);
    };
  }, [scrollContainerRef, scheduleMeasure, wake]);

  useEffect(
    () => () => {
      if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current);
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    },
    []
  );

  // Re-place the thumb when the window, the chat or the rail changes
  useLayoutEffect(() => {
    measure();
  }, [measure, messages, start, end, followingTail, railHeight, thumbHeight, scrollable]);

  // Keep the label beside the thumb but inside the rail
  useLayoutEffect(() => {
    const label = labelRef.current;
    if (!label || !preview) return;
    const height = label.offsetHeight;
    label.style.top = `${clamp(preview.y - height / 2, 0, Math.max(0, railHeight - height))}px`;
  }, [preview, railHeight]);

  const showPreview = (centerY: number, touch: boolean, moveThumbToo: boolean) => {
    let y = clamp(centerY, thumbHeight / 2, thumbHeight / 2 + travel);
    let index = Math.round(((y - thumbHeight / 2) / Math.max(1, travel)) * lastIndex);
    const tick = nearestTick(tickYs, y, touch ? SNAP_DISTANCE_PX.touch : SNAP_DISTANCE_PX.mouse);
    if (tick !== null) {
      index = tickIndices[tick];
      y = tickYs[tick];
    }
    index = clamp(index, 0, messageCount - 1);
    previewIndexRef.current = index;
    if (moveThumbToo) moveThumb(y);
    setPreview({ index, y, touch });
  };

  const railY = (clientY: number) => clientY - (railRef.current?.getBoundingClientRect().top ?? 0);

  const endDrag = (touch: boolean) => {
    dragRef.current = null;
    previewIndexRef.current = null;
    setDragging(false);
    setPreview(null);
    scheduleMeasure();
    wake(touch);
  };

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    const touch = event.pointerType === 'touch';
    const onThumb = !!thumbRef.current?.contains(event.target as Node);
    // A touch that isn't on the visible thumb is a scroll, not a jump
    if (touch && (!onThumb || !active)) return;
    if (!touch && event.button !== 0) return;
    event.preventDefault();
    // On touch layouts the rail itself has pointer-events: none; capture on the thumb
    (onThumb && thumbRef.current ? thumbRef.current : event.currentTarget).setPointerCapture(
      event.pointerId
    );

    const y = railY(event.clientY);
    const grabOffset = onThumb ? y - thumbCenterRef.current : 0;
    // Clicking the track jumps on release even without moving
    dragRef.current = {
      pointerId: event.pointerId,
      touch,
      grabOffset,
      startY: event.clientY,
      moved: !onThumb,
    };
    setDragging(true);
    showPreview(y - grabOffset, touch, true);
    wake(touch);
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (drag) {
      if (event.pointerId !== drag.pointerId) return;
      if (!drag.moved && Math.abs(event.clientY - drag.startY) < DRAG_THRESHOLD_PX) return;
      drag.moved = true;
      showPreview(railY(event.clientY) - drag.grabOffset, drag.touch, true);
    } else if (event.pointerType === 'mouse') {
      showPreview(railY(event.clientY), false, false);
    }
  };

  const handlePointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || event.pointerId !== drag.pointerId) return;
    const index = previewIndexRef.current;
    endDrag(drag.touch);
    if (!drag.moved || index === null) return;
    if (index >= messageCount - 1) onJumpToLatest();
    else onJump(index);
  };

  const handlePointerCancel = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (drag?.pointerId === event.pointerId) endDrag(drag.touch);
  };

  const handlePointerEnter = (event: PointerEvent<HTMLElement>) => {
    if (event.pointerType !== 'mouse') return;
    heldRef.current.hover = true;
    wake();
  };

  const handlePointerLeave = (event: PointerEvent<HTMLElement>) => {
    if (event.pointerType !== 'mouse') return;
    heldRef.current.hover = false;
    if (!dragRef.current) setPreview(null);
    wake();
  };

  const handleFocusChange = (focused: boolean) => {
    heldRef.current.focus = focused;
    wake();
  };

  const previousTick = (index: number): number | null => {
    for (let tick = tickIndices.length - 1; tick >= 0; tick--) {
      if (tickIndices[tick] < index) return tickIndices[tick];
    }
    return null;
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const current = topIndexRef.current;
    const pageStep = Math.max(1, Math.round(messageCount * PAGE_STEP));
    let target: number | 'latest' | null = null;
    switch (event.key) {
      case 'ArrowUp':
        target = previousTick(current);
        break;
      case 'ArrowDown':
        target = tickIndices.find(index => index > current) ?? 'latest';
        break;
      case 'PageUp':
        target = Math.max(0, current - pageStep);
        break;
      case 'PageDown':
        target = current + pageStep >= messageCount - 1 ? 'latest' : current + pageStep;
        break;
      case 'Home':
        target = 0;
        break;
      case 'End':
        target = 'latest';
        break;
      default:
        return;
    }
    event.preventDefault();
    wake();
    if (target === 'latest') onJumpToLatest();
    else if (target !== null) onJump(target);
  };

  if (!scrollable || messageCount === 0) return null;

  const visible = active || dragging;
  const showPill = !atBottom || !followingTail;
  const previewMessage = preview ? messages[preview.index] : undefined;

  return (
    <>
      <div
        ref={railRef}
        role="scrollbar"
        aria-label="Chat position"
        aria-controls={scrollContainerId}
        aria-orientation="vertical"
        aria-valuemin={1}
        aria-valuemax={messageCount}
        tabIndex={0}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onPointerEnter={handlePointerEnter}
        onPointerLeave={handlePointerLeave}
        onKeyDown={handleKeyDown}
        onFocus={() => handleFocusChange(true)}
        onBlur={() => handleFocusChange(false)}
        style={{ top: RAIL_INSET_PX, bottom: RAIL_INSET_PX }}
        className={`chat-scrubber absolute right-0 z-10 w-7 rounded outline-none select-none focus-visible:ring-2 focus-visible:ring-blue-400 motion-safe:transition-opacity motion-safe:duration-200 ${
          visible ? 'opacity-100' : 'opacity-0'
        } ${isTouchLayout ? 'pointer-events-none' : 'cursor-pointer'}`}
      >
        <div className="absolute top-0 right-[5px] bottom-0 w-[3px] rounded-full bg-gray-300/70" />
        <svg
          className="absolute top-0 right-[3px] h-full w-[7px] overflow-visible"
          aria-hidden="true"
        >
          <path d={tickPath} className="fill-blue-500/70" />
        </svg>
        <div
          ref={thumbRef}
          data-testid="scrubber-thumb"
          className={`absolute top-0 right-0 flex items-center justify-end ${
            isTouchLayout ? 'h-11 w-11 touch-none' : 'h-8 w-7'
          } ${isTouchLayout && visible ? 'pointer-events-auto' : ''}`}
        >
          <div
            className={`rounded-full ${dragging ? 'bg-gray-700' : 'bg-gray-500'} ${
              isTouchLayout ? 'mr-[2.5px] h-10 w-2' : 'mr-[3.5px] h-8 w-1.5'
            }`}
          />
        </div>

        {preview && previewMessage && (
          <div
            ref={labelRef}
            data-testid="scrubber-label"
            className={`pointer-events-none absolute w-max max-w-[min(70vw,280px)] rounded-lg border border-gray-200 bg-white/95 px-3 py-1.5 shadow-md ${
              preview.touch ? 'right-16' : 'right-9'
            }`}
          >
            <div className="text-[11px] whitespace-nowrap text-gray-500">
              {formatTimestamp(previewMessage.timestamp)} · #{preview.index + 1} / {messageCount}
            </div>
            <div className="truncate text-sm text-gray-800">
              {messagePreviewLine(previewMessage)}
            </div>
          </div>
        )}
      </div>

      {visible && (
        <button
          type="button"
          onClick={() => onJump(0)}
          onPointerEnter={handlePointerEnter}
          onPointerLeave={handlePointerLeave}
          aria-label="Jump to first message"
          className="absolute top-1 right-8 z-20 p-1.5"
        >
          <span className="flex h-8 w-8 items-center justify-center rounded-full border border-gray-200 bg-white/90 text-sm text-gray-600 shadow-sm hover:bg-gray-50">
            ⤒
          </span>
        </button>
      )}

      {showPill && (
        <button
          type="button"
          onClick={() => onJumpToLatest('smooth')}
          aria-label={unseenCount > 0 ? `${unseenCount} new, jump to latest` : 'Jump to latest'}
          className="absolute right-3 bottom-1 z-20 p-1.5"
        >
          <span className="flex h-8 items-center gap-1 rounded-full border border-gray-200 bg-white/90 px-3 text-xs font-medium text-gray-700 shadow-sm hover:bg-gray-50">
            ↓ {unseenCount > 0 ? `${unseenCount} new` : 'Latest'}
          </span>
        </button>
      )}
    </>
  );
}

export default memo(ChatScrubber);
