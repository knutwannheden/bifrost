import { useState, useCallback } from 'react';

/**
 * Reusable instant search hook for type-to-filter overlays.
 *
 * Handles the common pattern: typing appends to search, Backspace deletes,
 * Alt+Backspace deletes a word, Esc clears search (returning true so the
 * caller can skip its own close logic).
 *
 * Usage in a keydown handler:
 *   if (handleSearchKey(e)) return;
 *   // …overlay-specific keys…
 */
export function useInstantSearch() {
  const [search, setSearch] = useState('');

  /** Process a keyboard event. Returns true if the event was consumed. */
  const handleSearchKey = useCallback((e: React.KeyboardEvent | KeyboardEvent): boolean => {
    if (e.key === 'Escape' && search) {
      e.preventDefault();
      (e as Event).stopPropagation?.();
      setSearch('');
      return true;
    }

    if (e.key === 'Backspace' && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      if (e.altKey) {
        setSearch((s) => s.replace(/\S+\s*$/, ''));
      } else {
        setSearch((s) => s.slice(0, -1));
      }
      return true;
    }

    // Single printable character with no modifiers → append
    if (!e.metaKey && !e.ctrlKey && !e.altKey && e.key.length === 1) {
      e.preventDefault();
      setSearch((s) => s + e.key);
      return true;
    }

    return false;
  }, [search]);

  const clearSearch = useCallback(() => setSearch(''), []);

  return { search, setSearch, handleSearchKey, clearSearch } as const;
}
