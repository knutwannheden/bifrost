import type { Repo, Task } from '../../shared/types';

/**
 * How a task is referred to in a Claude session, matching what Claude Code's
 * own status bar shows: the repo's short name and the branch being worked on.
 */
export function taskReference(task: Task, repos: Repo[]): string | null {
  const repo = repos.find((r) => r.id === task.repoId);
  if (!repo) return null;
  return `${repo.name}@${task.branch ?? task.baseBranch}`;
}
