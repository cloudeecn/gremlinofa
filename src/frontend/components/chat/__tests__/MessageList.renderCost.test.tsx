import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import type { Message } from '../../../../shared/protocol/types';
import type { RenderingBlockGroup } from '../../../../shared/protocol/types/content';

/**
 * Integration tests with the real MessageBubble + useVirtualScroll: count
 * markdown renders and placeholders across the updates a live chat sees
 * (streaming ticks, appended messages). plans/08 §1 and §2.
 */

const markdownCalls = vi.hoisted(() => ({ count: 0, contents: [] as string[] }));

vi.mock('../../../lib/markdownRenderer', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../lib/markdownRenderer')>();
  return {
    ...actual,
    renderMarkdownSafe: (content: string, options?: { disableMath?: boolean; cache?: boolean }) => {
      markdownCalls.count++;
      markdownCalls.contents.push(content);
      return actual.renderMarkdownSafe(content, options);
    },
  };
});

vi.mock('../../../client', () => ({
  gremlinClient: {
    getAttachments: vi.fn().mockResolvedValue([]),
  },
  activeLoopsStore: { getSnapshot: () => [] },
}));

// CacheWarning and ToolResultView read API definitions / models from the app context
vi.mock('../../../hooks/useApp', () => {
  const apiDefinitions: never[] = [];
  const models = new Map();
  return { useApiDefinitions: () => apiDefinitions, useModels: () => models };
});

import MessageList from '../MessageList';
import { clearMarkdownCache } from '../../../lib/markdownRenderer';
import { INITIAL_MOUNT_COUNT, MOUNT_BATCH_SIZE } from '../../../hooks/useMessageWindow';

function userMessage(i: number): Message<unknown> {
  return {
    id: `u${i}`,
    role: 'user',
    timestamp: new Date(2026, 0, 1),
    content: {
      type: 'text',
      content: `question ${i}`,
      renderingContent: [{ category: 'text', blocks: [{ type: 'text', text: `question ${i}` }] }],
    },
  } as Message<unknown>;
}

function assistantMessage(i: number): Message<unknown> {
  const text = `## Answer ${i}\n\nSome **markdown** with \`code\`.\n\n\`\`\`ts\nconst n = ${i};\n\`\`\``;
  return {
    id: `a${i}`,
    role: 'assistant',
    timestamp: new Date(2026, 0, 1),
    content: {
      type: 'text',
      content: text,
      renderingContent: [{ category: 'text', blocks: [{ type: 'text', text }] }],
    },
  } as Message<unknown>;
}

function conversation(pairs: number): Message<unknown>[] {
  const messages: Message<unknown>[] = [];
  for (let i = 0; i < pairs; i++) messages.push(userMessage(i), assistantMessage(i));
  return messages;
}

const noop = () => {};
const noopAction = async () => {};

const controls: {
  setMessages: (messages: Message<unknown>[]) => void;
  setStreamingGroups: (groups: RenderingBlockGroup[]) => void;
  setUnrelated: (n: number) => void;
} = { setMessages: noop, setStreamingGroups: noop, setUnrelated: noop };

/** Mirrors ChatView: unrelated parent state + stable callbacks. */
function Harness({ initial }: { initial: Message<unknown>[] }) {
  const [messages, setMessages] = useState(initial);
  const [streamingGroups, setStreamingGroups] = useState<RenderingBlockGroup[]>([]);
  const [unrelated, setUnrelated] = useState(0);
  controls.setMessages = setMessages;
  controls.setStreamingGroups = setStreamingGroups;
  controls.setUnrelated = setUnrelated;
  return (
    <>
      <MessageList
        messages={messages}
        onAction={noopAction}
        isLoading={streamingGroups.length > 0}
        streamingGroups={streamingGroups}
        currentApiDefId="api_1"
        currentModelId="model_1"
        snapshotLoading={false}
        onPendingToolReject={noop}
        onPendingToolAccept={noop}
      />
      <span data-unrelated={unrelated} />
    </>
  );
}

/**
 * Message observers (two-part rootMargin) report every target as in view.
 * The window's sentinel observers (four-part rootMargin: look-ahead on top
 * for the top sentinel, on the bottom for the bottom one) only report when a
 * test calls `triggerSentinel`.
 */
