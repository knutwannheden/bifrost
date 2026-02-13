import React, { useState, useCallback, useRef, useEffect } from 'react';
import { useApp } from '../context/AppContext';

function ActionLabel({ text, hintIndex = 0, showHint }: { text: string; hintIndex?: number; showHint: boolean }) {
  if (!showHint) return <>{text}</>;
  return (
    <>
      {text.slice(0, hintIndex)}
      <span className="underline underline-offset-2">{text[hintIndex]}</span>
      {text.slice(hintIndex + 1)}
    </>
  );
}

export default function RepoManager() {
  const { state, dispatch } = useApp();
  const [localPath, setLocalPath] = useState('');
  const [search, setSearch] = useState('');
  const [focusedIdx, setFocusedIdx] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [inputFocused, setInputFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const repoRefs = useRef<(HTMLDivElement | null)[]>([]);

  const close = useCallback(() => {
    dispatch({ type: 'TOGGLE_REPO_MANAGER' });
  }, [dispatch]);

  useEffect(() => {
    overlayRef.current?.focus();
  }, []);

  const searchLower = search.toLowerCase();
  const filteredRepos = state.repos.filter((r) => {
    if (!searchLower) return true;
    return `${r.name} ${r.path}`.toLowerCase().includes(searchLower);
  });

  // Reset focus when search changes
  useEffect(() => {
    setFocusedIdx(0);
  }, [search]);

  // Clamp focus index
  useEffect(() => {
    if (focusedIdx >= filteredRepos.length && filteredRepos.length > 0) {
      setFocusedIdx(filteredRepos.length - 1);
    }
  }, [filteredRepos.length, focusedIdx]);

  // Scroll focused item into view
  useEffect(() => {
    repoRefs.current[focusedIdx]?.scrollIntoView({ block: 'nearest' });
  }, [focusedIdx]);

  const handleBrowse = async () => {
    const selected = await window.bifrost.selectDirectory();
    if (selected) {
      setLocalPath(selected);
    }
  };

  const handleAddLocal = async () => {
    if (!localPath.trim()) return;
    setError(null);
    try {
      const repo = await window.bifrost.addRepo({ type: 'local', path: localPath.trim() });
      dispatch({ type: 'SET_REPOS', repos: [...state.repos, repo] });
      setLocalPath('');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to add repo');
    }
  };

  const handleRemove = async (repoId: string) => {
    await window.bifrost.removeRepo(repoId);
    dispatch({ type: 'SET_REPOS', repos: state.repos.filter((r) => r.id !== repoId) });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Let the input handle its own keys when focused
    if (inputFocused) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        inputRef.current?.blur();
        overlayRef.current?.focus();
      }
      return;
    }

    const focusedRepo = filteredRepos[focusedIdx];

    switch (e.key) {
      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        if (search) {
          setSearch('');
        } else {
          close();
        }
        break;

      case 'ArrowUp':
        e.preventDefault();
        setFocusedIdx((i) => (i > 0 ? i - 1 : filteredRepos.length - 1));
        break;

      case 'ArrowDown':
        e.preventDefault();
        setFocusedIdx((i) => (i < filteredRepos.length - 1 ? i + 1 : 0));
        break;

      case 'Backspace':
        e.preventDefault();
        setSearch((s) => s.slice(0, -1));
        break;

      case 'Tab':
        e.preventDefault();
        inputRef.current?.focus();
        break;

      default:
        // Alt+letter shortcuts
        if (e.altKey && focusedRepo) {
          switch (e.code) {
            case 'KeyR':
              e.preventDefault();
              handleRemove(focusedRepo.id);
              break;
          }
        } else if (!e.metaKey && !e.ctrlKey && !e.altKey && e.key.length === 1) {
          e.preventDefault();
          setSearch((s) => s + e.key);
        }
        break;
    }
  };

  return (
    <div
      ref={overlayRef}
      tabIndex={-1}
      className="fixed inset-0 z-20 flex items-center justify-center bg-black/60 focus:outline-none"
      onClick={close}
      onKeyDown={handleKeyDown}
    >
      <div
        className="bg-slate-800 rounded-lg border border-slate-600 w-[500px] max-h-[80vh] overflow-hidden shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700">
          <h2 className="text-sm font-semibold text-slate-200">Manage Repositories</h2>
          <div className="flex items-center gap-3">
            <span className="text-xs text-slate-600">&uarr;&darr; navigate &middot; Tab to add</span>
            <button
              onClick={close}
              tabIndex={-1}
              className="text-slate-400 hover:text-slate-200 text-lg leading-none"
            >
              &times;
            </button>
          </div>
        </div>

        <div className="p-4 space-y-4">
          {/* Search indicator */}
          {search && (
            <div className="px-3 py-1.5 bg-slate-700/70 border border-slate-600 rounded flex items-center gap-2">
              <span className="text-xs text-slate-500">Search:</span>
              <span className="text-sm text-slate-200 font-mono">{search}</span>
              <span className="ml-auto text-xs text-slate-600">Esc to clear</span>
            </div>
          )}

          {/* Repo list */}
          <div className="space-y-2 max-h-[300px] overflow-y-auto">
            {state.repos.length === 0 && !search && (
              <p className="text-sm text-slate-500">No repositories added yet.</p>
            )}
            {filteredRepos.length === 0 && search && (
              <p className="text-sm text-slate-500 text-center py-2">No matching repositories.</p>
            )}
            {filteredRepos.map((repo, idx) => (
              <div
                key={repo.id}
                ref={(el) => { repoRefs.current[idx] = el; }}
                onMouseEnter={() => setFocusedIdx(idx)}
                className={`flex items-center justify-between rounded px-3 py-2 cursor-default transition-colors ${
                  idx === focusedIdx
                    ? 'bg-slate-700 border border-blue-500/70 ring-1 ring-blue-500/40'
                    : 'bg-slate-700/50 border border-transparent'
                }`}
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-slate-200 truncate">{repo.name}</p>
                  <p className="text-xs text-slate-400 truncate">{repo.path}</p>
                </div>
                <button
                  onClick={() => handleRemove(repo.id)}
                  tabIndex={-1}
                  title="Remove (Alt+R)"
                  className="ml-3 text-xs text-red-400 hover:text-red-300"
                >
                  <ActionLabel text="Remove" showHint={idx === focusedIdx} />
                </button>
              </div>
            ))}
          </div>

          {/* Add local repo */}
          <div>
            <label className="block text-xs text-slate-400 mb-1">Add Local Repository</label>
            <div className="flex gap-2">
              <input
                ref={inputRef}
                type="text"
                value={localPath}
                onChange={(e) => setLocalPath(e.target.value)}
                onFocus={() => setInputFocused(true)}
                onBlur={() => setInputFocused(false)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.stopPropagation();
                    handleAddLocal();
                  }
                }}
                placeholder="/path/to/repo"
                className="flex-1 px-3 py-1.5 bg-slate-700 border border-slate-600 rounded text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
              />
              <button
                onClick={handleBrowse}
                tabIndex={-1}
                className="px-3 py-1.5 bg-slate-600 hover:bg-slate-500 text-slate-200 text-sm rounded focus:outline-none focus:ring-1 focus:ring-blue-500"
              >
                Browse
              </button>
              <button
                onClick={handleAddLocal}
                disabled={!localPath.trim()}
                tabIndex={-1}
                className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm rounded focus:outline-none focus:ring-2 focus:ring-blue-400"
              >
                Add
              </button>
            </div>
            {error && <p className="mt-1 text-xs text-red-400">{error}</p>}
          </div>
        </div>
      </div>
    </div>
  );
}
