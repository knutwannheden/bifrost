import React, { useEffect, useRef, useState, useCallback } from 'react';
import { searchAddonRegistry } from '../hooks/useTerminal';
import type { ISearchOptions } from '@xterm/addon-search';

interface TerminalSearchBarProps {
  sessionId: string;
  onClose: () => void;
}

const DECORATIONS: ISearchOptions['decorations'] = {
  matchBackground: '#44475a',
  matchBorder: '#6272a4',
  matchOverviewRuler: '#6272a4',
  activeMatchBackground: '#6272a4',
  activeMatchBorder: '#bd93f9',
  activeMatchColorOverviewRuler: '#bd93f9',
};

export default function TerminalSearchBar({ sessionId, onClose }: TerminalSearchBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [resultIndex, setResultIndex] = useState(-1);
  const [resultCount, setResultCount] = useState(0);

  const searchAddon = searchAddonRegistry.get(sessionId);

  // Subscribe to result changes
  useEffect(() => {
    if (!searchAddon) return;
    const disposable = searchAddon.onDidChangeResults((e) => {
      setResultIndex(e.resultIndex);
      setResultCount(e.resultCount);
    });
    return () => disposable.dispose();
  }, [searchAddon]);

  // Auto-focus the input on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Clear decorations on unmount
  useEffect(() => {
    return () => {
      searchAddon?.clearDecorations();
    };
  }, [searchAddon]);

  const doSearch = useCallback(
    (term: string, incremental: boolean) => {
      if (!searchAddon) return;
      if (!term) {
        searchAddon.clearDecorations();
        setResultIndex(-1);
        setResultCount(0);
        return;
      }
      searchAddon.findNext(term, { incremental, decorations: DECORATIONS });
    },
    [searchAddon],
  );

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setQuery(value);
    doSearch(value, true);
  };

  const findNext = useCallback(() => {
    if (!searchAddon || !query) return;
    searchAddon.findNext(query, { decorations: DECORATIONS });
  }, [searchAddon, query]);

  const findPrevious = useCallback(() => {
    if (!searchAddon || !query) return;
    searchAddon.findPrevious(query, { decorations: DECORATIONS });
  }, [searchAddon, query]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === 'Enter' && e.shiftKey) {
      e.preventDefault();
      findPrevious();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      findNext();
    }
  };

  const matchLabel =
    resultCount > 0
      ? `${resultIndex >= 0 ? resultIndex + 1 : '?'} of ${resultCount}`
      : query
        ? 'No results'
        : '';

  return (
    <div
      className="absolute top-1 right-4 z-10 flex items-center gap-1 rounded bg-slate-800 border border-slate-600 px-2 py-1 shadow-lg"
      onMouseDown={(e) => e.stopPropagation()}
    >
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        placeholder="Find…"
        className="bg-transparent text-sm text-slate-200 placeholder-slate-500 outline-none w-40"
      />
      {matchLabel && (
        <span className="text-xs text-slate-400 whitespace-nowrap mr-1">{matchLabel}</span>
      )}
      <button
        onClick={findPrevious}
        title="Previous match (Shift+Enter)"
        className="text-slate-400 hover:text-slate-200 text-sm px-1"
      >
        &#x25B2;
      </button>
      <button
        onClick={findNext}
        title="Next match (Enter)"
        className="text-slate-400 hover:text-slate-200 text-sm px-1"
      >
        &#x25BC;
      </button>
      <button
        onClick={onClose}
        title="Close (Escape)"
        className="text-slate-400 hover:text-slate-200 text-lg leading-none px-1"
      >
        &times;
      </button>
    </div>
  );
}
