import { useCallback, useState } from 'react';

/**
 * Reusable instant search hook for type-to-filter overlays.
 *
 * Handles the common pattern: typing appends to search, Backspace deletes,
 * Alt+Backspace deletes a word, Esc clears search (returning true so the
 * caller can skip its own close logic). Cmd+F opens the search bar.
 *
 * Usage in a keydown handler:
 *   if (handleSearchKey(e)) return;
 *   // …overlay-specific keys…
 */
export function useInstantSearch() {
  const [search, setSearch] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);

  /** Whether the search bar should be visible (has text or explicitly opened) */
  const searchVisible = search.length > 0 || searchOpen;

  /** Process a keyboard event. Returns true if the event was consumed. */
  const handleSearchKey = useCallback(
    (e: React.KeyboardEvent | KeyboardEvent): boolean => {
      // Cmd+F / Ctrl+F opens search bar
      if (e.key === 'f' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setSearchOpen(true);
        return true;
      }

      if (e.key === 'Escape' && (search || searchOpen)) {
        e.preventDefault();
        (e as Event).stopPropagation?.();
        setSearch('');
        setSearchOpen(false);
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
        setSearchOpen(true);
        return true;
      }

      return false;
    },
    [search, searchOpen],
  );

  const clearSearch = useCallback(() => {
    setSearch('');
    setSearchOpen(false);
  }, []);

  return { search, searchVisible, setSearch, handleSearchKey, clearSearch } as const;
}
