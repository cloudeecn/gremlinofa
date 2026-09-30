import { useCallback, useRef } from 'react';
import type { KeyboardEvent } from 'react';

/**
 * Tells the Enter that confirms an IME candidate (CJK input) apart from one
 * that submits. Safari flags it with `isComposing`; Chrome fires that keydown
 * after `compositionend` with `isComposing: false`, so a flag stays up for one
 * frame after compositionend to catch it.
 *
 * `onCompositionEnd` goes on the input as a React prop, which keeps working
 * for inputs that mount after the component (a listener attached in a mount
 * effect never reaches them).
 */
export function useImeSafeEnter() {
  const compositionJustEndedRef = useRef(false);

  const onCompositionEnd = useCallback(() => {
    compositionJustEndedRef.current = true;
    requestAnimationFrame(() => {
      compositionJustEndedRef.current = false;
    });
  }, []);

  const isImeEnter = useCallback(
    (e: KeyboardEvent) => e.nativeEvent.isComposing || compositionJustEndedRef.current,
    []
  );

  return { onCompositionEnd, isImeEnter };
}
