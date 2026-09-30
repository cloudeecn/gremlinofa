import { useEffect, type RefObject } from 'react';
import { useStableCallback } from './useStableCallback';

/**
 * One stack for every layer that closes on Escape (modals, dialogs, panels,
 * menus, the mobile drawer). Escape goes only to the top layer, so a picker
 * opened from a panel closes without taking the panel with it.
 */
interface OverlayEntry {
  onEscape: () => void;
  containerRef?: RefObject<HTMLElement | null>;
  trapFocus: boolean;
}

const stack: OverlayEntry[] = [];

// The element that most recently lost focus. When a layer's content
// autoFocuses, focus has already moved by the time the layer's effect runs,
// and this is where it came from.
let lastBlurred: Element | null = null;
if (typeof document !== 'undefined') {
  document.addEventListener(
    'focusout',
    event => {
      lastBlurred = event.target as Element;
    },
    true
  );
}

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
].join(',');

function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    element =>
      !element.closest('[inert],[hidden],[aria-hidden="true"]') &&
      // Skips display:none subtrees in browsers; jsdom has no checkVisibility
      (element.checkVisibility?.() ?? true)
  );
}

function trapTab(event: KeyboardEvent, container: HTMLElement) {
  const items = focusableElements(container);
  if (items.length === 0) {
    event.preventDefault();
    container.focus();
    return;
  }
  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement;
  if (!container.contains(active) || active === container) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  } else if (event.shiftKey && active === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}

// Bubble phase on document: React's root listeners run first, so an input
// that handles Escape itself can preventDefault and keep the layer open.
function handleKeyDown(event: KeyboardEvent) {
  const top = stack[stack.length - 1];
  if (!top) return;
  if (event.key === 'Escape') {
    if (event.isComposing || event.defaultPrevented) return;
    event.preventDefault();
    event.stopPropagation();
    top.onEscape();
  } else if (event.key === 'Tab' && top.trapFocus) {
    const container = top.containerRef?.current;
    if (container) trapTab(event, container);
  }
}

function push(entry: OverlayEntry) {
  if (stack.length === 0) document.addEventListener('keydown', handleKeyDown);
  stack.push(entry);
}

function remove(entry: OverlayEntry) {
  const index = stack.indexOf(entry);
  if (index !== -1) stack.splice(index, 1);
  if (stack.length === 0) document.removeEventListener('keydown', handleKeyDown);
}

export interface UseOverlayOptions {
  /** Registered while true; activation order is stack order. */
  active: boolean;
  onEscape: () => void;
  /**
   * Focused on activation unless something inside already has focus
   * (autoFocus). Give it `tabIndex={-1}` so it can take focus.
   */
  containerRef?: RefObject<HTMLElement | null>;
  /** Tab / Shift+Tab cycle inside the container while this layer is on top. */
  trapFocus?: boolean;
  /** On deactivation, focus returns to whatever had it at activation. */
  restoreFocus?: boolean;
}

export function useOverlay({
  active,
  onEscape,
  containerRef,
  trapFocus = false,
  restoreFocus = false,
}: UseOverlayOptions) {
  const handleEscape = useStableCallback(onEscape);

  useEffect(() => {
    if (!active) return;
    const container = containerRef?.current;
    const focusAlreadyInside = !!container?.contains(document.activeElement);
    const focusOrigin = focusAlreadyInside ? lastBlurred : document.activeElement;
    const previouslyFocused = focusOrigin instanceof HTMLElement ? focusOrigin : null;
    const entry: OverlayEntry = { onEscape: handleEscape, containerRef, trapFocus };
    push(entry);

    // Focus the layer itself, not its first control: focusing a text field
    // from a tap would pop the iOS keyboard. Tab then enters the content.
    if (container && !focusAlreadyInside) {
      container.focus({ preventScroll: true });
    }

    return () => {
      remove(entry);
      if (restoreFocus && previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, [active, containerRef, trapFocus, restoreFocus, handleEscape]);
}

/** Test-only: the number of registered layers. */
export function overlayStackDepth(): number {
  return stack.length;
}
