import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { useRef, type ComponentProps } from 'react';
import type { Message } from '../../../../shared/protocol/types';
import ChatScrubber from '../ChatScrubber';

/**
 * Layout used throughout: a 616px-tall list over 101 messages of 100px each
 * (content 10100px). The rail is 600px tall, 8px below the list top.
 *
 * Ticks (messages the user wrote) sit at indices 0, 50 and 100. With the
 * 32px mouse thumb, thumb centers run from 16 to 584 and ticks sit at
 * 16 / 300 / 584; with the 40px touch thumb, 20 / 300 / 580.
 */
const CLIENT_HEIGHT = 616;
const RAIL_TOP = 8;
const MESSAGE_HEIGHT = 100;

const metrics = { scrollTop: 0, scrollHeight: 10100, touch: false };

function textMessage(index: number, role: 'user' | 'assistant', text: string): Message<unknown> {
  return {
    id: `m${index}`,
    role,
    timestamp: new Date(2026, 8, 10, 15, 42),
    content: {
      type: 'text',
      content: text,
      renderingContent: [{ category: 'text', blocks: text ? [{ type: 'text', text }] : [] }],
    },
  } as Message<unknown>;
}

function chat(count = 101): Message<unknown>[] {
  return Array.from({ length: count }, (_, index) => {
    if (index === 0) return textMessage(index, 'user', 'First question');
    if (index === 50) return textMessage(index, 'user', 'Middle question\nsecond line');
    if (index === 100) return textMessage(index, 'user', 'Last question');
    // Inject-only minion message: no bubble, no tick
    if (index === 60) return textMessage(index, 'user', '');
    if (index === 25) {
      return {
        id: 'm25',
        role: 'user',
        timestamp: new Date(2026, 8, 10),
        content: {
          type: 'text',
          content: '',
          renderingContent: [
            {
              category: 'backstage',
              blocks: [{ type: 'tool_result', tool_use_id: 't', name: 'x' }],
            },
          ],
        },
      } as unknown as Message<unknown>;
    }
    return textMessage(index, 'assistant', `## Answer ${index}\n\nbody`);
  });
}

const elements = new Map<string, HTMLElement>();
function getElement(messageId: string) {
  let element = elements.get(messageId);
  if (!element) {
    const index = Number(messageId.slice(1));
    element = document.createElement('div');
    element.getBoundingClientRect = () => {
      const top = index * MESSAGE_HEIGHT - metrics.scrollTop;
      return { top, bottom: top + MESSAGE_HEIGHT, height: MESSAGE_HEIGHT } as DOMRect;
    };
    elements.set(messageId, element);
  }
  return element;
}

type ScrubberProps = ComponentProps<typeof ChatScrubber>;

function Harness(props: Partial<ScrubberProps> & Pick<ScrubberProps, 'onJump' | 'onJumpToLatest'>) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const messages = props.messages ?? chat();
  return (
    <div>
      <div ref={scrollContainerRef} data-testid="list" id="list" />
      <ChatScrubber
        start={0}
        end={messages.length}
        followingTail
        scrollContainerRef={scrollContainerRef}
        scrollContainerId="list"
        getElement={getElement}
        {...props}
        messages={messages}
      />
    </div>
  );
}

function renderScrubber(props: Partial<ScrubberProps> = {}) {
  const onJump = vi.fn();
  const onJumpToLatest = vi.fn();
  const utils = render(<Harness onJump={onJump} onJumpToLatest={onJumpToLatest} {...props} />);
  const rerender = (next: Partial<ScrubberProps>) =>
    utils.rerender(
      <Harness onJump={onJump} onJumpToLatest={onJumpToLatest} {...props} {...next} />
    );
  return { ...utils, rerender, onJump, onJumpToLatest };
}

/** Scroll the list to `scrollTop`; `byUser` precedes it with a wheel/touch event. */
async function scrollTo(scrollTop: number, byUser: 'wheel' | 'touchmove' | null = null) {
  const list = screen.getByTestId('list');
  await act(async () => {
    if (byUser) fireEvent(list, new Event(byUser));
    metrics.scrollTop = scrollTop;
    fireEvent.scroll(list);
    vi.advanceTimersByTime(16);
  });
}

const thumb = () => screen.getByTestId('scrubber-thumb');
const rail = () => screen.getByRole('scrollbar');

function pointer(pointerType: 'mouse' | 'touch', railY: number) {
  return { pointerId: 1, pointerType, button: 0, clientY: RAIL_TOP + railY };
}

