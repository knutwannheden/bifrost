import type { Task } from '../shared/types.ts';

export interface RestorePlan {
  /** Tasks whose session still runs in tmux on this machine, joined at once. */
  join: string[];
  /** Tasks started or joined when their tab opens. */
  defer: string[];
  /** Tasks whose session id names a transcript that cannot be resumed. */
  dropSessionId: string[];
}

/**
 * How a starting Bifrost brings back the tasks that were running. A session
 * still running in tmux keeps its id, whatever its transcript holds so far.
 * A task whose worktree here is gone stays stopped.
 */
export function planRestore(
  tasks: Task[],
  running: Set<string>,
  isStale: (task: Task) => boolean,
  exists: (path: string) => boolean,
): RestorePlan {
  const plan: RestorePlan = { join: [], defer: [], dropSessionId: [] };
  for (const task of tasks) {
    // A remote worktree is not on this disk, so whether it still exists is for the attach to find out.
    if (task.machine) {
      plan.defer.push(task.id);
      continue;
    }
    if (!exists(task.worktreePath)) continue;
    if (running.has(task.id)) {
      plan.join.push(task.id);
      continue;
    }
    plan.defer.push(task.id);
    if (task.sessionId && isStale(task)) plan.dropSessionId.push(task.id);
  }
  return plan;
}

/** The machines an open task runs on. */
export function machinesInUse(tasks: Task[]): string[] {
  return [...new Set(tasks.flatMap((t) => (t.status === 'running' && t.machine ? [t.machine] : [])))];
}
