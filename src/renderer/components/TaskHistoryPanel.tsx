import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useApp } from '../context/AppContext';
import ActionLabel from './ActionLabel';
import DiffStatsBadge from './DiffStatsBadge';
import { shortPath } from '../utils/paths';
import type { Task, ClaudeSession, DiffStats } from '../../shared/types';
import { requestArchive } from '../utils/archive';
import { matchesAllTerms } from '../utils/search';
import Highlight from './Highlight';
import SearchIndicator from './SearchIndicator';
import PillToggle, { type PillOption } from './PillToggle';
import Spinner from './Spinner';
import { formatDate, formatRelative } from '../utils/format-time';
import { altSymbol } from '../utils/platform';

const statusLabel: Record<string, string> = {
  running: 'Running',
  stopped: 'Stopped',
  error: 'Error',
  archived: 'Archived',
};

const statusColor: Record<string, string> = {
  running: 'text-success',
  stopped: 'text-secondary',
  error: 'text-danger',
  archived: 'text-muted',
};

const filters = ['active', 'all', 'archived', 'sessions'] as const;
type Filter = (typeof filters)[number];

const filterOptions: PillOption<Filter>[] = filters.map((f) => ({
  value: f,
  label: f === 'sessions' ? 'Sessions' : f.charAt(0).toUpperCase() + f.slice(1),
}));

const TIME_BUCKETS = [
  'Last 10 minutes',
  'Today',
  'Yesterday',
  'This week',
  'Last week',
  'This month',
  'Older',
] as const;

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function getTimeBucket(ts: number): string {
  const now = new Date();
  const diffMs = now.getTime() - ts;

  if (diffMs < 10 * 60 * 1000) return 'Last 10 minutes';

  const today = startOfDay(now);
  const taskDay = startOfDay(new Date(ts));

  if (taskDay.getTime() === today.getTime()) return 'Today';

  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (taskDay.getTime() === yesterday.getTime()) return 'Yesterday';

  const daysAgo = Math.floor((today.getTime() - taskDay.getTime()) / (24 * 60 * 60 * 1000));
  if (daysAgo < 7) return 'This week';
  if (daysAgo < 14) return 'Last week';
  if (daysAgo < 30) return 'This month';
  return 'Older';
}

interface TaskRowProps {
  task: Task;
  idx: number;
  focusedIdx: number;
  editingId: string | null;
  editName: string;
  diffStats?: DiffStats | null;
  search: string;
  setEditName: (name: string) => void;
  setFocusedIdx: (idx: number) => void;
  itemRefs: React.MutableRefObject<(HTMLDivElement | null)[]>;
  handleActivate: (task: Task) => void;
  startRename: (task: Task) => void;
  submitRename: (taskId: string) => void;
  setEditingId: (id: string | null) => void;
  handleReopen: (task: Task) => void;
  handleArchive: (task: Task) => void;
  handleDelete: (task: Task) => void;
  canReopen: (task: Task) => boolean;
  canArchive: (task: Task) => boolean;
  repoName: (repoId: string) => string;
  shortPath: (cwd: string) => string;
}

