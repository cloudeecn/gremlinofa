import { useCallback, useLayoutEffect, useRef } from 'react';

/**
 * Returns a function whose identity never changes but always calls the
 * latest `fn`. Use it for handlers passed into memoized children when the
 * handler closes over state that changes every render (the chat's
 * `messages`, useChat's non-memoized commands).
 *
 * Don't call the returned function during render: it reads the version of
 * `fn` from the last commit.
 */
export function useStableCallback<Args extends unknown[], Return>(
  fn: (...args: Args) => Return
): (...args: Args) => Return {
  const fnRef = useRef(fn);
  useLayoutEffect(() => {
    fnRef.current = fn;
  });
  return useCallback((...args: Args) => fnRef.current(...args), []);
}
