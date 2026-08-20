import type { AppState } from '../context/AppContext';

/**
 * The running task to fall back to when `closingId` goes away: the one the
 * user was on most recently. lastActiveAt only records tabs that survived the
 * dwell, so cycling past a tab does not make it the fallback. Tasks never
 * visited in this run have no entry and are ordered behind those that were.
 */
export function nextActiveTaskId(state: AppState, closingId: string): string | null {
  const at = (id: string) => state.lastActiveAt[id] ?? 0;
  let best: string | null = null;
  for (const task of state.tasks) {
    if (task.id === closingId || task.status !== 'running') continue;
    if (best === null || at(task.id) > at(best)) best = task.id;
  }
  return best;
}