function TaskRow({
  task, idx, focusedIdx, editingId, editName, diffStats, search, setEditName,
  setFocusedIdx, itemRefs, handleActivate, startRename, submitRename,
  setEditingId, handleReopen, handleArchive, handleDelete,
  canReopen, canArchive, repoName, shortPath,
}: TaskRowProps) {
  return (
    <div
      ref={(el) => { itemRefs.current[idx] = el; }}
      onMouseEnter={() => setFocusedIdx(idx)}
      onClick={() => handleActivate(task)}
      className={`rounded border p-3 cursor-default transition-colors ${
        idx === focusedIdx
          ? 'bg-surface-alt border-accent-muted ring-1 ring-accent-muted'
          : 'bg-surface-alt/50 border-border-input/50'
      }`}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          {editingId === task.id ? (
            <input
              autoFocus
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitRename(task.id);
                if (e.key === 'Escape') { e.stopPropagation(); setEditingId(null); }
              }}
              onBlur={() => submitRename(task.id)}
              className="px-2 py-0.5 bg-surface-hover border border-border-input rounded text-sm text-primary focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent w-48"
            />
          ) : (
            <span
              className={`text-sm font-medium truncate ${
                task.status === 'archived' ? 'text-secondary' : 'text-primary'
              }`}
            >
              <Highlight text={task.name} search={search} />
            </span>
          )}
          <span className={`text-xs ${statusColor[task.status]}`}>
            {statusLabel[task.status]}
          </span>
          {diffStats && (
            <DiffStatsBadge additions={diffStats.additions} deletions={diffStats.deletions} />
          )}
          {task.isExternal && (
            <span className="text-xs text-faint">external</span>
          )}
          {task.inPlace && (
            <span className="text-xs text-faint">in-place</span>
          )}
        </div>
        <div className="flex items-center gap-1 ml-2 flex-shrink-0">
          <button
            onClick={(e) => { e.stopPropagation(); startRename(task); }}
            title="Rename (F2)"
            tabIndex={-1}
            className="px-1.5 py-0.5 text-xs text-secondary hover:text-primary hover:bg-surface-hover rounded"
          >
            <ActionLabel text="Rename" showHint={idx === focusedIdx} />
          </button>
          {canReopen(task) && (
            <button
              onClick={(e) => { e.stopPropagation(); handleReopen(task); }}
              title={`Reopen task (${altSymbol}O)`}
              tabIndex={-1}
              className="px-1.5 py-0.5 text-xs text-accent-hover hover:brightness-125 hover:bg-surface-hover rounded"
            >
              <ActionLabel text="Reopen" hintIndex={2} showHint={idx === focusedIdx} />
            </button>
          )}
          {canArchive(task) && (
            <button
              onClick={(e) => { e.stopPropagation(); handleArchive(task); }}
              title={`Archive task (${altSymbol}A)`}
              tabIndex={-1}
              className="px-1.5 py-0.5 text-xs text-secondary hover:text-primary hover:bg-surface-hover rounded"
            >
              <ActionLabel text="Archive" showHint={idx === focusedIdx} />
            </button>
          )}
          <button
            onClick={(e) => { e.stopPropagation(); handleDelete(task); }}
            title={task.inPlace || task.isExternal ? `Delete task (${altSymbol}D)` : `Delete task and worktree (${altSymbol}D)`}
            tabIndex={-1}
            className="px-1.5 py-0.5 text-xs text-danger hover:brightness-125 hover:bg-surface-hover rounded"
          >
            <ActionLabel text="Delete" showHint={idx === focusedIdx} />
          </button>
        </div>
      </div>
      {task.summary && (
        <div className="mt-1 text-xs text-muted"><Highlight text={task.summary} search={search} /></div>
      )}
      <div className="flex items-center gap-3 mt-1.5 text-xs text-muted">
        {task.isExternal ? (
          <span>{shortPath(task.worktreePath)}</span>
        ) : (
          <>
            <span><Highlight text={repoName(task.repoId)} search={search} /></span>
            <span><Highlight text={task.branch} search={search} /></span>
          </>
        )}
        <span>{formatDate(task.createdAt)}</span>
        {task.archivedAt && <span>Archived {formatDate(task.archivedAt)}</span>}
      </div>
    </div>
  );
}

