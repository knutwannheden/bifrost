/** Rows rendered before the list has to grow, worth several screenfuls. */
export const PAGE_SIZE = 60;

/** Rows to keep rendered so the focused one is among them. Grows only. */
export function visibleCountFor(focusedIdx: number, visibleCount: number, total: number): number {
  // Growing a few rows early keeps the focused row one React has already
  // rendered, which is what scrollIntoView needs to find it.
  if (focusedIdx <= visibleCount - 5) return visibleCount;
  return Math.max(visibleCount, Math.min(total, focusedIdx + PAGE_SIZE));
}
