import { useLayoutEffect, useRef } from 'react';

const DURATION_MS = 180;

/**
 * Animate `[data-flip-key]` descendants from where they were to where they
 * landed. Positions are measured against the scrolling container rather than
 * the viewport, so scrolling between renders is not mistaken for movement.
 *
 * `order` must change exactly when the layout does; measuring on every render
 * would read layout the rest of the time for nothing.
 */
export function useFlipList(containerRef: React.RefObject<HTMLElement | null>, order: string): void {
  const previous = useRef<Map<string, number> | null>(null);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const top = container.getBoundingClientRect().top - container.scrollTop;
    const nodes = container.querySelectorAll<HTMLElement>('[data-flip-key]');
    const current = new Map<string, number>();
    for (const node of nodes) {
      const key = node.dataset.flipKey;
      if (key) current.set(key, node.getBoundingClientRect().top - top);
    }

    const before = previous.current;
    previous.current = current;
    if (!before || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    for (const node of nodes) {
      const key = node.dataset.flipKey;
      if (!key) continue;
      const from = before.get(key);
      const to = current.get(key);
      // A row with no previous position is new, so it has nowhere to move from.
      if (from === undefined || to === undefined) continue;
      const delta = from - to;
      if (Math.abs(delta) < 1) continue;
      node.animate([{ transform: `translateY(${delta}px)` }, { transform: 'none' }], {
        duration: DURATION_MS,
        easing: 'ease-out',
      });
    }
  }, [containerRef, order]);
}
