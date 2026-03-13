import type React from 'react';
import { useEffect, useRef } from 'react';

/**
 * Manages focus for modal overlays: focuses the target element on mount,
 * and restores focus to the previously-focused element on unmount.
 */
export function useOverlayFocus(targetRef: React.RefObject<HTMLElement | null>) {
  const previousFocusRef = useRef<Element | null>(null);

  useEffect(() => {
    previousFocusRef.current = document.activeElement;
    targetRef.current?.focus();
    return () => {
      const prev = previousFocusRef.current;
      if (prev && prev instanceof HTMLElement && document.contains(prev)) {
        prev.focus();
      }
    };
  }, []);
}