type SentinelKind = 'top' | 'bottom';
const sentinelObservers: FakeIntersectionObserver[] = [];

class FakeIntersectionObserver {
  callback: IntersectionObserverCallback;
  targets: Element[] = [];
  sentinel: SentinelKind | null = null;
  constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
    this.callback = callback;
    const margins = (options?.rootMargin ?? '').split(' ');
    if (margins.length === 4) {
      this.sentinel = margins[0] === '0px' ? 'bottom' : 'top';
      sentinelObservers.push(this);
    }
  }
  observe(target: Element) {
    this.targets.push(target);
    if (this.sentinel) return;
    setTimeout(
      () =>
        this.callback(
          [{ target, isIntersecting: true } as unknown as IntersectionObserverEntry],
          this as unknown as IntersectionObserver
        ),
      0
    );
  }
  unobserve() {}
  disconnect() {
    this.targets = [];
  }
}

function liveSentinels(kind: SentinelKind) {
  return sentinelObservers.filter(
    observer => observer.sentinel === kind && observer.targets.length > 0
  );
}

function triggerSentinel(kind: SentinelKind = 'top') {
  const live = liveSentinels(kind);
  expect(live).toHaveLength(1);
  const [observer] = live;
  observer.callback(
    [{ target: observer.targets[0], isIntersecting: true } as unknown as IntersectionObserverEntry],
    observer as unknown as IntersectionObserver
  );
}

class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const originalRect = HTMLElement.prototype.getBoundingClientRect;
const originalIO = globalThis.IntersectionObserver;
const originalRO = globalThis.ResizeObserver;
const originalMatchMedia = window.matchMedia;

async function flushVisibility() {
  await act(async () => {
    vi.advanceTimersByTime(0);
    vi.advanceTimersByTime(250);
  });
}

