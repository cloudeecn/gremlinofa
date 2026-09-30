import { useSyncExternalStore } from 'react';

/**
 * Exact complement of Tailwind v4's `md` breakpoint (`width >= 48rem`).
 * Layout gated by this hook sits next to `md:` classes, so both must flip at
 * the same width: rem in a media query follows the browser's default font
 * size (Large = 20px puts md at 960px), and a px query also leaves a gap at
 * fractional widths under zoom.
 */
const MOBILE_QUERY = '(width < 48rem)';

function subscribe(onChange: () => void): () => void {
  const mediaQuery = window.matchMedia(MOBILE_QUERY);
  mediaQuery.addEventListener('change', onChange);
  return () => mediaQuery.removeEventListener('change', onChange);
}

function getSnapshot(): boolean {
  return window.matchMedia(MOBILE_QUERY).matches;
}

function getServerSnapshot(): boolean {
  return false;
}

/** True below Tailwind's `md` breakpoint; updates live on resize. */
export function useIsMobile(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