const originalRect = HTMLElement.prototype.getBoundingClientRect;
const originalMatchMedia = window.matchMedia;
const originalRO = globalThis.ResizeObserver;
const descriptors = {
  scrollTop: Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop'),
  scrollHeight: Object.getOwnPropertyDescriptor(Element.prototype, 'scrollHeight'),
  clientHeight: Object.getOwnPropertyDescriptor(Element.prototype, 'clientHeight'),
  offsetHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight'),
};

describe('ChatScrubber', () => {
  beforeAll(() => {
    const isList = (element: Element) => element.id === 'list';
    Object.defineProperty(Element.prototype, 'scrollTop', {
      configurable: true,
      get() {
        return isList(this) ? metrics.scrollTop : 0;
      },
      set(value: number) {
        if (isList(this)) metrics.scrollTop = value;
      },
    });
    Object.defineProperty(Element.prototype, 'scrollHeight', {
      configurable: true,
      get() {
        return isList(this) ? metrics.scrollHeight : 0;
      },
    });
    Object.defineProperty(Element.prototype, 'clientHeight', {
      configurable: true,
      get() {
        return isList(this) ? CLIENT_HEIGHT : 0;
      },
    });
    // The label's measured height, for clamping it inside the rail
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get() {
        return this.dataset.testid === 'scrubber-label' ? 40 : 0;
      },
    });
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      if (isList(this)) return { top: 0, bottom: CLIENT_HEIGHT } as DOMRect;
      if (this.getAttribute('role') === 'scrollbar') {
        return { top: RAIL_TOP, bottom: RAIL_TOP + CLIENT_HEIGHT - 16 } as DOMRect;
      }
      return { top: 0, bottom: 0 } as DOMRect;
    };
    HTMLElement.prototype.setPointerCapture = () => {};
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    window.matchMedia = ((query: string) => ({
      matches: metrics.touch,
      media: query,
      addEventListener() {},
      removeEventListener() {},
    })) as unknown as typeof window.matchMedia;
  });

  afterAll(() => {
    for (const [name, descriptor] of Object.entries(descriptors)) {
      const target = name === 'offsetHeight' ? HTMLElement.prototype : Element.prototype;
      if (descriptor) Object.defineProperty(target, name, descriptor);
    }
    HTMLElement.prototype.getBoundingClientRect = originalRect;
    window.matchMedia = originalMatchMedia;
    globalThis.ResizeObserver = originalRO;
  });

  beforeEach(() => {
    vi.useFakeTimers({
      toFake: [
        'setTimeout',
        'clearTimeout',
        'requestAnimationFrame',
        'cancelAnimationFrame',
        'Date',
      ],
    });
    metrics.scrollTop = 0;
    metrics.scrollHeight = 10100;
    metrics.touch = false;
    elements.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('position', () => {
    it('moves the thumb by message index as the list scrolls', async () => {
      renderScrubber();
      expect(thumb().style.transform).toBe('translateY(0px)');

      // Halfway through the messages outside the viewport
      await scrollTo((10100 - CLIENT_HEIGHT) / 2);
      expect(thumb().style.transform).toBe('translateY(284px)');
      expect(rail()).toHaveAttribute('aria-valuenow', '48');
      expect(rail().getAttribute('aria-valuetext')).toMatch(/^Message 48 of 101, Sep 10/);

      await scrollTo(10100 - CLIENT_HEIGHT);
      expect(thumb().style.transform).toBe('translateY(568px)');
    });

    it('covers the whole chat when only a window of it is mounted', async () => {
      // Messages 50..80 mounted and scrolled to the top of that window
      metrics.scrollTop = 50 * MESSAGE_HEIGHT;
      renderScrubber({ start: 50, end: 80, followingTail: false });
      await scrollTo(50 * MESSAGE_HEIGHT);

      // 50 messages above, 101 - 56.16 below: well past the middle of the rail
      const progress = 50 / (50 + 101 - 56.16);
      expect(thumb().style.transform).toBe(`translateY(${progress * 568}px)`);
    });

    it('renders nothing while the whole chat fits on screen', () => {
      metrics.scrollHeight = 500;
      renderScrubber({ messages: chat(5) });
      expect(screen.queryByRole('scrollbar')).not.toBeInTheDocument();
      expect(screen.queryByRole('button')).not.toBeInTheDocument();
    });
  });

  describe('visibility', () => {
    it('appears on a user scroll and fades after 1.5s unless hovered', async () => {
      renderScrubber();
      expect(rail()).toHaveClass('opacity-0');

      // Programmatic scrolls (auto-follow) don't wake it
      await scrollTo(500);
      expect(rail()).toHaveClass('opacity-0');

      await scrollTo(1000, 'wheel');
      expect(rail()).toHaveClass('opacity-100');
      await act(async () => vi.advanceTimersByTime(1500));
      expect(rail()).toHaveClass('opacity-0');

      fireEvent.pointerEnter(rail(), { pointerType: 'mouse' });
      await act(async () => vi.advanceTimersByTime(5000));
      expect(rail()).toHaveClass('opacity-100');
      fireEvent.pointerLeave(rail(), { pointerType: 'mouse' });
      await act(async () => vi.advanceTimersByTime(1500));
      expect(rail()).toHaveClass('opacity-0');
    });

    it('stays up longer after a touch scroll', async () => {
      renderScrubber();
      await scrollTo(1000, 'touchmove');
      await act(async () => vi.advanceTimersByTime(1500));
      expect(rail()).toHaveClass('opacity-100');
      await act(async () => vi.advanceTimersByTime(1000));
      expect(rail()).toHaveClass('opacity-0');
    });
  });

  describe('dragging with a mouse', () => {
    it('previews the target while dragging and jumps on release', async () => {
      const { onJump } = renderScrubber();

      fireEvent.pointerDown(thumb(), pointer('mouse', 16));
      fireEvent.pointerMove(rail(), pointer('mouse', 200));

      const label = screen.getByTestId('scrubber-label');
      // (200 - 16) / 568 of 100 messages → index 32
      expect(label).toHaveTextContent('#33 / 101');
      expect(label).toHaveTextContent('Sep 10, 3:42 PM');
      expect(label).toHaveTextContent('Answer 32');
      expect(label).toHaveClass('right-9');
      expect(thumb().style.transform).toBe('translateY(184px)');
      expect(onJump).not.toHaveBeenCalled();

      fireEvent.pointerUp(rail(), pointer('mouse', 200));
      expect(onJump).toHaveBeenCalledWith(32);
      expect(screen.queryByTestId('scrubber-label')).not.toBeInTheDocument();
    });

    it('snaps to a message the user wrote within 6px', async () => {
      const { onJump } = renderScrubber();

      fireEvent.pointerDown(thumb(), pointer('mouse', 16));
      fireEvent.pointerMove(rail(), pointer('mouse', 295));
      expect(screen.getByTestId('scrubber-label')).toHaveTextContent('Middle question');
      expect(screen.getByTestId('scrubber-label')).not.toHaveTextContent('second line');
      fireEvent.pointerUp(rail(), pointer('mouse', 295));
      expect(onJump).toHaveBeenLastCalledWith(50);
      // The mocked jump doesn't scroll: next frame the thumb returns to the top
      await act(async () => vi.advanceTimersByTime(16));
      expect(thumb().style.transform).toBe('translateY(0px)');

      // 12px away is too far for a mouse
      fireEvent.pointerDown(thumb(), pointer('mouse', 16));
      fireEvent.pointerMove(rail(), pointer('mouse', 288));
      fireEvent.pointerUp(rail(), pointer('mouse', 288));
      expect(onJump).toHaveBeenLastCalledWith(48);
    });

    it('a track click jumps there; the bottom of the rail means the latest', async () => {
      const { onJump, onJumpToLatest } = renderScrubber();

      fireEvent.pointerDown(rail(), pointer('mouse', 200));
      fireEvent.pointerUp(rail(), pointer('mouse', 200));
      expect(onJump).toHaveBeenCalledWith(32);

      fireEvent.pointerDown(rail(), pointer('mouse', 590));
      fireEvent.pointerUp(rail(), pointer('mouse', 590));
      expect(onJumpToLatest).toHaveBeenCalledTimes(1);
    });

    it('hovering shows the label without jumping', async () => {
      const { onJump } = renderScrubber();

      fireEvent.pointerEnter(rail(), { pointerType: 'mouse' });
      fireEvent.pointerMove(rail(), pointer('mouse', 300));
      expect(screen.getByTestId('scrubber-label')).toHaveTextContent('Middle question');

      fireEvent.pointerLeave(rail(), { pointerType: 'mouse' });
      expect(screen.queryByTestId('scrubber-label')).not.toBeInTheDocument();
      expect(onJump).not.toHaveBeenCalled();
    });
  });

  describe('keyboard', () => {
    it('Home, End, arrows between prompts and page steps', async () => {
      const { onJump, onJumpToLatest } = renderScrubber();
      await scrollTo(6000);

      fireEvent.keyDown(rail(), { key: 'ArrowUp' });
      expect(onJump).toHaveBeenLastCalledWith(50);
      fireEvent.keyDown(rail(), { key: 'ArrowDown' });
      expect(onJump).toHaveBeenLastCalledWith(100);
      fireEvent.keyDown(rail(), { key: 'PageUp' });
      expect(onJump).toHaveBeenLastCalledWith(55);
      fireEvent.keyDown(rail(), { key: 'Home' });
      expect(onJump).toHaveBeenLastCalledWith(0);
      fireEvent.keyDown(rail(), { key: 'End' });
      expect(onJumpToLatest).toHaveBeenCalledTimes(1);
    });
  });

  describe('latest pill', () => {
    it('shows away from the bottom and counts messages that arrived meanwhile', async () => {
      const { rerender, onJumpToLatest } = renderScrubber();
      await scrollTo(10100 - CLIENT_HEIGHT);
      expect(screen.queryByRole('button', { name: /latest/ })).not.toBeInTheDocument();

      await scrollTo(1000, 'wheel');
      expect(screen.getByRole('button', { name: 'Jump to latest' })).toBeInTheDocument();

      rerender({ messages: chat(103) });
      const pill = screen.getByRole('button', { name: '2 new, jump to latest' });
      expect(pill).toHaveTextContent('↓ 2 new');

      fireEvent.click(pill);
      expect(onJumpToLatest).toHaveBeenCalledWith('smooth');
    });

    it('shows at the bottom of a window that is not the tail', async () => {
      metrics.scrollHeight = 3000;
      renderScrubber({ start: 0, end: 30, followingTail: false });
      await scrollTo(3000 - CLIENT_HEIGHT);
      expect(screen.getByRole('button', { name: 'Jump to latest' })).toBeInTheDocument();
    });

    it('the top button jumps to the first message', async () => {
      const { onJump } = renderScrubber();
      await scrollTo(1000, 'wheel');
      fireEvent.click(screen.getByRole('button', { name: 'Jump to first message' }));
      expect(onJump).toHaveBeenCalledWith(0);
    });
  });

  describe('touch', () => {
    beforeEach(() => {
      metrics.touch = true;
    });

    it('lets touches on the track through as scrolls', async () => {
      const { onJump } = renderScrubber();
      await scrollTo(1000, 'touchmove');

      expect(rail()).toHaveClass('pointer-events-none');
      fireEvent.pointerDown(rail(), pointer('touch', 300));
      fireEvent.pointerUp(rail(), pointer('touch', 300));
      expect(screen.queryByTestId('scrubber-label')).not.toBeInTheDocument();
      expect(onJump).not.toHaveBeenCalled();
    });

    it('only a visible thumb can be grabbed, with a 44px touch target', async () => {
      const { onJump } = renderScrubber();
      expect(thumb()).toHaveClass('h-11', 'w-11', 'touch-none');
      expect(thumb()).not.toHaveClass('pointer-events-auto');

      // Faded out: a touch there is ignored
      fireEvent.pointerDown(thumb(), pointer('touch', 20));
      fireEvent.pointerMove(rail(), pointer('touch', 200));
      fireEvent.pointerUp(rail(), pointer('touch', 200));
      expect(onJump).not.toHaveBeenCalled();

      await scrollTo(0, 'touchmove');
      expect(thumb()).toHaveClass('pointer-events-auto');
      fireEvent.pointerDown(thumb(), pointer('touch', 20));
      fireEvent.pointerMove(rail(), pointer('touch', 200));
      const label = screen.getByTestId('scrubber-label');
      // Past the finger, not under it
      expect(label).toHaveClass('right-16');
      fireEvent.pointerUp(rail(), pointer('touch', 200));
      expect(onJump).toHaveBeenCalledWith(32);
    });

    it('snaps to a message the user wrote within 14px', async () => {
      const { onJump } = renderScrubber();
      await scrollTo(0, 'touchmove');

      fireEvent.pointerDown(thumb(), pointer('touch', 20));
      fireEvent.pointerMove(rail(), pointer('touch', 288));
      fireEvent.pointerUp(rail(), pointer('touch', 288));
      expect(onJump).toHaveBeenCalledWith(50);
    });

    it('keeps the label inside the rail at both ends', async () => {
      renderScrubber();
      await scrollTo(0, 'touchmove');

      fireEvent.pointerDown(thumb(), pointer('touch', 20));
      fireEvent.pointerMove(rail(), pointer('touch', 5));
      expect(screen.getByTestId('scrubber-label').style.top).toBe('0px');

      fireEvent.pointerMove(rail(), pointer('touch', 700));
      // 600px rail minus the 40px label
      expect(screen.getByTestId('scrubber-label').style.top).toBe('560px');
    });
  });
});
