import React, { useCallback, useEffect, useRef, useState } from 'react';
import { generateTaskName } from '../../shared/name-generator';
import type { PrInfo, Repo } from '../../shared/types';
import { useApp } from '../context/AppContext';
import { useOverlayFocus } from '../hooks/useOverlayFocus';
import { parsePrUrl, parseSlackUrl } from '../utils/clipboard-links';
import { altSymbol } from '../utils/platform';
import ActionLabel from './ActionLabel';
import FormInput from './FormInput';
import FormTextarea from './FormTextarea';
import OverlayFooter from './OverlayFooter';
import OverlayHeader from './OverlayHeader';
import PillToggle from './PillToggle';
import PrimaryButton from './PrimaryButton';
import RepoDropdown from './RepoDropdown';
import Spinner from './Spinner';

// Cache branches per repo so subsequent opens are instant
const branchCache = new Map<string, string[]>();

type TaskMode = 'single' | 'multi';

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
  const [taskName, setTaskName] = useState('');
  const [branch, setBranch] = useState('');
  const [branchSearch, setBranchSearch] = useState('');
  const [branchDropdownOpen, setBranchDropdownOpen] = useState(false);
  const [branchFocusedIdx, setBranchFocusedIdx] = useState(0);
  const [branches, setBranches] = useState<string[]>([]);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [prBanner, setPrBanner] = useState<{
    number: number;
    title?: string;
    repoId?: string;
    headBranch?: string;
    message?: string;
  } | null>(null);
  const [prInfo, setPrInfo] = useState<PrInfo | null>(null);
  const [slackUrl, setSlackUrl] = useState<string | null>(state.createDialogSlackUrl ?? null);
  const [prompt, setPrompt] = useState(
    state.createDialogSlackUrl
      ? `Read the following Slack message and its thread to understand what is being requested, then create a plan and implement it: ${state.createDialogSlackUrl}`
      : '',
  );
  const [inPlace, setInPlace] = useState(false);
  const [currentBranch, setCurrentBranch] = useState<string | null>(null);
  const [mode, setMode] = useState<TaskMode>('single');
  const [selectedRepoIds, setSelectedRepoIds] = useState<Set<string>>(new Set());

  const repoRef = useRef<HTMLInputElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const branchRef = useRef<HTMLInputElement>(null);
  const branchListRef = useRef<HTMLDivElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const createRef = useRef<HTMLButtonElement>(null);

  const close = useCallback(() => {
    dispatch({ type: 'SHOW_CREATE_TASK_DIALOG', show: false });
  }, [dispatch]);

  const overlayRef = useRef<HTMLDivElement>(null);

  const branchInputFullySelected =
    branchRef.current &&
    branchRef.current.selectionStart === 0 &&
    branchRef.current.selectionEnd === branchRef.current.value.length &&
    branchRef.current.value.length > 0;

  const filteredBranches = branches.filter((b) => {
    if (!branchSearch || branchInputFullySelected) return true;
    return b.toLowerCase().includes(branchSearch.toLowerCase());
  });

  const repo = state.repos.find((r) => r.id === repoId);
  const existingInPlaceTask =
    inPlace && repo ? state.tasks.find((t) => t.status !== 'archived' && t.worktreePath === repo.path) : undefined;

  useEffect(() => {
    setBranchFocusedIdx(0);
  }, [branchSearch]);

  useEffect(() => {
    branchListRef.current?.children[branchFocusedIdx]?.scrollIntoView({ block: 'nearest' });
  }, [branchFocusedIdx]);

  useOverlayFocus(repoRef);

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
          setPrompt(
            `Read the following Slack message and its thread to understand what is being requested, then create a plan and implement it: ${slack}`,
          );
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
          setPrBanner({
            number: parsed.number,
            message: `PR #${parsed.number} detected but ${parsed.owner}/${parsed.repo} is not managed in Bifrost`,
          });
          return;
        }

        // Fetch PR metadata (pass ghRepo so gh queries the right repo even if origin is a fork)
        const ghRepo = `${parsed.owner}/${parsed.repo}`;
        const info = await window.bifrost.fetchPrInfo(matchedRepo.id, parsed.number, ghRepo);
        setPrInfo(info);

        // Auto-fill: select repo and set branch
        setRepoId(matchedRepo.id);
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
      window.bifrost
        .getCurrentBranch(repoId)
        .then(setCurrentBranch)
        .catch(() => setCurrentBranch(null));
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
    window.bifrost
      .getRepoBranches(repoId)
      .then((b) => {
        if (!cancelled) {
          branchCache.set(repoId, b);
          setBranches(b);
        }
      })
      .finally(() => {
        if (!cancelled) setBranchesLoading(false);
      });
    return () => {
      cancelled = true;
    };
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

  const handleRepoSelect = (id: string) => {
    setRepoId(id);
    // Clear PR info when user selects a different repo from what the PR matched
    if (prInfo && id !== prBanner?.repoId) {
      setPrInfo(null);
      setPrBanner(null);
    }
    if (id) nameRef.current?.focus();
  };

  const selectBranch = (b: string) => {
    setBranch(b);
    setBranchSearch(b);
    setBranchDropdownOpen(false);
    // Clear PR info when user selects a branch different from the PR's head branch
    if (prInfo && b !== prBanner?.headBranch) {
      setPrInfo(null);
      setPrBanner(null);
    }
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
    if (mode === 'multi') {
      if (selectedRepoIds.size < 2 || !taskName.trim()) return;
      setLoading(true);
      setError(null);
      try {
        const task = await window.bifrost.createTask({
          multiRepoIds: [...selectedRepoIds],
          name: taskName.trim(),
          branch: '', // ignored for multi-repo
          ...(prompt.trim() && { prompt: prompt.trim() }),
        });
        localStorage.setItem('bifrost:lastRepoId', '');
        dispatch({ type: 'ADD_TASK', task });
        dispatch({ type: 'SET_ACTIVE_TASK', taskId: task.id });
        close();
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Failed to create task');
      } finally {
        setLoading(false);
      }
      return;
    }

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
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') {
        (e.target as HTMLElement).blur();
        overlayRef.current?.focus();
      } else {
        close();
      }
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
          const openTask = existingInPlaceTask;
          if (openTask) {
            e.preventDefault();
            openExistingTask(openTask.id, openTask.status);
          }
          break;
        }
        case 'KeyR':
          e.preventDefault();
          repoRef.current?.focus();
          break;
        case 'KeyB':
          e.preventDefault();
          branchRef.current?.focus();
          break;
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
      className="absolute inset-0 z-20 flex items-center justify-center bg-overlay focus:outline-hidden"
      onClick={close}
      onKeyDown={handleKeyDown}
    >
      <div
        className="bg-surface rounded-lg border border-border-input w-[550px] shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <OverlayHeader title="Create Task" onClose={close} />

        {state.repos.filter((r) => !r.multiTaskId).length > 1 && (
          <div className="px-4 pt-3">
            <PillToggle
              options={[
                { value: 'single' as TaskMode, label: 'Single Repo' },
                { value: 'multi' as TaskMode, label: 'Multi Repo' },
              ]}
              value={mode}
              onChange={(v) => {
                setMode(v);
                setError(null);
                if (v === 'multi' && !taskName) {
                  setTaskName(generateTaskName());
                }
              }}
            />
          </div>
        )}

        <div className="p-4 space-y-4">
          {/* PR detection banner */}
          {prBanner && (
            <div className="flex items-center justify-between bg-accent/10 border border-accent-muted rounded-sm px-3 py-2">
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
                className="text-xs text-accent-hover hover:brightness-125 ml-3 whitespace-nowrap transition-colors"
              >
                Ignore
              </button>
            </div>
          )}

          {/* Slack link banner */}
          {slackUrl && (
            <div className="flex items-center justify-between bg-accent/10 border border-accent-muted rounded-sm px-3 py-2">
              <p className="text-xs text-accent-hover truncate">Slack message detected</p>
              <button
                onClick={() => setSlackUrl(null)}
                className="text-xs text-accent-hover hover:brightness-125 ml-3 whitespace-nowrap transition-colors"
              >
                Ignore
              </button>
            </div>
          )}

          {/* No repos message */}
          {state.repos.length === 0 && (
            <div className="text-center py-2">
              <p className="text-sm text-secondary mb-2">No repositories added yet.</p>
              <PrimaryButton
                autoFocus
                onClick={() => {
                  close();
                  dispatch({ type: 'TOGGLE_REPO_MANAGER' });
                }}
              >
                Add a Repository
              </PrimaryButton>
            </div>
          )}

          {state.repos.length > 0 &&
            (mode === 'multi' ? (
              <>
                {/* Repo multi-select */}
                <div>
                  <label className="block text-xs text-secondary mb-1">Select Repositories</label>
                  <div className="border border-border-input rounded-sm max-h-[200px] overflow-y-auto">
                    {state.repos
                      .filter((r) => !r.multiTaskId)
                      .map((r) => (
                        <label
                          key={r.id}
                          className="flex items-center gap-2 px-3 py-1.5 hover:bg-surface-hover cursor-pointer transition-colors"
                        >
                          <input
                            type="checkbox"
                            checked={selectedRepoIds.has(r.id)}
                            onChange={() => {
                              setSelectedRepoIds((prev) => {
                                const next = new Set(prev);
                                if (next.has(r.id)) next.delete(r.id);
                                else next.add(r.id);
                                return next;
                              });
                            }}
                            className="rounded-sm border-border-input bg-surface-alt text-accent focus:ring-accent focus:ring-offset-0"
                          />
                          <span className="text-sm text-primary">{r.name}</span>
                          <span className="text-xs text-muted truncate">{r.path}</span>
                        </label>
                      ))}
                  </div>
                </div>

                {/* Task name */}
                <div>
                  <label className="block text-xs text-secondary mb-1">
                    Task <ActionLabel text="Name" showHint={true} />
                  </label>
                  <div className="flex gap-2">
                    <FormInput
                      ref={nameRef}
                      type="text"
                      value={taskName}
                      onChange={(e) => setTaskName(e.target.value)}
                      placeholder="Task name..."
                      className="flex-1 px-3 py-1.5"
                    />
                    <button
                      onClick={regenerateName}
                      title={`Generate new name (${altSymbol}N)`}
                      tabIndex={-1}
                      className="px-2 py-1.5 bg-surface-alt border border-border-input rounded-sm text-secondary hover:text-primary hover:border-border-input text-sm transition-colors"
                    >
                      &#x21bb;
                    </button>
                  </div>
                </div>

                {/* Prompt */}
                <div>
                  <label className="block text-xs text-secondary mb-1">
                    <ActionLabel text="Prompt" showHint={true} />
                  </label>
                  <FormTextarea
                    ref={promptRef}
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') e.stopPropagation();
                    }}
                    placeholder="Initial prompt sent to Claude (optional)"
                    rows={3}
                    className="w-full px-3 py-1.5 resize-y"
                  />
                </div>

                {error && <p className="text-xs text-danger">{error}</p>}
              </>
            ) : (
              <>
                {/* Repo select */}
                <div>
                  <label className="block text-xs text-secondary mb-1">
                    <ActionLabel text="Repository" showHint={true} />
                  </label>
                  <RepoDropdown
                    repos={state.repos}
                    selectedId={repoId}
                    onSelect={handleRepoSelect}
                    inputRef={repoRef}
                    autoFocus
                  />
                </div>

                {/* Task name */}
                <div>
                  <label className="block text-xs text-secondary mb-1">
                    Task <ActionLabel text="Name" showHint={true} />
                  </label>
                  <div className="flex gap-2">
                    <FormInput
                      ref={nameRef}
                      type="text"
                      value={taskName}
                      onChange={(e) => setTaskName(e.target.value)}
                      placeholder="select a repo to generate..."
                      className="flex-1 px-3 py-1.5"
                    />
                    <button
                      onClick={regenerateName}
                      title={`Generate new name (${altSymbol}N)`}
                      tabIndex={-1}
                      className="px-2 py-1.5 bg-surface-alt border border-border-input rounded-sm text-secondary hover:text-primary hover:border-border-input text-sm transition-colors"
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
                    className="rounded-sm border-border-input bg-surface-alt text-accent focus:ring-accent focus:ring-offset-0"
                  />
                  <span className="text-xs text-secondary">Use main worktree (no separate checkout)</span>
                </label>

                {/* In-place conflict banner */}
                {existingInPlaceTask && (
                  <div className="flex items-center justify-between bg-warning/10 border border-warning/30 rounded-sm px-3 py-2">
                    <p className="text-xs text-warning">
                      Task &ldquo;{existingInPlaceTask.name}&rdquo; already uses the main worktree
                    </p>
                    <button
                      onClick={() => openExistingTask(existingInPlaceTask.id, existingInPlaceTask.status)}
                      className="text-xs text-warning hover:text-warning/70 ml-3 whitespace-nowrap transition-colors"
                    >
                      <ActionLabel text="Open" showHint={true} />
                    </button>
                  </div>
                )}

                {/* Branch select */}
                <div className="relative">
                  <label className="block text-xs text-secondary mb-1">
                    <ActionLabel text="Branch" showHint={true} />
                  </label>
                  {inPlace ? (
                    <div className="w-full px-3 py-1.5 bg-surface-alt/50 border border-border-input rounded-sm text-sm text-secondary">
                      {currentBranch ?? 'Detecting...'}
                    </div>
                  ) : (
                    <>
                      <div className="relative">
                        <FormInput
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
                                  setBranchFocusedIdx((i) => (i < filteredBranches.length - 1 ? i + 1 : 0));
                                }
                                break;
                              case 'ArrowUp':
                                e.preventDefault();
                                if (!branchDropdownOpen) {
                                  setBranchDropdownOpen(true);
                                } else {
                                  setBranchFocusedIdx((i) => (i > 0 ? i - 1 : filteredBranches.length - 1));
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
                          placeholder={
                            branchesLoading ? '' : branches.length === 0 ? 'Select a repo first' : 'Type to search...'
                          }
                          disabled={branchesLoading || branches.length === 0}
                          className="w-full px-3 py-1.5 disabled:opacity-50"
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
                          className="absolute z-10 mt-1 w-full bg-surface-alt border border-border-input rounded-sm shadow-lg max-h-[200px] overflow-y-auto"
                        >
                          {filteredBranches.map((b, idx) => (
                            <div
                              key={b}
                              onMouseDown={() => selectBranch(b)}
                              onMouseEnter={() => setBranchFocusedIdx(idx)}
                              className={`px-3 py-1.5 cursor-pointer text-sm ${
                                idx === branchFocusedIdx
                                  ? 'bg-accent text-white'
                                  : 'text-primary hover:bg-surface-hover transition-colors'
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
                  <label className="block text-xs text-secondary mb-1">
                    <ActionLabel text="Prompt" showHint={true} />
                  </label>
                  <FormTextarea
                    ref={promptRef}
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    onKeyDown={(e) => {
                      // Allow Enter in textarea without triggering form submit
                      if (e.key === 'Enter') e.stopPropagation();
                    }}
                    placeholder="Initial prompt sent to Claude (optional)"
                    rows={3}
                    className="w-full px-3 py-1.5 resize-y"
                  />
                </div>

                {error && <p className="text-xs text-danger">{error}</p>}
              </>
            ))}
        </div>

        {/* Footer */}
        {state.repos.length > 0 && (
          <OverlayFooter className="flex items-center gap-2">
            <span className="text-xs text-faint">
              {mode === 'multi'
                ? `${altSymbol}N name · ${altSymbol}P prompt · Enter create`
                : `${altSymbol}R repo · ${altSymbol}N name · ${altSymbol}B branch · ${altSymbol}P prompt · Enter create`}
            </span>
            <span className="flex-1" />
            <PrimaryButton
              ref={createRef}
              onClick={handleSubmit}
              disabled={
                loading ||
                (mode === 'single' && (!repoId || !taskName.trim() || (!inPlace && !branch))) ||
                (mode === 'multi' && (selectedRepoIds.size < 2 || !taskName.trim()))
              }
              className="px-4"
            >
              {loading ? 'Creating...' : <ActionLabel text="Create" showHint={!loading} />}
            </PrimaryButton>
          </OverlayFooter>
        )}
      </div>
    </div>
  );
}
