import React, { useState, useRef, useEffect } from 'react';
import type { Repo } from '../../shared/types';
import { shortPath, repoDisplayName } from '../utils/paths';
import { matchesRepoSearch } from '../utils/search';

type Size = 'sm' | 'md';

interface RepoDropdownProps {
  repos: Repo[];
  selectedId: string;
  onSelect: (id: string) => void;
  /** Extra keydown handler called before the dropdown's own — return true to consume the event. */
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => boolean | void;
  placeholder?: string;
  size?: Size;
  inputRef?: React.RefObject<HTMLInputElement | null>;
  autoFocus?: boolean;
}

const sizeStyles: Record<Size, { input: string; item: string; name: string; path: string }> = {
  sm: {
    input: 'px-2.5 py-1 text-xs',
    item: 'px-2.5 py-1.5',
    name: 'text-xs',
    path: 'text-[10px]',
  },
  md: {
    input: 'px-3 py-1.5 text-sm',
    item: 'px-3 py-1.5',
    name: 'text-sm',
    path: 'text-xs',
  },
};

export default function RepoDropdown({
  repos,
  selectedId,
  onSelect,
  onKeyDown,
  placeholder = 'Type to search...',
  size = 'md',
  inputRef: externalInputRef,
  autoFocus,
}: RepoDropdownProps) {
  const internalRef = useRef<HTMLInputElement>(null);
  const inputRef = externalInputRef ?? internalRef;
  const listRef = useRef<HTMLDivElement>(null);

  const selectedRepo = repos.find((r) => r.id === selectedId);
  const [search, setSearch] = useState(selectedRepo ? repoDisplayName(selectedRepo) : '');
  const [open, setOpen] = useState(false);
  const [focusedIdx, setFocusedIdx] = useState(0);

  // Sync display text when selection changes externally
  useEffect(() => {
    const repo = repos.find((r) => r.id === selectedId);
    if (repo) setSearch(repoDisplayName(repo));
  }, [selectedId, repos]);

  const inputFullySelected =
    inputRef.current &&
    inputRef.current.selectionStart === 0 &&
    inputRef.current.selectionEnd === inputRef.current.value.length &&
    inputRef.current.value.length > 0;

  const filtered = repos.filter((r) => {
    if (!search || inputFullySelected) return true;
    return matchesRepoSearch(r, search);
  });

  useEffect(() => {
    setFocusedIdx(0);
  }, [search]);

  useEffect(() => {
    listRef.current?.children[focusedIdx]?.scrollIntoView({ block: 'nearest' });
  }, [focusedIdx]);

  useEffect(() => {
    if (autoFocus) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [autoFocus]);

  const selectItem = (id: string) => {
    const repo = repos.find((r) => r.id === id);
    if (repo) {
      setSearch(repoDisplayName(repo));
      setOpen(false);
      onSelect(id);
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSearch(e.target.value);
    setOpen(true);
    // Clear selection if search no longer matches
    const match = repos.find((r) => r.id === selectedId);
    if (match && !matchesRepoSearch(match, e.target.value)) {
      onSelect('');
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (onKeyDown?.(e)) return;

    if (filtered.length === 0) return;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        if (!open) {
          setOpen(true);
        } else {
          setFocusedIdx((i) => (i < filtered.length - 1 ? i + 1 : 0));
        }
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (!open) {
          setOpen(true);
        } else {
          setFocusedIdx((i) => (i > 0 ? i - 1 : filtered.length - 1));
        }
        break;
      case 'Enter':
        if (open) {
          e.preventDefault();
          e.stopPropagation();
          if (filtered[focusedIdx]) selectItem(filtered[focusedIdx].id);
        }
        break;
      case 'Tab':
        if (open && filtered[focusedIdx]) {
          selectItem(filtered[focusedIdx].id);
        }
        break;
    }
  };

  const styles = sizeStyles[size];

  return (
    <div className="relative">
      <input
        ref={inputRef}
        type="text"
        value={search}
        onChange={handleChange}
        onFocus={() => inputRef.current?.select()}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        className={`w-full ${styles.input} bg-surface-alt border border-border-input rounded text-primary placeholder-muted focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent`}
      />
      {open && filtered.length > 0 && (
        <div
          ref={listRef}
          className="absolute z-10 mt-1 w-full bg-surface-alt border border-border-input rounded shadow-lg max-h-[200px] overflow-y-auto"
        >
          {filtered.map((repo, idx) => (
            <div
              key={repo.id}
              onMouseDown={() => selectItem(repo.id)}
              onMouseEnter={() => setFocusedIdx(idx)}
              className={`${styles.item} cursor-pointer ${
                idx === focusedIdx
                  ? 'bg-accent text-white'
                  : 'text-primary hover:bg-surface-hover'
              }`}
            >
              <div className={styles.name}>{repoDisplayName(repo)}</div>
              <div className={`${styles.path} ${idx === focusedIdx ? 'text-white/70' : 'text-secondary'}`}>
                {shortPath(repo.path)}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