describe('MessageList render cost (integration)', () => {
  beforeAll(() => {
    globalThis.IntersectionObserver =
      FakeIntersectionObserver as unknown as typeof IntersectionObserver;
    globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      addEventListener() {},
      removeEventListener() {},
    })) as unknown as typeof window.matchMedia;
    // Every message is 120px tall, stacked in DOM order and moved by the
    // list's scrollTop; the list itself sits at the top of the viewport
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      let top = 0;
      if (this.hasAttribute('data-message-id')) {
        const scrolled = this.closest<HTMLElement>('.overflow-y-auto')?.scrollTop ?? 0;
        top =
          Array.from(document.querySelectorAll('[data-message-id]')).indexOf(this) * 120 - scrolled;
      }
      return { height: 120, width: 600, top, left: 0, bottom: top + 120, right: 600 } as DOMRect;
    };
  });

  afterAll(() => {
    globalThis.IntersectionObserver = originalIO;
    globalThis.ResizeObserver = originalRO;
    window.matchMedia = originalMatchMedia;
    HTMLElement.prototype.getBoundingClientRect = originalRect;
  });

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] });
    clearMarkdownCache();
    markdownCalls.count = 0;
    markdownCalls.contents = [];
    sentinelObservers.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('streaming ticks and unrelated parent renders do not re-render message markdown', async () => {
    const { container } = render(<Harness initial={conversation(10)} />);
    await flushVisibility();
    expect(container.querySelectorAll('.text-group-view').length).toBe(10);

    markdownCalls.contents = [];
    for (let tick = 1; tick <= 10; tick++) {
      await act(async () => {
        controls.setStreamingGroups([
          { category: 'text', blocks: [{ type: 'text', text: 'streaming '.repeat(tick) }] },
        ]);
      });
      await act(async () => controls.setUnrelated(tick));
    }

    // Only the live reply parses, once per tick; the finished messages never do
    expect(markdownCalls.contents.filter(text => !text.startsWith('streaming'))).toEqual([]);
    expect(markdownCalls.contents).toHaveLength(10);
    // The 10 finished messages plus the live reply
    expect(container.querySelectorAll('.text-group-view').length).toBe(11);
  });

  it('a backstage group opened while streaming stays open on the finished message', async () => {
    const initial = conversation(1);
    const { container } = render(<Harness initial={initial} />);
    await flushVisibility();

    const groups: RenderingBlockGroup[] = [
      { category: 'backstage', blocks: [{ type: 'thinking', thinking: 'pondering' }] },
      { category: 'text', blocks: [{ type: 'text', text: 'the answer' }] },
    ];
    await act(async () => controls.setStreamingGroups(groups));
    const liveHeader = container.querySelector<HTMLButtonElement>('.backstage-container button')!;
    fireEvent.click(liveHeader);
    expect(liveHeader).toHaveTextContent('▼');

    // The reply finishes: the stored message replaces the live one
    const finished = {
      ...assistantMessage(1),
      id: 'finished',
      content: { ...assistantMessage(1).content, renderingContent: groups },
    } as Message<unknown>;
    await act(async () => {
      controls.setMessages([...initial, finished]);
      controls.setStreamingGroups([]);
    });
    let headers = container.querySelectorAll('.backstage-container button');
    expect(headers).toHaveLength(1);
    expect(headers[0]).toHaveTextContent('▼');

    // Once more messages follow, the handoff is spent: a new reply starts collapsed
    const later = { ...finished, id: 'later' } as Message<unknown>;
    await act(async () => controls.setMessages([...initial, finished, userMessage(9), later]));
    headers = container.querySelectorAll('.backstage-container button');
    expect(headers).toHaveLength(2);
    expect(headers[0]).toHaveTextContent('▼');
    expect(headers[1]).toHaveTextContent('▶');
  });

  it('a new message never flashes as a placeholder before the visibility flush', async () => {
    const initial = conversation(1);
    const { container } = render(<Harness initial={initial} />);
    await flushVisibility();

    const counts: number[] = [];
    const placeholders: number[] = [];
    const snapshot = () => {
      counts.push(container.querySelectorAll('.text-group-view').length);
      placeholders.push(container.querySelectorAll('div[aria-hidden="true"][style]').length);
    };

    await act(async () => controls.setMessages([...initial, userMessage(1), assistantMessage(1)]));
    snapshot();
    // Unrelated render (a streaming tick, a keystroke) before the 200ms flush
    await act(async () => controls.setUnrelated(1));
    snapshot();
    await flushVisibility();
    snapshot();

    expect(counts).toEqual([2, 2, 2]);
    expect(placeholders).toEqual([0, 0, 0]);
  });

  it('opening a long chat mounts only the tail and never blanks it', async () => {
    const messages = conversation(100);
    const { container } = render(<Harness initial={messages} />);

    const mounted = container.querySelectorAll('[data-message-id]').length;
    expect(mounted).toBe(INITIAL_MOUNT_COUNT);
    expect(markdownCalls.count).toBe(INITIAL_MOUNT_COUNT / 2);

    // Re-render before the first flush: nothing in view turns into a placeholder
    await act(async () => controls.setUnrelated(1));
    expect(container.querySelectorAll('.text-group-view').length).toBe(INITIAL_MOUNT_COUNT / 2);
    await flushVisibility();
    expect(container.querySelectorAll('.text-group-view').length).toBe(INITIAL_MOUNT_COUNT / 2);
    expect(container.querySelectorAll('div[aria-hidden="true"][style]').length).toBe(0);
  });

  it('mounts older messages at the sentinel and keeps the viewport in place', async () => {
    const messages = conversation(100);
    const { container } = render(<Harness initial={messages} />);
    await flushVisibility();

    const scrollContainer = container.querySelector('.overflow-y-auto') as HTMLElement;
    let scrollTop = 0;
    Object.defineProperty(scrollContainer, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value;
      },
    });
    const firstBefore = container
      .querySelector('[data-message-id]')!
      .getAttribute('data-message-id');

    await act(async () => triggerSentinel());

    expect(container.querySelectorAll('[data-message-id]').length).toBe(
      INITIAL_MOUNT_COUNT + MOUNT_BATCH_SIZE
    );
    // The previously-first message moved down by the inserted batch; the
    // scroll position follows it so the user sees the same content.
    expect(scrollTop).toBe(MOUNT_BATCH_SIZE * 120);
    const firstAfter = container
      .querySelector('[data-message-id]')!
      .getAttribute('data-message-id');
    expect(firstAfter).not.toBe(firstBefore);
    expect(firstAfter).toBe(messages[messages.length - INITIAL_MOUNT_COUNT - MOUNT_BATCH_SIZE].id);
  });

  describe('jumping with the scrubber', () => {
    /**
     * Scroll metrics for the list, with content height following what's
     * mounted. Starts scrolled to the bottom, like a freshly opened chat.
     */
    function fakeScrollMetrics(container: HTMLElement) {
      const scrollContainer = container.querySelector('.overflow-y-auto') as HTMLElement;
      const contentHeight = () => container.querySelectorAll('[data-message-id]').length * 120;
      let scrollTop = contentHeight() - 600;
      Object.defineProperty(scrollContainer, 'scrollTop', {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => {
          scrollTop = value;
        },
      });
      Object.defineProperty(scrollContainer, 'scrollHeight', {
        configurable: true,
        get: contentHeight,
      });
      Object.defineProperty(scrollContainer, 'clientHeight', { configurable: true, value: 600 });
      return {
        get scrollTop() {
          return scrollTop;
        },
      };
    }

    const mountedIds = (container: HTMLElement) =>
      Array.from(container.querySelectorAll('[data-message-id]')).map(element =>
        element.getAttribute('data-message-id')
      );

    it('jumps to the first message of a 1300-message chat by mounting ~30 messages there', async () => {
      const messages = conversation(650);
      const { container } = render(<Harness initial={messages} />);
      await flushVisibility();
      const scroll = fakeScrollMetrics(container);
      markdownCalls.count = 0;

      await act(async () => fireEvent.keyDown(screen.getByRole('scrollbar'), { key: 'Home' }));

      const mounted = mountedIds(container);
      expect(mounted).toHaveLength(INITIAL_MOUNT_COUNT);
      expect(mounted[0]).toBe(messages[0].id);
      expect(markdownCalls.count).toBe(INITIAL_MOUNT_COUNT / 2);
      expect(scroll.scrollTop).toBe(0);
      // Nothing older to load; newer messages load as the user scrolls down
      expect(liveSentinels('top')).toHaveLength(0);
      expect(liveSentinels('bottom')).toHaveLength(1);
    });

    it('grows downward at the bottom sentinel until it follows the tail again', async () => {
      const messages = conversation(50);
      const { container } = render(<Harness initial={messages} />);
      await flushVisibility();
      fakeScrollMetrics(container);
      await act(async () => fireEvent.keyDown(screen.getByRole('scrollbar'), { key: 'Home' }));
      expect(mountedIds(container)).toHaveLength(30);

      for (const expected of [50, 70, 90, 100]) {
        await act(async () => triggerSentinel('bottom'));
        expect(mountedIds(container)).toHaveLength(expected);
      }
      expect(liveSentinels('bottom')).toHaveLength(0);

      // Following the tail again: new messages mount
      await act(async () => controls.setMessages([...messages, userMessage(50)]));
      expect(mountedIds(container).at(-1)).toBe('u50');
    });

    it('in history, new messages wait behind the pill, which jumps back to the latest', async () => {
      const messages = conversation(50);
      const { container } = render(<Harness initial={messages} />);
      await flushVisibility();
      const scroll = fakeScrollMetrics(container);
      await act(async () => fireEvent.keyDown(screen.getByRole('scrollbar'), { key: 'Home' }));

      const grown = [...messages, userMessage(50), assistantMessage(50)];
      await act(async () => controls.setMessages(grown));
      expect(mountedIds(container)).not.toContain('a50');

      await act(async () =>
        fireEvent.click(screen.getByRole('button', { name: '2 new, jump to latest' }))
      );

      const mounted = mountedIds(container);
      expect(mounted).toHaveLength(INITIAL_MOUNT_COUNT);
      expect(mounted.at(-1)).toBe('a50');
      expect(scroll.scrollTop).toBe(INITIAL_MOUNT_COUNT * 120);
    });
  });
});
