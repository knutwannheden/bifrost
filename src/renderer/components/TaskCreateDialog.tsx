import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useApp } from '../context/AppContext';
import type { PrInfo, Repo } from '../../shared/types';
import { generateTaskName } from '../utils/name-generator';
import { shortPath } from '../utils/paths';
import ActionLabel from './ActionLabel';

interface ParsedPrUrl {
  owner: string;
  repo: string;
  number: number;
}

function parsePrUrl(text: string): ParsedPrUrl | null {
  const match = text.trim().match(
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?(?:[?#].*)?$/,
  );
  if (!match) return null;
  return { owner: match[1], repo: match[2], number: parseInt(match[3], 10) };
}

function repoDisplayName(repo: Repo): string {
  return repo.githubPath ?? repo.name;
}

function matchesSearch(repo: Repo, search: string): boolean {
  if (!search) return true;
  const haystack = `${repoDisplayName(repo)} ${repo.path}`.toLowerCase();
  return search.toLowerCase().split(/\s+/).filter(Boolean).every((term) => haystack.includes(term));
}

export default function TaskCreateDialog() {
  const { state, dispatch } = useApp();
  const initialRepo = (() => {
    if (state.createDialogRepoId) return state.repos.find((r) => r.id === state.createDialogRepoId);
    const lastRepoId = localStorage.getItem('bifrost:lastRepoId');
    if (lastRepoId) {
      const found = state.repos.find((r) => r.id === lastRepoId);
      if (found) return found;
    }
    return state.repos[0];
  })();
  const [repoId, setRepoId] = useState(initialRepo?.id ?? '');
  const [repoSearch, setRepoSearch] = useState(initialRepo ? repoDisplayName(initialRepo) : '');
  const [repoDropdownOpen, setRepoDropdownOpen] = useState(false);
  const [repoFocusedIdx, setRepoFocusedIdx] = useState(0);
  const [taskName, setTaskName] = useState('');
  const [branch, setBranch] = useState('');
  const [branchSearch, setBranchSearch] = useState('');
  const [branchDropdownOpen, setBranchDropdownOpen] = useState(false);
  const [branchFocusedIdx, setBranchFocusedIdx] = useState(0);
  const [branches, setBranches] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [prBanner, setPrBanner] = useState<{ number: number; title?: string; repoId?: string; headBranch?: string; message?: string } | null>(null);
  const [prInfo, setPrInfo] = useState<PrInfo | null>(null);
  const [inPlace, setInPlace] = useState(false);
  const [currentBranch, setCurrentBranch] = useState<string | null>(null);

  const repoRef = useRef<HTMLInputElement>(null);
  const repoListRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const branchRef = useRef<HTMLInputElement>(null);
  const branchListRef = useRef<HTMLDivElement>(null);
  const createRef = useRef<HTMLButtonElement>(null);

  const close = useCallback(() => {
    dispatch({ type: 'SHOW_CREATE_TASK_DIALOG', show: false });
  }, [dispatch]);

  const overlayRef = useRef<HTMLDivElement>(null);

  // Treat filter as empty when the entire input is selected (user hasn't typed yet)
  const inputFullySelected =
    repoRef.current &&
    repoRef.current.selectionStart === 0 &&
    repoRef.current.selectionEnd === repoRef.current.value.length &&
    repoRef.current.value.length > 0;

  const filteredRepos = state.repos.filter((r) => {
    if (!repoSearch || inputFullySelected) return true;
    return matchesSearch(r, repoSearch);
  });

  const branchInputFullySelected =
    branchRef.current &&
    branchRef.current.selectionStart === 0 &&
    branchRef.current.selectionEnd === branchRef.current.value.length &&
    branchRef.current.value.length > 0;

  const filteredBranches = branches.filter((b) => {
    if (!branchSearch || branchInputFullySelected) return true;
    return b.toLowerCase().includes(branchSearch.toLowerCase());
  });

  const existingTask = repoId && branch && !inPlace
    ? state.tasks.find((t) => t.repoId === repoId && t.branch === branch && t.status !== 'archived')
    : undefined;

  const repo = state.repos.find((r) => r.id === repoId);
  const existingInPlaceTask = inPlace && repo
    ? state.tasks.find((t) => t.status !== 'archived' && t.worktreePath === repo.path)
    : undefined;

  // Keep focused index in bounds and auto-select first match
  useEffect(() => {
    setRepoFocusedIdx(0);
    if (filteredRepos.length > 0 && repoDropdownOpen) {
      setRepoId(filteredRepos[0].id);
    }
  }, [repoSearch]);

  useEffect(() => {
    setBranchFocusedIdx(0);
    if (filteredBranches.length > 0 && branchDropdownOpen) {
      setBranch(filteredBranches[0]);
    }
  }, [branchSearch]);

  // Focus the repo input on open and select text
  useEffect(() => {
    if (state.repos.length > 0) {
      repoRef.current?.focus();
      repoRef.current?.select();
    } else {
      overlayRef.current?.focus();
    }
  }, [state.repos.length]);

  // Detect PR URL on clipboard when dialog opens
  useEffect(() => {
    (async () => {
      try {
        const text = await window.bifrost.readClipboard();
        const parsed = parsePrUrl(text);
        if (!parsed) return;

        // Find matching repo
        const matchedRepo = state.repos.find(
          (r) => r.githubPath?.toLowerCase() === `${parsed.owner}/${parsed.repo}`.toLowerCase(),
        );

        if (!matchedRepo) {
          setPrBanner({ number: parsed.number, message: `PR #${parsed.number} detected but ${parsed.owner}/${parsed.repo} is not managed in Bifrost` });
          return;
        }

        // Fetch PR metadata
        const info = await window.bifrost.fetchPrInfo(matchedRepo.id, parsed.number);
        setPrInfo(info);

        // Auto-fill: select repo and set branch
        setRepoId(matchedRepo.id);
        setRepoSearch(repoDisplayName(matchedRepo));
        setPrBanner({
          number: info.number,
          title: info.title,
          repoId: matchedRepo.id,
          headBranch: info.headBranch,
        });
      } catch {
        // Clipboard read failed or PR fetch failed — silently ignore
      }
    })();
  }, []);

  // Fetch current branch when in-place mode is enabled
  useEffect(() => {
    if (inPlace && repoId) {
      window.bifrost.getCurrentBranch(repoId).then(setCurrentBranch).catch(() => setCurrentBranch(null));
    } else {
      setCurrentBranch(null);
    }
  }, [inPlace, repoId]);

  useEffect(() => {
    if (!repoId) {
      setBranches([]);
      setBranch('');
      setBranchSearch('');
      return;
    }
    setTaskName(generateTaskName());
    window.bifrost.getRepoBranches(repoId).then((b) => {
      setBranches(b);
      // Restore last-used branch if it exists for this repo
      const lastRepoId = localStorage.getItem('bifrost:lastRepoId');
      const lastBranch = localStorage.getItem('bifrost:lastBranch');
      if (lastRepoId === repoId && lastBranch && b.includes(lastBranch)) {
        setBranch(lastBranch);
        setBranchSearch(lastBranch);
      } else {
        const repo = state.repos.find((r) => r.id === repoId);
        if (repo && b.includes(repo.defaultBranch)) {
          setBranch(repo.defaultBranch);
          setBranchSearch(repo.defaultBranch);
        } else if (b.length > 0) {
          setBranch(b[0]);
          setBranchSearch(b[0]);
        }
      }
      // If PR detected, select the PR branch (add to list if not present)
      if (prBanner?.headBranch && prBanner?.repoId === repoId) {
        if (!b.includes(prBanner.headBranch)) {
          setBranches([prBanner.headBranch, ...b]);
        }
        setBranch(prBanner.headBranch);
        setBranchSearch(prBanner.headBranch);
      }
    });
  }, [repoId, state.repos]);

  const selectRepo = (id: string) => {
    const repo = state.repos.find((r) => r.id === id);
    if (repo) {
      setRepoId(id);
      setRepoSearch(repoDisplayName(repo));
      setRepoDropdownOpen(false);
      nameRef.current?.focus();
    }
  };

  const selectBranch = (b: string) => {
    setBranch(b);
    setBranchSearch(b);
    setBranchDropdownOpen(false);
    createRef.current?.focus();
  };

  const regenerateName = () => {
    setTaskName(generateTaskName());
    nameRef.current?.focus();
  };

  const openExistingTask = async (taskId: string, status: string) => {
    if (status === 'running') {
      dispatch({ type: 'SET_ACTIVE_TASK', taskId });
    } else {
      const updated = await window.bifrost.reopenTask(taskId);
      dispatch({ type: 'UPDATE_TASK', task: updated });
      dispatch({ type: 'SET_ACTIVE_TASK', taskId: updated.id });
    }
    close();
  };

  const handleSubmit = async () => {
    if (!repoId || !taskName.trim() || (!inPlace && !branch)) return;
    setLoading(true);
    setError(null);
    try {
      const task = await window.bifrost.createTask({
        repoId,
        name: taskName.trim(),
        branch: inPlace ? '' : branch,
        ...(prInfo && !inPlace && { prInfo }),
        ...(inPlace && { inPlace: true }),
      });
      localStorage.setItem('bifrost:lastRepoId', repoId);
      if (!inPlace && branch) localStorage.setItem('bifrost:lastBranch', branch);
      dispatch({ type: 'ADD_TASK', task });
      dispatch({ type: 'SET_ACTIVE_TASK', taskId: task.id });
      close();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to create task');
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }

    if (e.key === 'Enter' && !e.defaultPrevented) {
      e.preventDefault();
      e.stopPropagation();
      handleSubmit();
      return;
    }

    // Alt+letter shortcuts
    if (e.altKey) {
      switch (e.code) {
        case 'KeyC':
          e.preventDefault();
          handleSubmit();
          break;
        case 'KeyN':
          e.preventDefault();
          regenerateName();
          break;
        case 'KeyO': {
          const openTask = existingTask ?? existingInPlaceTask;
          if (openTask) {
            e.preventDefault();
            openExistingTask(openTask.id, openTask.status);
          }
          break;
        }
      }
    }
  };

  return (
    <div
      ref={overlayRef}
      tabIndex={-1}
      className="absolute inset-0 z-20 flex items-center justify-center bg-black/30 focus:outline-none"
      onClick={close}
      onKeyDown={handleKeyDown}
    >
      <div
        className="bg-slate-800 rounded-lg border border-slate-600 w-[550px] shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700">
          <h2 className="text-sm font-semibold text-slate-200">Create Task</h2>
          <div className="flex items-center gap-3">
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
          {/* PR detection banner */}
          {prBanner && (
            <div className="flex items-center justify-between bg-blue-900/40 border border-blue-700/50 rounded px-3 py-2">
              <p className="text-xs text-blue-300">
                {prBanner.message
                  ? prBanner.message
                  : `PR #${prBanner.number}${prBanner.title ? `: ${prBanner.title}` : ''}`}
              </p>
              <button
                onClick={() => {
                  setPrBanner(null);
                  setPrInfo(null);
                  // Reset to default branch
                  const repo = state.repos.find((r) => r.id === repoId);
                  if (repo && branches.includes(repo.defaultBranch)) {
                    setBranch(repo.defaultBranch);
                    setBranchSearch(repo.defaultBranch);
                  }
                }}
                className="text-xs text-blue-400 hover:text-blue-200 ml-3 whitespace-nowrap"
              >
                Ignore
              </button>
            </div>
          )}

          {/* Existing task banner */}
          {existingTask && (
            <div className="flex items-center justify-between bg-amber-900/40 border border-amber-700/50 rounded px-3 py-2">
              <p className="text-xs text-amber-300">
                Task &ldquo;{existingTask.name}&rdquo; already uses this branch
              </p>
              <button
                onClick={() => openExistingTask(existingTask.id, existingTask.status)}
                className="text-xs text-amber-400 hover:text-amber-200 ml-3 whitespace-nowrap"
              >
                <span className="underline underline-offset-2">O</span>pen
              </button>
            </div>
          )}

          {/* No repos message */}
          {state.repos.length === 0 && (
            <div className="text-center py-2">
              <p className="text-sm text-slate-400 mb-2">No repositories added yet.</p>
              <button
                autoFocus
                onClick={() => {
                  close();
                  dispatch({ type: 'TOGGLE_REPO_MANAGER' });
                }}
                className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-sm rounded focus:outline-none focus:ring-2 focus:ring-blue-400"
              >
                Add a Repository
              </button>
            </div>
          )}

          {/* Repo select */}
          {state.repos.length > 0 && (
          <div className="relative">
            <label className="block text-xs text-slate-400 mb-1">Repository</label>
            <input
              ref={repoRef}
              type="text"
              value={repoSearch}
              onChange={(e) => {
                setRepoSearch(e.target.value);
                setRepoDropdownOpen(true);
                // Clear selection if search no longer matches
                const match = state.repos.find((r) => r.id === repoId);
                if (match && !matchesSearch(match, e.target.value)) {
                  setRepoId('');
                }
              }}
              onFocus={() => {
                // Select all text on focus so typing replaces it
                repoRef.current?.select();
              }}
              onBlur={() => {
                // Delay to allow click on dropdown items
                setTimeout(() => setRepoDropdownOpen(false), 150);
              }}
              onKeyDown={(e) => {
                if (filteredRepos.length === 0) return;
                switch (e.key) {
                  case 'ArrowDown':
                    e.preventDefault();
                    if (!repoDropdownOpen) {
                      setRepoDropdownOpen(true);
                    } else {
                      setRepoFocusedIdx((i) => {
                        const next = i < filteredRepos.length - 1 ? i + 1 : 0;
                        setRepoId(filteredRepos[next].id);
                        return next;
                      });
                    }
                    break;
                  case 'ArrowUp':
                    e.preventDefault();
                    if (!repoDropdownOpen) {
                      setRepoDropdownOpen(true);
                    } else {
                      setRepoFocusedIdx((i) => {
                        const next = i > 0 ? i - 1 : filteredRepos.length - 1;
                        setRepoId(filteredRepos[next].id);
                        return next;
                      });
                    }
                    break;
                  case 'Enter':
                    if (repoDropdownOpen) {
                      e.preventDefault();
                      e.stopPropagation();
                      if (filteredRepos[repoFocusedIdx]) {
                        selectRepo(filteredRepos[repoFocusedIdx].id);
                      }
                    }
                    break;
                  case 'Tab':
                    if (repoDropdownOpen && filteredRepos[repoFocusedIdx]) {
                      selectRepo(filteredRepos[repoFocusedIdx].id);
                    }
                    break;
                }
              }}
              placeholder="Type to search..."
              className="w-full px-3 py-1.5 bg-slate-700 border border-slate-600 rounded text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
            />
            {repoDropdownOpen && filteredRepos.length > 0 && (
              <div
                ref={repoListRef}
                className="absolute z-10 mt-1 w-full bg-slate-700 border border-slate-600 rounded shadow-lg max-h-[200px] overflow-y-auto"
              >
                {filteredRepos.map((repo, idx) => (
                  <div
                    key={repo.id}
                    onMouseDown={() => selectRepo(repo.id)}
                    onMouseEnter={() => setRepoFocusedIdx(idx)}
                    className={`px-3 py-1.5 cursor-pointer ${
                      idx === repoFocusedIdx
                        ? 'bg-blue-600 text-white'
                        : 'text-slate-200 hover:bg-slate-600'
                    }`}
                  >
                    <div className="text-sm">{repoDisplayName(repo)}</div>
                    <div className={`text-xs ${idx === repoFocusedIdx ? 'text-blue-200' : 'text-slate-400'}`}>
                      {shortPath(repo.path)}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
          )}

          {state.repos.length > 0 && (
          <>
          {/* Task name */}
          <div>
            <label className="block text-xs text-slate-400 mb-1">Task <span className="underline underline-offset-2">N</span>ame</label>
            <div className="flex gap-2">
              <input
                ref={nameRef}
                type="text"
                value={taskName}
                onChange={(e) => setTaskName(e.target.value)}
                placeholder="select a repo to generate..."
                className="flex-1 px-3 py-1.5 bg-slate-700 border border-slate-600 rounded text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
              />
              <button
                onClick={regenerateName}
                title="Generate new name (Alt+N)"
                tabIndex={-1}
                className="px-2 py-1.5 bg-slate-700 border border-slate-600 rounded text-slate-400 hover:text-slate-200 hover:border-slate-500 text-sm"
              >
                &#x21bb;
              </button>
            </div>
          </div>

          {/* In-place checkbox */}
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={inPlace}
              onChange={(e) => {
                setInPlace(e.target.checked);
                if (e.target.checked) {
                  setPrBanner(null);
                  setPrInfo(null);
                }
              }}
              className="rounded border-slate-500 bg-slate-700 text-blue-500 focus:ring-blue-500 focus:ring-offset-0"
            />
            <span className="text-xs text-slate-400">Use main worktree (no separate checkout)</span>
          </label>

          {/* In-place conflict banner */}
          {existingInPlaceTask && (
            <div className="flex items-center justify-between bg-amber-900/40 border border-amber-700/50 rounded px-3 py-2">
              <p className="text-xs text-amber-300">
                Task &ldquo;{existingInPlaceTask.name}&rdquo; already uses the main worktree
              </p>
              <button
                onClick={() => openExistingTask(existingInPlaceTask.id, existingInPlaceTask.status)}
                className="text-xs text-amber-400 hover:text-amber-200 ml-3 whitespace-nowrap"
              >
                <span className="underline underline-offset-2">O</span>pen
              </button>
            </div>
          )}

          {/* Branch select */}
          <div className="relative">
            <label className="block text-xs text-slate-400 mb-1">Branch</label>
            {inPlace ? (
              <div className="w-full px-3 py-1.5 bg-slate-700/50 border border-slate-600 rounded text-sm text-slate-400">
                {currentBranch ?? 'Detecting...'}
              </div>
            ) : (
            <>
            <input
              ref={branchRef}
              type="text"
              value={branchSearch}
              onChange={(e) => {
                setBranchSearch(e.target.value);
                setBranchDropdownOpen(true);
                if (branch && !branch.toLowerCase().includes(e.target.value.toLowerCase())) {
                  setBranch('');
                }
              }}
              onFocus={() => {
                branchRef.current?.select();
              }}
              onBlur={() => {
                setTimeout(() => setBranchDropdownOpen(false), 150);
              }}
              onKeyDown={(e) => {
                if (filteredBranches.length === 0) return;
                switch (e.key) {
                  case 'ArrowDown':
                    e.preventDefault();
                    if (!branchDropdownOpen) {
                      setBranchDropdownOpen(true);
                    } else {
                      setBranchFocusedIdx((i) => i < filteredBranches.length - 1 ? i + 1 : 0);
                    }
                    break;
                  case 'ArrowUp':
                    e.preventDefault();
                    if (!branchDropdownOpen) {
                      setBranchDropdownOpen(true);
                    } else {
                      setBranchFocusedIdx((i) => i > 0 ? i - 1 : filteredBranches.length - 1);
                    }
                    break;
                  case 'Enter':
                    if (branchDropdownOpen) {
                      e.preventDefault();
                      e.stopPropagation();
                      if (filteredBranches[branchFocusedIdx]) {
                        selectBranch(filteredBranches[branchFocusedIdx]);
                      }
                    }
                    break;
                  case 'Tab':
                    if (branchDropdownOpen && filteredBranches[branchFocusedIdx]) {
                      selectBranch(filteredBranches[branchFocusedIdx]);
                    }
                    break;
                }
              }}
              placeholder={branches.length === 0 ? 'Select a repo first' : 'Type to search...'}
              disabled={branches.length === 0}
              className="w-full px-3 py-1.5 bg-slate-700 border border-slate-600 rounded text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 disabled:opacity-50"
            />
            {branchDropdownOpen && filteredBranches.length > 0 && (
              <div
                ref={branchListRef}
                className="absolute z-10 mt-1 w-full bg-slate-700 border border-slate-600 rounded shadow-lg max-h-[200px] overflow-y-auto"
              >
                {filteredBranches.map((b, idx) => (
                  <div
                    key={b}
                    onMouseDown={() => selectBranch(b)}
                    onMouseEnter={() => setBranchFocusedIdx(idx)}
                    className={`px-3 py-1.5 cursor-pointer text-sm ${
                      idx === branchFocusedIdx
                        ? 'bg-blue-600 text-white'
                        : 'text-slate-200 hover:bg-slate-600'
                    }`}
                  >
                    {b}
                  </div>
                ))}
              </div>
            )}
            </>
            )}
          </div>

          {error && <p className="text-xs text-red-400">{error}</p>}

          <div className="flex justify-end gap-2">
            <button
              onClick={close}
              className="px-3 py-1.5 text-sm text-slate-400 hover:text-slate-200 rounded focus:outline-none focus:ring-1 focus:ring-slate-500"
            >
              Cancel
            </button>
            <button
              ref={createRef}
              onClick={handleSubmit}
              disabled={loading || !repoId || !taskName.trim() || (!inPlace && !branch)}
              className="px-4 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm rounded focus:outline-none focus:ring-2 focus:ring-blue-400"
            >
              {loading ? 'Creating...' : <ActionLabel text="Create" showHint={!loading} />}
            </button>
          </div>
          </>
          )}
        </div>
      </div>
    </div>
  );
}
