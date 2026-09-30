import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { INITIAL_MOUNT_COUNT, useMessageWindow } from '../useMessageWindow';

/** 100px per message, laid out by index and moved by the container's scrollTop. */
const MESSAGE_HEIGHT = 100;

class NoopIntersectionObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const originalIO = globalThis.IntersectionObserver;

function chat(count: number) {
  return Array.from({ length: count }, (_, i) => ({ id: `m${i}` }));
}

function setup(count: number, ready = true) {
  const container = document.createElement('div');
  let scrollTop = 0;
  Object.defineProperty(container, 'scrollTop', {
    get: () => scrollTop,
    set: (value: number) => {
      scrollTop = value;
    },
  });
  Object.defineProperty(container, 'scrollHeight', { value: 5000 });
  container.getBoundingClientRect = () => ({ top: 0 }) as DOMRect;
  container.scrollTo = vi.fn() as unknown as typeof container.scrollTo;

  const getElement = vi.fn((messageId: string) => {
    const index = Number(messageId.slice(1));
    const element = document.createElement('div');
    element.getBoundingClientRect = () => ({ top: index * MESSAGE_HEIGHT - scrollTop }) as DOMRect;
    return element;
  });

  const scrollContainerRef = { current: container };
  const hook = renderHook(
    ({ messages, isReady }) => useMessageWindow(messages, isReady, scrollContainerRef, getElement),
    { initialProps: { messages: chat(count), isReady: ready } }
  );
  return { ...hook, container };
}

describe('useMessageWindow', () => {
  beforeAll(() => {
    globalThis.IntersectionObserver =
      NoopIntersectionObserver as unknown as typeof IntersectionObserver;
  });

  afterAll(() => {
    globalThis.IntersectionObserver = originalIO;
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows the tail and fixes it once the list is ready', () => {
    const { result, rerender } = setup(100, false);
    expect(result.current).toMatchObject({ start: 70, end: 100, followingTail: true });
    // Not fixed yet: no sentinel while the snapshot replays
    expect(result.current.hasMoreAbove).toBe(false);

    rerender({ messages: chat(100), isReady: true });
    expect(result.current).toMatchObject({ start: 70, hasMoreAbove: true, hasMoreBelow: false });

    // Appended messages mount; the start stays put
    rerender({ messages: chat(101), isReady: true });
    expect(result.current).toMatchObject({ start: 70, end: 101, followingTail: true });
  });

  it('jumps into history by mounting a window around the target', () => {
    const { result, container } = setup(1300);

    act(() => result.current.jumpTo(500));

    expect(result.current).toMatchObject({
      start: 490,
      end: 520,
      followingTail: false,
      hasMoreAbove: true,
      hasMoreBelow: true,
    });
    // Target lands 8px below the container top
    expect(container.scrollTop).toBe(500 * MESSAGE_HEIGHT - 8);
  });

  it('jumping to a mounted message only scrolls', () => {
    const { result, container } = setup(1300);

    act(() => result.current.jumpTo(1290));

    expect(result.current).toMatchObject({ start: 1270, end: 1300, followingTail: true });
    expect(container.scrollTop).toBe(1290 * MESSAGE_HEIGHT - 8);
  });

  it('a jump whose window reaches the end follows the tail', () => {
    const { result } = setup(1300);
    act(() => result.current.jumpTo(0));
    expect(result.current).toMatchObject({ start: 0, end: 30, followingTail: false });

    act(() => result.current.jumpTo(1290));

    expect(result.current).toMatchObject({ start: 1280, end: 1300, followingTail: true });
  });

  it('truncation below the window falls back to the tail', () => {
    const { result, rerender } = setup(1300);
    act(() => result.current.jumpTo(500));

    rerender({ messages: chat(400), isReady: true });

    expect(result.current).toMatchObject({
      start: 400 - INITIAL_MOUNT_COUNT,
      end: 400,
      followingTail: true,
    });
  });

  it('truncation inside the window keeps its start and follows the new tail', () => {
    const { result, rerender } = setup(1300);
    act(() => result.current.jumpTo(500));

    rerender({ messages: chat(510), isReady: true });

    expect(result.current).toMatchObject({ start: 490, end: 510, followingTail: true });
  });

  it('jumpToLatest from history mounts the tail and scrolls to the bottom', () => {
    const { result, container } = setup(1300);
    act(() => result.current.jumpTo(0));

    act(() => result.current.jumpToLatest());

    expect(result.current).toMatchObject({ start: 1270, end: 1300, followingTail: true });
    expect(container.scrollTop).toBe(5000);
  });

  it('jumpToLatest on the tail scrolls in place, animated when asked', () => {
    const { result, container } = setup(1300);

    act(() => result.current.jumpToLatest());
    expect(container.scrollTop).toBe(5000);

    act(() => result.current.jumpToLatest('smooth'));
    expect(container.scrollTo).toHaveBeenCalledWith({ top: 5000, behavior: 'smooth' });
    expect(result.current.start).toBe(1270);
  });

  it('an emptied chat re-fixes the tail when messages come back', () => {
    const { result, rerender } = setup(1300);
    act(() => result.current.jumpTo(0));

    rerender({ messages: chat(0), isReady: true });
    rerender({ messages: chat(100), isReady: true });

    expect(result.current).toMatchObject({ start: 70, end: 100, followingTail: true });
  });
});
