import { useState, useEffect, useRef } from 'react';

/**
 * Detects whether the virtual keyboard is likely visible on mobile.
 *
 * Tracks the maximum VisualViewport height ever observed as a stable baseline.
 * When the current height drops below 75% of that max, the keyboard is open.
 *
 * This works on iOS Safari with viewport-fit=cover, where both
 * visualViewport.height and window.innerHeight shrink together on keyboard open.
 *
 * Orientation changes (width shift >100px) reset the baseline.
 * Returns false on desktop or when VisualViewport API is unavailable.
 *
 * iOS Safari fires many resize events per keyboard frame during the open/close
 * animation. Cascading re-renders during that window have been linked to a
 * pointer-event lock on iPhone. The handler coalesces resize bursts onto the
 * next animation frame so we settle on a single state update per frame.
 */
export function useIsKeyboardVisible(): boolean {
  const [visible, setVisible] = useState(false);
  const maxHeightRef = useRef(0);
  const prevWidthRef = useRef(0);
  const rafIdRef = useRef(0);

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;

    maxHeightRef.current = vv.height;
    prevWidthRef.current = vv.width;

    const onResize = () => {
      if (rafIdRef.current !== 0) return;
      rafIdRef.current = requestAnimationFrame(() => {
        rafIdRef.current = 0;

        // Orientation change (width shift >100px) → reset baseline
        if (Math.abs(vv.width - prevWidthRef.current) > 100) {
          maxHeightRef.current = vv.height;
          prevWidthRef.current = vv.width;
          setVisible(false);
          return;
        }

        // Height increased (e.g. address bar hid) → update baseline
        if (vv.height > maxHeightRef.current) {
          maxHeightRef.current = vv.height;
        }

        // Keyboard takes 30-50% of screen → 75% threshold
        const next = vv.height < maxHeightRef.current * 0.75;
        // [iOS-diag] One log per frame to verify rAF debounce on iPhone.
        console.debug(
          '[kbd] vv h=%o max=%o offsetTop=%o visible=%o',
          vv.height,
          maxHeightRef.current,
          vv.offsetTop,
          next
        );
        setVisible(next);
      });
    };

    vv.addEventListener('resize', onResize);
    return () => {
      vv.removeEventListener('resize', onResize);
      if (rafIdRef.current !== 0) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = 0;
      }
    };
  }, []);

  return visible;
}
