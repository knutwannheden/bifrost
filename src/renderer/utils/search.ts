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