export default function TaskHistoryPanel() {
  const { state, dispatch } = useApp();
  const [filter, setFilter] = useState<Filter>('active');
  const [search, setSearch] = useState('');
  const [focusedIdx, setFocusedIdx] = useState(0);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<ClaudeSession[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [diffStatsMap, setDiffStatsMap] = useState<Map<string, DiffStats>>(new Map());
  const [sessionMtimes, setSessionMtimes] = useState<Record<string, number>>({});
  const [branchConfirm, setBranchConfirm] = useState<{ task: Task; currentBranch: string } | null>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);
  const listRef = useRef<HTMLDivElement>(null);

  const isSessionsMode = filter === 'sessions';

  // Fetch diff stats for visible tasks
  useEffect(() => {
    if (isSessionsMode) return;
    const tasksToFetch = state.tasks.filter((t) => t.status !== 'archived' && !diffStatsMap.has(t.id));
    if (tasksToFetch.length === 0) return;

    for (const task of tasksToFetch) {
      window.bifrost.getDiffStats(task.id).then((stats) => {
        if (stats) {
          setDiffStatsMap((prev) => {
            const next = new Map(prev);
            next.set(task.id, stats);
            return next;
          });
        }
      }).catch(() => {
        // ignore errors
      });
    }
  }, [state.tasks, isSessionsMode]);

  // Fetch session JSONL mtimes for chronological ordering
  useEffect(() => {
    if (isSessionsMode) return;
    window.bifrost.getSessionMtimes().then(setSessionMtimes).catch(() => {});
  }, [isSessionsMode]);

  // Load sessions when switching to sessions tab
  useEffect(() => {
    if (isSessionsMode && sessions.length === 0) {
      setSessionsLoading(true);
      window.bifrost.listClaudeSessions().then((result) => {
        setSessions(result);
        setSessionsLoading(false);
      }).catch(() => {
        setSessionsLoading(false);
      });
    }
  }, [isSessionsMode]);

  const filteredTasks = isSessionsMode ? [] : state.tasks
    .filter((t) => {
      if (filter === 'active' && t.status === 'archived') return false;
      if (filter === 'archived' && t.status !== 'archived') return false;
      if (search) {
        const repo = state.repos.find((r) => r.id === t.repoId);
        return matchesAllTerms(`${t.name} ${t.branch} ${repo?.name ?? ''} ${t.summary ?? ''}`, search);
      }
      return true;
    })
    .sort((a, b) => (sessionMtimes[b.id] ?? b.createdAt) - (sessionMtimes[a.id] ?? a.createdAt));

  const filteredSessions = isSessionsMode
    ? sessions.filter((s) => matchesAllTerms(`${s.cwd} ${s.slug ?? ''}`, search))
    : [];

  const repoName = (repoId: string) =>
    state.repos.find((r) => r.id === repoId)?.name ?? '';

  const taskGroups = !isSessionsMode
    ? (() => {
        const map = new Map<string, Task[]>();
        for (const task of filteredTasks) {
          const bucket = getTimeBucket(sessionMtimes[task.id] ?? task.createdAt);
          let group = map.get(bucket);
          if (!group) {
            group = [];
            map.set(bucket, group);
          }
          group.push(task);
        }
        return TIME_BUCKETS
          .filter((b) => map.has(b))
          .map((b) => ({ name: b, tasks: map.get(b)! }));
      })()
    : [];

  // Build a flat list of tasks in grouped order for navigation
  const flatTaskList = taskGroups.flatMap((g) => g.tasks);

  const listLength = isSessionsMode ? filteredSessions.length : flatTaskList.length;

  // Reset focus and branch confirm when filter or search changes
  useEffect(() => {
    setFocusedIdx(0);
    setBranchConfirm(null);
  }, [filter, search]);

  // Clamp focus index when list shrinks
  useEffect(() => {
    if (focusedIdx >= listLength && listLength > 0) {
      setFocusedIdx(listLength - 1);
    }
  }, [listLength, focusedIdx]);

  // Scroll focused item into view
  useEffect(() => {
    itemRefs.current[focusedIdx]?.scrollIntoView({ block: 'nearest' });
  }, [focusedIdx]);

  // Focus the overlay on mount
  useEffect(() => {
    overlayRef.current?.focus();
  }, []);

  const close = useCallback(() => dispatch({ type: 'TOGGLE_TASK_HISTORY' }), [dispatch]);

  const doReopen = async (task: Task) => {
    setError(null);
    setBranchConfirm(null);
    try {
      const updated = await window.bifrost.reopenTask(task.id);
      dispatch({ type: 'UPDATE_TASK', task: updated });
      dispatch({ type: 'SET_ACTIVE_TASK', taskId: updated.id });
      close();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to reopen task');
    }
  };

  const handleReopen = async (task: Task) => {
    setError(null);
    if (task.inPlace) {
      try {
        const currentBranch = await window.bifrost.getCurrentBranch(task.repoId);
        if (currentBranch !== task.branch) {
          setBranchConfirm({ task, currentBranch });
          return;
        }
      } catch {
        // If we can't detect the branch, proceed with reopen
      }
    }
    doReopen(task);
  };

  const handleArchive = (task: Task) => {
    setError(null);
    requestArchive(task.id, task.name, state, dispatch);
  };

  const handleDelete = async (task: Task) => {
    setError(null);
    try {
      await window.bifrost.deleteTask(task.id);
      dispatch({ type: 'REMOVE_TASK', taskId: task.id });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to delete task');
    }
  };

  const startRename = (task: Task) => {
    setEditingId(task.id);
    setEditName(task.name);
  };

  const submitRename = async (taskId: string) => {
    if (!editName.trim()) {
      setEditingId(null);
      return;
    }
    setError(null);
    try {
      const updated = await window.bifrost.renameTask(taskId, editName.trim());
      dispatch({ type: 'UPDATE_TASK', task: updated });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to rename task');
    }
    setEditingId(null);
  };

  const handleActivate = (task: Task) => {
    if (task.status === 'running') {
      dispatch({ type: 'SET_ACTIVE_TASK', taskId: task.id });
      close();
    } else if (canReopen(task)) {
      handleReopen(task);
    }
  };

  const handleResumeSession = async (session: ClaudeSession) => {
    setError(null);
    try {
      const task = await window.bifrost.resumeClaudeSession(session.sessionId, session.cwd);
      dispatch({ type: 'ADD_TASK', task });
      dispatch({ type: 'SET_ACTIVE_TASK', taskId: task.id });
      close();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to resume session');
    }
  };

  const canReopen = (task: Task) => task.status === 'archived' || task.status === 'stopped';
  const canArchive = (task: Task) => task.status === 'running' || task.status === 'stopped';

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Don't handle keys while editing a name
    if (editingId) return;

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

      case 'Backspace':
        e.preventDefault();
        if (e.altKey) {
          setSearch((s) => s.replace(/\S+\s*$/, ''));
        } else {
          setSearch((s) => s.slice(0, -1));
        }
        break;

      case 'ArrowUp':
        e.preventDefault();
        setFocusedIdx((i) => Math.max(0, i - 1));
        break;

      case 'ArrowDown':
        e.preventDefault();
        setFocusedIdx((i) => Math.min(listLength - 1, i + 1));
        break;

      case 'Tab':
      case 'ArrowLeft':
      case 'ArrowRight': {
        e.preventDefault();
        const forward = e.key === 'ArrowRight' || (e.key === 'Tab' && !e.shiftKey);
        const idx = filters.indexOf(filter);
        setFilter(filters[forward
          ? (idx < filters.length - 1 ? idx + 1 : 0)
          : (idx > 0 ? idx - 1 : filters.length - 1)]);
        break;
      }

      case 'Enter':
        e.preventDefault();
        if (isSessionsMode) {
          const session = filteredSessions[focusedIdx];
          if (session) handleResumeSession(session);
        } else {
          const focusedTask = flatTaskList[focusedIdx];
          if (focusedTask) {
            if (focusedTask.status === 'running') {
              handleActivate(focusedTask);
            } else {
              handleReopen(focusedTask);
            }
          }
        }
        break;

      case 'F2':
        e.preventDefault();
        if (!isSessionsMode) {
          const focusedTask = flatTaskList[focusedIdx];
          if (focusedTask) startRename(focusedTask);
        }
        break;

      default:
        if (!isSessionsMode) {
          const focusedTask = flatTaskList[focusedIdx];
          // Alt+letter shortcuts (use e.code since Alt produces special chars on macOS)
          if (e.altKey && focusedTask) {
            switch (e.code) {
              case 'KeyR':
                e.preventDefault();
                startRename(focusedTask);
                break;
              case 'KeyO':
                if (canReopen(focusedTask)) {
                  e.preventDefault();
                  handleReopen(focusedTask);
                }
                break;
              case 'KeyA':
                if (canArchive(focusedTask)) {
                  e.preventDefault();
                  handleArchive(focusedTask);
                }
                break;
              case 'KeyD':
                e.preventDefault();
                handleDelete(focusedTask);
                break;
            }
          }
        }
        if (!e.metaKey && !e.ctrlKey && !e.altKey && e.key.length === 1) {
          // Incremental search
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
      className="absolute inset-0 z-20 flex items-center justify-center bg-overlay focus:outline-none"
      onClick={close}
      onKeyDown={handleKeyDown}
    >
      <div
        className="bg-surface rounded-lg border border-border-input w-[720px] h-[90vh] flex flex-col shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border-default">
          <h2 className="text-sm font-semibold text-primary">
            {isSessionsMode ? 'Claude Sessions' : 'Task History'}
          </h2>
          <button
            onClick={close}
            tabIndex={-1}
            className="text-secondary hover:text-primary text-lg leading-none"
          >
            &times;
          </button>
        </div>

        {/* Filter tabs */}
        <div className="flex gap-1 px-4 pt-3">
          <PillToggle
            options={filterOptions}
            value={filter}
            onChange={(v) => setFilter(v)}
            size="md"
          />
          <span className="ml-auto text-xs text-faint self-center">
            Tab/&larr;&rarr; tabs &middot; &uarr;&darr; navigate &middot; Enter {isSessionsMode ? 'resume' : 'open'} &middot; {!isSessionsMode && <>F2 rename &middot; {altSymbol}O/{altSymbol}A/{altSymbol}D actions &middot; </>}type to search &middot; Esc close
          </span>
        </div>

        {error && (
          <p className="text-xs text-danger px-4 pt-2">{error}</p>
        )}

        {branchConfirm && (
          <div className="mx-4 mt-3 px-3 py-2 bg-warning/10 border border-warning/30 rounded flex items-center gap-3">
            <span className="text-xs text-warning flex-1">
              Branch changed from <span className="font-mono font-medium">{branchConfirm.task.branch}</span> to <span className="font-mono font-medium">{branchConfirm.currentBranch}</span>
            </span>
            <button
              onClick={() => doReopen(branchConfirm.task)}
              className="px-2 py-0.5 text-xs bg-accent hover:bg-accent-hover text-white rounded"
            >
              Reopen on {branchConfirm.currentBranch}
            </button>
            <button
              onClick={() => setBranchConfirm(null)}
              className="px-2 py-0.5 text-xs text-secondary hover:text-primary hover:bg-surface-hover rounded"
            >
              Cancel
            </button>
          </div>
        )}

        <SearchIndicator search={search} className="mx-4 mt-3" />

        {/* List content */}
        <div ref={listRef} className="flex-1 overflow-y-auto p-4 space-y-2">
          {isSessionsMode ? (
            <>
              {sessionsLoading && (
                <div className="flex items-center justify-center py-4 gap-2 text-secondary">
                  <Spinner />
                  <span className="text-sm">Scanning sessions...</span>
                </div>
              )}
              {!sessionsLoading && filteredSessions.length === 0 && (
                <p className="text-sm text-muted text-center py-4">No recent Claude sessions found.</p>
              )}
              {filteredSessions.map((session, idx) => (
                <div
                  key={session.sessionId}
                  ref={(el) => { itemRefs.current[idx] = el; }}
                  onMouseEnter={() => setFocusedIdx(idx)}
                  onClick={() => handleResumeSession(session)}
                  className={`rounded border p-3 cursor-default transition-colors ${
                    idx === focusedIdx
                      ? 'bg-surface-alt border-accent-muted ring-1 ring-accent-muted'
                      : 'bg-surface-alt/50 border-border-input/50'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-primary truncate">
                      {shortPath(session.cwd)}
                    </span>
                    <span className="text-xs text-accent-hover flex-shrink-0 ml-2">
                      Resume
                    </span>
                  </div>
                  <div className="flex items-center gap-3 mt-1.5 text-xs text-muted">
                    {session.slug && <span className="text-secondary">{session.slug}</span>}
                    <span>{formatRelative(session.lastModified)}</span>
                    <span className="font-mono text-faint">{session.sessionId.slice(0, 8)}</span>
                  </div>
                </div>
              ))}
            </>
          ) : (
            <>
              {flatTaskList.length === 0 && (
                <p className="text-sm text-muted text-center py-4">No tasks found.</p>
              )}
              {(() => {
                  let flatIdx = 0;
                  return taskGroups.map((group) => (
                    <div key={group.name} className="space-y-2">
                      <div className="text-xs font-semibold text-secondary uppercase tracking-wide px-1 pt-2 pb-1">
                        {group.name}
                      </div>
                      {group.tasks.map((task) => {
                        const idx = flatIdx++;
                        return (
                          <TaskRow
                            key={task.id}
                            task={task}
                            idx={idx}
                            focusedIdx={focusedIdx}
                            editingId={editingId}
                            editName={editName}
                            diffStats={diffStatsMap.get(task.id)}
                            search={search}
                            setEditName={setEditName}
                            setFocusedIdx={setFocusedIdx}
                            itemRefs={itemRefs}
                            handleActivate={handleActivate}
                            startRename={startRename}
                            submitRename={submitRename}
                            setEditingId={setEditingId}
                            handleReopen={handleReopen}
                            handleArchive={handleArchive}
                            handleDelete={handleDelete}
                            canReopen={canReopen}
                            canArchive={canArchive}
                            repoName={repoName}
                            shortPath={shortPath}
                          />
                        );
                      })}
                    </div>
                  ));
                })()}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
