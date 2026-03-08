import type { Repo } from '../../shared/types';

/** Replace /Users/<user> or /home/<user> prefix with ~ */
export function shortPath(p: string): string {
  const m = p.match(/^(\/Users\/[^/]+|\/home\/[^/]+)/);
  return m ? `~${p.slice(m[1].length)}` : p;
}

/** Human-readable repo name: prefer GitHub org/repo, fall back to local name. */
export function repoDisplayName(repo: Repo): string {
  return repo.githubPath ?? repo.name;
}
