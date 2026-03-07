import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useApp } from '../context/AppContext';
import type { PrInfo, Repo } from '../../shared/types';
import { generateTaskName } from '../../shared/name-generator';
import { shortPath, repoDisplayName } from '../utils/paths';
import { matchesRepoSearch } from '../utils/search';
import ActionLabel from './ActionLabel';
import { parsePrUrl, parseSlackUrl } from '../utils/clipboard-links';
import { altSymbol } from '../utils/platform';
import Spinner from './Spinner';

// Cache branches per repo so subsequent opens are instant
const branchCache = new Map<string, string[]>();

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
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [prBanner, setPrBanner] = useState<{ number: number; title?: string; repoId?: string; headBranch?: string; message?: string } | null>(null);
  const [prInfo, setPrInfo] = useState<PrInfo | null>(null);
  const [slackUrl, setSlackUrl] = useState<string | null>(state.createDialogSlackUrl ?? null);
  const [prompt, setPrompt] = useState(
    state.createDialogSlackUrl
      ? `Read the following Slack message and its thread to understand what is being requested, then create a plan and implement it: ${state.createDialogSlackUrl}`
      : '',
  );
  const [inPlace, setInPlace] = useState(false);
  const [currentBranch, setCurrentBranch] = useState<string | null>(null);

  const repoRef = useRef<HTMLInputElement>(null);
  const repoListRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const branchRef = useRef<HTMLInputElement>(null);
  const branchListRef = useRef<HTMLDivElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
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
    return matchesRepoSearch(r, repoSearch);
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
  }, [repoSearch]);

  useEffect(() => {
    setBranchFocusedIdx(0);
  }, [branchSearch]);

  // Scroll focused dropdown items into view
  useEffect(() => {
    repoListRef.current?.children[repoFocusedIdx]?.scrollIntoView({ block: 'nearest' });
  }, [repoFocusedIdx]);

  useEffect(() => {
    branchListRef.current?.children[branchFocusedIdx]?.scrollIntoView({ block: 'nearest' });
  }, [branchFocusedIdx]);

  // Focus the repo input on open and select text
  useEffect(() => {
    if (state.repos.length > 0) {
      repoRef.current?.focus();
      repoRef.current?.select();
    } else {
      overlayRef.current?.focus();
    }
  }, [state.repos.length]);

  // Detect PR or Slack URL on clipboard when dialog opens (skip if slackUrl was passed via action)
  useEffect(() => {
    if (slackUrl) return;
    (async () => {
      try {
        const text = await window.bifrost.readClipboard();

        // Check for Slack URL first (simpler — no API calls needed)
        const slack = parseSlackUrl(text);
        if (slack) {
          setSlackUrl(slack);
          setPrompt(`Read the following Slack message and its thread to understand what is being requested, then create a plan and implement it: ${slack}`);
          return;
        }

        const parsed = parsePrUrl(text);
        if (!parsed) return;

        // Find matching repo
        let matchedRepo = state.repos.find(
          (r) => r.githubPath?.toLowerCase() === `${parsed.owner}/${parsed.repo}`.toLowerCase(),
        );

        if (!matchedRepo) {
          // Fallback: check if any repo has a remote matching this GitHub path
          const matchedId = await window.bifrost.matchRepoForPr(parsed.owner, parsed.repo);
          if (matchedId) matchedRepo = state.repos.find((r) => r.id === matchedId);
        }

        if (!matchedRepo) {
          setPrBanner({ number: parsed.number, message: `PR #${parsed.number} detected but ${parsed.owner}/${parsed.repo} is not managed in Bifrost` });
          return;
        }

        // Fetch PR metadata (pass ghRepo so gh queries the right repo even if origin is a fork)
        const ghRepo = `${parsed.owner}/${parsed.repo}`;
        const info = await window.bifrost.fetchPrInfo(matchedRepo.id, parsed.number, ghRepo);
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

  /** Pick the best default branch from a list, preferring upstream for forks. */
  const pickDefaultBranch = useCallback((branchList: string[], forRepo: Repo | undefined): string | undefined => {
    if (!forRepo) return branchList[0];
    const upstreamBranch = `upstream/${forRepo.defaultBranch}`;
    if (branchList.includes(upstreamBranch)) return upstreamBranch;
    const originBranch = `origin/${forRepo.defaultBranch}`;
    if (branchList.includes(originBranch)) return originBranch;
    if (branchList.includes(forRepo.defaultBranch)) return forRepo.defaultBranch;
    return branchList[0];
  }, []);

  // Fetch branches when repo changes (with cancellation for stale requests)
  useEffect(() => {
    if (!repoId) {
      setBranches([]);
      setBranch('');
      setBranchSearch('');
      return;
    }
    let cancelled = false;
    setTaskName(generateTaskName());
    setBranch('');
    setBranchSearch('');

    // Use cached branches immediately if available
    const cached = branchCache.get(repoId);
    if (cached) {
      setBranches(cached);
      setBranchesLoading(false);
    } else {
      setBranches([]);
      setBranchesLoading(true);
    }

    // Refresh in background
    window.bifrost.getRepoBranches(repoId).then((b) => {
      if (!cancelled) {
        branchCache.set(repoId, b);
        setBranches(b);
      }
    }).finally(() => {
      if (!cancelled) setBranchesLoading(false);
    });
    return () => { cancelled = true; };
  }, [repoId]);

  // Select branch when branches load or PR is detected
  useEffect(() => {
    if (branches.length === 0) return;
    if (prBanner?.headBranch && prBanner.repoId === repoId) {
      if (!branches.includes(prBanner.headBranch)) {
        setBranches((prev) => [prBanner.headBranch!, ...prev]);
      }
      setBranch(prBanner.headBranch);
      setBranchSearch(prBanner.headBranch);
    } else {
      const repo = state.repos.find((r) => r.id === repoId);
      const defaultBranch = pickDefaultBranch(branches, repo);
      if (defaultBranch) {
        setBranch(defaultBranch);
        setBranchSearch(defaultBranch);
      }
    }
  }, [branches, prBanner]);

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
        ...(prompt.trim() && { prompt: prompt.trim() }),
      });
      localStorage.setItem('bifrost:lastRepoId', repoId);
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
        case 'KeyP':
          e.preventDefault();
          promptRef.current?.focus();
          break;
      }
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
        className="bg-surface rounded-lg border border-border-input w-[550px] shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-border-default">
          <h2 className="text-sm font-semibold text-primary">Create Task</h2>
          <div className="flex items-center gap-3">
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
          {/* PR detection banner */}
          {prBanner && (
            <div className="flex items-center justify-between bg-accent/10 border border-accent-muted rounded px-3 py-2">
              <p className="text-xs text-accent-hover">
                {prBanner.message
                  ? prBanner.message
                  : `PR #${prBanner.number}${prBanner.title ? `: ${prBanner.title}` : ''}`}
              </p>
              <button
                onClick={() => {
                  setPrBanner(null);
                  setPrInfo(null);
                }}
                className="text-xs text-accent-hover hover:brightness-125 ml-3 whitespace-nowrap"
              >
                Ignore
              </button>
            </div>
          )}

          {/* Slack link banner */}
          {slackUrl && (
            <div className="flex items-center justify-between bg-accent/10 border border-accent-muted rounded px-3 py-2">
              <p className="text-xs text-accent-hover truncate">
                Slack message detected
              </p>
              <button
                onClick={() => setSlackUrl(null)}
                className="text-xs text-accent-hover hover:brightness-125 ml-3 whitespace-nowrap"
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
                <ActionLabel text="Open" showHint={true} />
              </button>
            </div>
          )}

          {/* No repos message */}
          {state.repos.length === 0 && (
            <div className="text-center py-2">
              <p className="text-sm text-secondary mb-2">No repositories added yet.</p>
              <button
                autoFocus
                onClick={() => {
                  close();
                  dispatch({ type: 'TOGGLE_REPO_MANAGER' });
                }}
                className="px-3 py-1.5 bg-accent hover:bg-accent-hover text-white text-sm rounded focus:outline-none focus:ring-2 focus:ring-accent"
              >
                Add a Repository
              </button>
            </div>
          )}

          {/* Repo select */}
          {state.repos.length > 0 && (
          <div className="relative">
            <label className="block text-xs text-secondary mb-1">Repository</label>
            <input
              ref={repoRef}
              type="text"
              value={repoSearch}
              onChange={(e) => {
                setRepoSearch(e.target.value);
                setRepoDropdownOpen(true);
                // Clear selection if search no longer matches
                const match = state.repos.find((r) => r.id === repoId);
                if (match && !matchesRepoSearch(match, e.target.value)) {
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
                      setRepoFocusedIdx((i) => i < filteredRepos.length - 1 ? i + 1 : 0);
                    }
                    break;
                  case 'ArrowUp':
                    e.preventDefault();
                    if (!repoDropdownOpen) {
                      setRepoDropdownOpen(true);
                    } else {
                      setRepoFocusedIdx((i) => i > 0 ? i - 1 : filteredRepos.length - 1);
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
              className="w-full px-3 py-1.5 bg-surface-alt border border-border-input rounded text-sm text-primary placeholder-muted focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent"
            />
            {repoDropdownOpen && filteredRepos.length > 0 && (
              <div
                ref={repoListRef}
                className="absolute z-10 mt-1 w-full bg-surface-alt border border-border-input rounded shadow-lg max-h-[200px] overflow-y-auto"
              >
                {filteredRepos.map((repo, idx) => (
                  <div
                    key={repo.id}
                    onMouseDown={() => selectRepo(repo.id)}
                    onMouseEnter={() => setRepoFocusedIdx(idx)}
                    className={`px-3 py-1.5 cursor-pointer ${
                      idx === repoFocusedIdx
                        ? 'bg-accent text-white'
                        : 'text-primary hover:bg-surface-hover'
                    }`}
                  >
                    <div className="text-sm">{repoDisplayName(repo)}</div>
                    <div className={`text-xs ${idx === repoFocusedIdx ? 'text-white/70' : 'text-secondary'}`}>
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
            <label className="block text-xs text-secondary mb-1">Task <ActionLabel text="Name" showHint={true} /></label>
            <div className="flex gap-2">
              <input
                ref={nameRef}
                type="text"
                value={taskName}
                onChange={(e) => setTaskName(e.target.value)}
                placeholder="select a repo to generate..."
                className="flex-1 px-3 py-1.5 bg-surface-alt border border-border-input rounded text-sm text-primary placeholder-muted focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent"
              />
              <button
                onClick={regenerateName}
                title={`Generate new name (${altSymbol}N)`}
                tabIndex={-1}
                className="px-2 py-1.5 bg-surface-alt border border-border-input rounded text-secondary hover:text-primary hover:border-border-input text-sm"
              >
                &#x21bb;
              </button>
            </div>
          </div>

          {/* In-place checkbox */}
          <label
            className="flex items-center gap-2 cursor-pointer"
            title="Run the task directly in the repository's main worktree instead of creating a separate git worktree. Useful for tasks that don't need branch isolation."
          >
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
              className="rounded border-border-input bg-surface-alt text-accent focus:ring-accent focus:ring-offset-0"
            />
            <span className="text-xs text-secondary">Use main worktree (no separate checkout)</span>
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
                <ActionLabel text="Open" showHint={true} />
              </button>
            </div>
          )}

          {/* Branch select */}
          <div className="relative">
            <label className="block text-xs text-secondary mb-1">Branch</label>
            {inPlace ? (
              <div className="w-full px-3 py-1.5 bg-surface-alt/50 border border-border-input rounded text-sm text-secondary">
                {currentBranch ?? 'Detecting...'}
              </div>
            ) : (
            <>
            <div className="relative">
            <input
              ref={branchRef}
              type="text"
              value={branchesLoading ? '' : branchSearch}
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
              placeholder={branchesLoading ? '' : branches.length === 0 ? 'Select a repo first' : 'Type to search...'}
              disabled={branchesLoading || branches.length === 0}
              className="w-full px-3 py-1.5 bg-surface-alt border border-border-input rounded text-sm text-primary placeholder-muted focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent disabled:opacity-50"
            />
            {branchesLoading && (
              <div className="absolute inset-0 flex items-center px-3 pointer-events-none">
                <Spinner size="sm" className="mr-2" />
                <span className="text-sm text-secondary">Fetching branches...</span>
              </div>
            )}
            </div>
            {branchDropdownOpen && filteredBranches.length > 0 && (
              <div
                ref={branchListRef}
                className="absolute z-10 mt-1 w-full bg-surface-alt border border-border-input rounded shadow-lg max-h-[200px] overflow-y-auto"
              >
                {filteredBranches.map((b, idx) => (
                  <div
                    key={b}
                    onMouseDown={() => selectBranch(b)}
                    onMouseEnter={() => setBranchFocusedIdx(idx)}
                    className={`px-3 py-1.5 cursor-pointer text-sm ${
                      idx === branchFocusedIdx
                        ? 'bg-accent text-white'
                        : 'text-primary hover:bg-surface-hover'
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

          {/* Prompt */}
          <div>
            <label className="block text-xs text-secondary mb-1"><ActionLabel text="Prompt" showHint={true} /></label>
            <textarea
              ref={promptRef}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                // Allow Enter in textarea without triggering form submit
                if (e.key === 'Enter') e.stopPropagation();
              }}
              placeholder="Initial prompt sent to Claude (optional)"
              rows={3}
              className="w-full px-3 py-1.5 bg-surface-alt border border-border-input rounded text-sm text-primary placeholder-muted focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent resize-y"
            />
          </div>

          {error && <p className="text-xs text-danger">{error}</p>}

          <div className="flex items-center gap-2">
            <span className="text-xs text-faint flex-1">
              Enter create &middot; {altSymbol}N name &middot; {altSymbol}P prompt &middot; Esc cancel
            </span>
            <button
              onClick={close}
              className="px-3 py-1.5 text-sm text-secondary hover:text-primary rounded focus:outline-none focus:ring-1 focus:ring-border-input"
            >
              Cancel
            </button>
            <button
              ref={createRef}
              onClick={handleSubmit}
              disabled={loading || !repoId || !taskName.trim() || (!inPlace && !branch)}
              className="px-4 py-1.5 bg-accent hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm rounded focus:outline-none focus:ring-2 focus:ring-accent"
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
