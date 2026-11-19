import type { Repo } from '../../shared/types';

/** Replace /Users/<user> or /home/<user> prefix with ~ */
export function shortPath(p: string): string {
  const m = p.match(/^(\/Users\/[^/]+|\/home\/[^/]+)/);
  return m ? `~${p.slice(m[1].length)}` : p;
}

/** Names a task's repo when none here matches it, after the directory whose .worktrees holds the task. */
export function repoNameFromWorktree(worktreePath: string): string {
  const at = worktreePath.lastIndexOf('/.worktrees/');
  if (at < 0) return shortPath(worktreePath);
  const repoPath = worktreePath.slice(0, at);
  return repoPath.slice(repoPath.lastIndexOf('/') + 1);
}

/** Human-readable repo name: prefer GitHub org/repo, fall back to local name. */
export function repoDisplayName(repo: Repo): string {
  return repo.githubPath ?? repo.name;
}
