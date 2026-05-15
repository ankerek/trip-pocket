import { useCallback, useRef } from 'react';

// Counts taps that arrive within `windowMs` of the previous tap. Reaching
// `threshold` fires `onTrigger` and resets. A gap longer than `windowMs`
// also resets — without that, two taps on Monday plus five on Friday would
// trigger a hidden affordance.
export function useTapCounter(
  threshold: number,
  windowMs: number,
  onTrigger: () => void,
): () => void {
  const count = useRef(0);
  const last = useRef(0);

  return useCallback(() => {
    const now = Date.now();
    if (now - last.current > windowMs) count.current = 0;
    last.current = now;
    count.current += 1;
    if (count.current >= threshold) {
      count.current = 0;
      last.current = 0;
      onTrigger();
    }
  }, [threshold, windowMs, onTrigger]);
}
