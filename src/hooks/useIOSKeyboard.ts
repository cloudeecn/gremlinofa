import { useEffect, useRef, useCallback } from 'react';

/**
 * Hook that handles iOS Safari/PWA virtual keyboard viewport issues.
 *
 * iOS has a bug where the visualViewport doesn't properly sync with the layout,
 * causing touch targets to become misaligned with visual elements. This hook
 * tracks the keyboard offset and applies a CSS custom property for compensation.
 *
 * On non-iOS platforms, the offset is always 0 (no effect).
 */
export function useIOSKeyboard() {
  const lastOffsetRef = useRef(0);

  const updateKeyboardOffset = useCallback(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;

    // Calculate the offset between window height and visible viewport
    // On iOS, when keyboard opens, visualViewport.height shrinks but window.innerHeight stays same
    // offsetTop accounts for any scroll offset in the visual viewport
    const offset = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);

    // Only update DOM if offset changed (avoid unnecessary style recalcs)
    if (offset !== lastOffsetRef.current) {
      lastOffsetRef.current = offset;
      document.documentElement.style.setProperty('--keyboard-offset', `${offset}px`);
    }
  }, []);

  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) {
      // Browser doesn't support visualViewport, ensure variable is 0
      document.documentElement.style.setProperty('--keyboard-offset', '0px');
      return;
    }

    // Initial update
    updateKeyboardOffset();

    // Listen to both resize (keyboard open/close) and scroll (iOS viewport pan)
    viewport.addEventListener('resize', updateKeyboardOffset);
    viewport.addEventListener('scroll', updateKeyboardOffset);

    // Also listen to window resize for orientation changes
    window.addEventListener('resize', updateKeyboardOffset);

    return () => {
      viewport.removeEventListener('resize', updateKeyboardOffset);
      viewport.removeEventListener('scroll', updateKeyboardOffset);
      window.removeEventListener('resize', updateKeyboardOffset);
      // Reset on unmount
      document.documentElement.style.setProperty('--keyboard-offset', '0px');
    };
  }, [updateKeyboardOffset]);
}
