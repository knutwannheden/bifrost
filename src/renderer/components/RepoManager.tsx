import React, { useState, useCallback, useRef, useEffect } from 'react';
import type { RecentRepo } from '../../shared/types';
import { useApp } from '../context/AppContext';
import { useInstantSearch } from '../hooks/useInstantSearch';
import { shortPath, repoDisplayName } from '../utils/paths';
import { matchesAllTerms } from '../utils/search';
import ActionLabel from './ActionLabel';
import Highlight from './Highlight';
import SearchIndicator from './SearchIndicator';
import { altSymbol } from '../utils/platform';

export default function RepoManager() {
  const { state, dispatch } = useApp();
  const [localPath, setLocalPath] = useState('');
  const { search, handleSearchKey } = useInstantSearch();
  const [focusedSection, setFocusedSection] = useState<'suggestions' | 'repos'>('suggestions');
  const [focusedSuggestionIdx, setFocusedSuggestionIdx] = useState(0);
  const [focusedRepoIdx, setFocusedRepoIdx] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [inputFocused, setInputFocused] = useState(false);
  const [recentRepos, setRecentRepos] = useState<RecentRepo[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const repoRefs = useRef<(HTMLDivElement | null)[]>([]);
  const suggestionRefs = useRef<(HTMLDivElement | null)[]>([]);

  const close = useCallback(() => {
    dispatch({ type: 'TOGGLE_REPO_MANAGER' });
  }, [dispatch]);

  useEffect(() => {
    overlayRef.current?.focus();
  }, []);

  const filteredRepos = state.repos.filter((r) => matchesAllTerms(`${repoDisplayName(r)} ${r.path}`, search));

  // Reset focus when search changes
  useEffect(() => {
    setFocusedRepoIdx(0);
  }, [search]);

  // Clamp focus indices
  useEffect(() => {
    if (focusedRepoIdx >= filteredRepos.length && filteredRepos.length > 0) {
      setFocusedRepoIdx(filteredRepos.length - 1);
    }
  }, [filteredRepos.length, focusedRepoIdx]);

  // Scroll focused item into view
  useEffect(() => {
    if (focusedSection === 'suggestions') {
      suggestionRefs.current[focusedSuggestionIdx]?.scrollIntoView({ block: 'nearest' });
    } else {
      repoRefs.current[focusedRepoIdx]?.scrollIntoView({ block: 'nearest' });
    }
  }, [focusedSection, focusedSuggestionIdx, focusedRepoIdx]);

  // Fetch recent repos from Claude history
  useEffect(() => {
    window.bifrost.getRecentRepos().then(setRecentRepos).catch(() => { /* ignore */ });
  }, []);

  // Filter out repos already managed, and apply search filter
  const repoPaths = new Set(state.repos.map((r) => r.path));
  const suggestions = recentRepos.filter((r) => {
    if (repoPaths.has(r.path)) return false;
    return matchesAllTerms(`${r.githubPath ?? r.name} ${r.path}`, search);
  });

  const handleAddSuggestion = async (repoPath: string) => {
    setError(null);
    try {
      const repo = await window.bifrost.addRepo({ type: 'local', path: repoPath });
      dispatch({ type: 'SET_REPOS', repos: [...state.repos, repo] });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to add repo');
    }
  };

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

  // Sync section focus with suggestions availability
  useEffect(() => {
    if (suggestions.length === 0) {
      setFocusedSection('repos');
    } else if (focusedSection === 'repos' && focusedRepoIdx === 0) {
      setFocusedSection('suggestions');
    }
  }, [suggestions.length]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Let the input handle its own keys when focused
    if (inputFocused) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        inputRef.current?.blur();
        overlayRef.current?.focus();
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        inputRef.current?.blur();
        overlayRef.current?.focus();
        if (e.shiftKey) {
          if (filteredRepos.length > 0) {
            setFocusedSection('repos');
          } else if (suggestions.length > 0) {
            setFocusedSection('suggestions');
          }
        } else {
          if (suggestions.length > 0) {
            setFocusedSection('suggestions');
          } else if (filteredRepos.length > 0) {
            setFocusedSection('repos');
          }
        }
      }
      return;
    }

    const focusedRepo = focusedSection === 'repos' ? filteredRepos[focusedRepoIdx] : undefined;

    if (handleSearchKey(e)) return;

    switch (e.key) {
      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        close();
        break;

      case 'ArrowUp':
        e.preventDefault();
        if (focusedSection === 'suggestions') {
          setFocusedSuggestionIdx((i) => (i > 0 ? i - 1 : suggestions.length - 1));
        } else {
          setFocusedRepoIdx((i) => (i > 0 ? i - 1 : filteredRepos.length - 1));
        }
        break;

      case 'ArrowDown':
        e.preventDefault();
        if (focusedSection === 'suggestions') {
          setFocusedSuggestionIdx((i) => (i < suggestions.length - 1 ? i + 1 : 0));
        } else {
          setFocusedRepoIdx((i) => (i < filteredRepos.length - 1 ? i + 1 : 0));
        }
        break;

      case 'Enter':
        e.preventDefault();
        if (focusedSection === 'suggestions' && suggestions[focusedSuggestionIdx]) {
          handleAddSuggestion(suggestions[focusedSuggestionIdx].path);
        }
        break;

      case 'Tab':
        e.preventDefault();
        if (e.shiftKey) {
          // Shift+Tab: repos -> suggestions -> input
          if (focusedSection === 'repos' && suggestions.length > 0) {
            setFocusedSection('suggestions');
          } else {
            inputRef.current?.focus();
          }
        } else {
          // Tab: suggestions -> repos -> input
          if (focusedSection === 'suggestions' && filteredRepos.length > 0) {
            setFocusedSection('repos');
          } else {
            inputRef.current?.focus();
          }
        }
        break;

      default:
        // Alt+letter shortcuts
        if (e.altKey) {
          switch (e.code) {
            case 'KeyR':
              if (focusedRepo) {
                e.preventDefault();
                handleRemove(focusedRepo.id);
              }
              break;
            case 'KeyT':
              if (focusedRepo) {
                e.preventDefault();
                close();
                dispatch({ type: 'SHOW_CREATE_TASK_DIALOG', show: true, repoId: focusedRepo.id });
              }
              break;
            case 'KeyB':
              e.preventDefault();
              handleBrowse();
              break;
            case 'KeyA':
              e.preventDefault();
              handleAddLocal();
              break;
          }
        }
        break;
    }
  };

  return (
    <div
      ref={overlayRef}
      tabIndex={-1}
      className="absolute inset-0 z-20 flex items-center justify-center bg-overlay focus:outline-none"
      onClick={close}
      onKeyDown={handleKeyDown}
    >
      <div
        className="bg-surface rounded-lg border border-border-input w-[500px] max-h-[80vh] overflow-hidden shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-border-default">
          <h2 className="text-sm font-semibold text-primary">Manage Repositories</h2>
          <div className="flex items-center gap-3">
            <span className="text-xs text-faint">&uarr;&darr; navigate &middot; type to search &middot; {altSymbol}B browse &middot; {altSymbol}A add &middot; Esc close</span>
            <button
              onClick={close}
              tabIndex={-1}
              className="text-secondary hover:text-primary text-lg leading-none"
            >
              &times;
            </button>
          </div>
        </div>

        <div className="p-4 space-y-4">
          <SearchIndicator search={search} />

          {/* Recent from Claude */}
          {suggestions.length > 0 && (
            <div>
              <label className="block text-xs text-secondary mb-1">Recent from Claude</label>
              <div className="space-y-1">
                {suggestions.map((repo, idx) => {
                  const isFocused = focusedSection === 'suggestions' && idx === focusedSuggestionIdx;
                  return (
                    <div
                      key={repo.path}
                      ref={(el) => { suggestionRefs.current[idx] = el; }}
                      onMouseEnter={() => { setFocusedSection('suggestions'); setFocusedSuggestionIdx(idx); }}
                      className={`flex items-center justify-between rounded px-3 py-1.5 cursor-default transition-colors ${
                        isFocused
                          ? 'bg-surface-alt border border-accent-muted ring-1 ring-accent-muted'
                          : 'bg-surface-alt/30 border border-border-default'
                      }`}
                    >
                      <div className="min-w-0 flex-1">
                        <p className="text-sm text-secondary"><Highlight text={repo.githubPath ?? repo.name} search={search} /></p>
                        <p className="text-xs text-muted truncate"><Highlight text={shortPath(repo.path)} search={search} /></p>
                      </div>
                      <button
                        onClick={() => handleAddSuggestion(repo.path)}
                        tabIndex={-1}
                        className="ml-3 px-2 py-0.5 text-xs text-accent-hover hover:brightness-125 hover:bg-surface-hover rounded"
                      >
                        <ActionLabel text="+ Add" showHint={isFocused} />
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Repo list */}
          <div className="space-y-2 max-h-[300px] overflow-y-auto">
            {state.repos.length === 0 && !search && (
              <p className="text-sm text-muted text-center py-4">No repositories added yet.</p>
            )}
            {filteredRepos.length === 0 && search && (
              <p className="text-sm text-muted text-center py-4">No matching repositories.</p>
            )}
            {filteredRepos.map((repo, idx) => {
              const isFocused = focusedSection === 'repos' && idx === focusedRepoIdx;
              return (
                <div
                  key={repo.id}
                  ref={(el) => { repoRefs.current[idx] = el; }}
                  onMouseEnter={() => { setFocusedSection('repos'); setFocusedRepoIdx(idx); }}
                  className={`flex items-center justify-between rounded px-3 py-2 cursor-default transition-colors ${
                    isFocused
                      ? 'bg-surface-alt border border-accent-muted ring-1 ring-accent-muted'
                      : 'bg-surface-alt/50 border border-transparent'
                  }`}
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-primary truncate"><Highlight text={repoDisplayName(repo)} search={search} /></p>
                    <p className="text-xs text-secondary truncate"><Highlight text={shortPath(repo.path)} search={search} /></p>
                  </div>
                  <div className="flex items-center gap-1 ml-3">
                    <button
                      onClick={() => { close(); dispatch({ type: 'SHOW_CREATE_TASK_DIALOG', show: true, repoId: repo.id }); }}
                      tabIndex={-1}
                      title={`Create task (${altSymbol}T)`}
                      className="px-1.5 py-0.5 text-xs text-accent-hover hover:brightness-125 hover:bg-surface-hover rounded"
                    >
                      <ActionLabel text="Task" showHint={isFocused} />
                    </button>
                    <button
                      onClick={() => handleRemove(repo.id)}
                      tabIndex={-1}
                      title={`Remove (${altSymbol}R)`}
                      className="px-1.5 py-0.5 text-xs text-danger hover:brightness-125 hover:bg-surface-hover rounded"
                    >
                      <ActionLabel text="Remove" showHint={isFocused} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Add local repo */}
          <div>
            <label className="block text-xs text-secondary mb-1">Add Local Repository</label>
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
                className="flex-1 px-3 py-1.5 bg-surface-alt border border-border-input rounded text-sm text-primary placeholder-muted focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent"
              />
              <button
                onClick={handleBrowse}
                tabIndex={-1}
                className="px-3 py-1.5 bg-surface-hover hover:brightness-110 text-primary text-sm rounded focus:outline-none focus:ring-1 focus:ring-accent"
              >
                <ActionLabel text="Browse" showHint={true} />
              </button>
              <button
                onClick={handleAddLocal}
                disabled={!localPath.trim()}
                tabIndex={-1}
                className="px-3 py-1.5 bg-accent hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm rounded focus:outline-none focus:ring-2 focus:ring-accent"
              >
                <ActionLabel text="Add" showHint={!!localPath.trim()} />
              </button>
            </div>
            {error && <p className="mt-1 text-xs text-danger">{error}</p>}
          </div>
        </div>
      </div>
    </div>
  );
}
