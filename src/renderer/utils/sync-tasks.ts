import type { Task } from '../../shared/types.ts';

/** Only the renderer sets a task's unread mark and its activity, so a reload of the list keeps them. */
export function syncTasks(current: Task[], fresh: Task[]): Task[] {
  const known = new Map(current.map((t) => [t.id, t]));
  return fresh.map((t) => {
    const was = known.get(t.id);
    return was ? { ...t, hasUnread: was.hasUnread, claudeActive: was.claudeActive } : t;
  });
}
