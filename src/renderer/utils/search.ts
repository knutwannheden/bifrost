/** Split a search string into lowercase terms for multi-word AND matching. */
export function searchTerms(search: string): string[] {
  return search.toLowerCase().split(/\s+/).filter(Boolean);
}

/** Test whether all search terms appear in the haystack (case-insensitive AND match). */
export function matchesAllTerms(haystack: string, search: string): boolean {
  if (!search) return true;
  const lower = haystack.toLowerCase();
  return searchTerms(search).every((term) => lower.includes(term));
}

/** Match a Repo by its display name and path against a search string. */
export function matchesRepoSearch(repo: { githubPath?: string; name: string; path: string }, search: string): boolean {
  return matchesAllTerms(`${repo.githubPath ?? repo.name} ${repo.path}`, search);
}

/**
 * Match a task against a search string. The fork point is searchable only when
 * the task's own branch is unknown; nearly every task shares it, so it matches
 * everything.
 */
export function matchesTaskSearch(
  task: { name: string; branch?: string; baseBranch: string; summary?: string },
  repoName: string,
  search: string,
): boolean {
  return matchesAllTerms(`${task.name} ${task.branch ?? task.baseBranch} ${repoName} ${task.summary ?? ''}`, search);
}
