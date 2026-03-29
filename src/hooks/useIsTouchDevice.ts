import { useEffect, useState } from 'react';

/**
 * Detects whether the primary input device is touch-based (coarse pointer).
 * Unlike useIsMobile (screen width), this doesn't change when resizing the window.
 * Used for input behavior decisions (Enter to send vs newline).
 */
export function useIsTouchDevice(): boolean {
  const [isTouchDevice, setIsTouchDevice] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia('(pointer: coarse)').matches;
  });

  useEffect(() => {
    const mediaQuery = window.matchMedia('(pointer: coarse)');
    const handleChange = (e: MediaQueryListEvent | MediaQueryList) => {
      setIsTouchDevice(e.matches);
    };
    handleChange(mediaQuery);
    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, []);

  return isTouchDevice;
}
