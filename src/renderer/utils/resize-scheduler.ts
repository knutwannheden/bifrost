export interface LeadingCoalescer {
  /** Run now if the last run has had its quiet window, else after the burst settles. */
  request(): void;
  /** Drop a run the burst still owes (call on teardown). */
  cancel(): void;
}

/**
 * Coalesce a burst of requests into a run at its leading edge and one more once
 * it settles. The run reshapes xterm, so a trailing-only run would leave the
 * child drawing against the grid it had before the burst for the whole window,
 * putting its cursor-relative repaints on the wrong rows; the trailing run
 * carries the size the burst finished at. A drag costs two runs, not one a frame.
 */
export function createLeadingCoalescer(run: () => void, quietMs: number): LeadingCoalescer {
  let quietWindow: ReturnType<typeof setTimeout> | null = null;
  let owed = false;

  const onQuiet = (): void => {
    quietWindow = null;
    if (!owed) return;
    owed = false;
    run();
  };

  return {
    request(): void {
      // Restarting the window is what makes this a debounce: a window left to
      // expire would run once per interval through a long burst.
      if (quietWindow === null) run();
      else {
        clearTimeout(quietWindow);
        owed = true;
      }
      quietWindow = setTimeout(onQuiet, quietMs);
    },
    cancel(): void {
      if (quietWindow) clearTimeout(quietWindow);
      quietWindow = null;
      owed = false;
    },
  };
}
