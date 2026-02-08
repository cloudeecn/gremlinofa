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
 */
export function useIsKeyboardVisible(): boolean {
  const [visible, setVisible] = useState(false);
  const maxHeightRef = useRef(0);
  const prevWidthRef = useRef(0);

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;

    maxHeightRef.current = vv.height;
    prevWidthRef.current = vv.width;

    const onResize = () => {
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
      setVisible(vv.height < maxHeightRef.current * 0.75);
    };

    vv.addEventListener('resize', onResize);
    return () => vv.removeEventListener('resize', onResize);
  }, []);

  return visible;
}
