import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useApp } from '../context/AppContext';
import type { Task } from '../../shared/types';

const statusLabel: Record<string, string> = {
  running: 'Running',
  stopped: 'Stopped',
  error: 'Error',
  archived: 'Archived',
};

const statusColor: Record<string, string> = {
  running: 'text-green-400',
  stopped: 'text-slate-400',
  error: 'text-red-400',
  archived: 'text-slate-500',
};

const filters = ['all', 'active', 'archived'] as const;
type Filter = (typeof filters)[number];

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

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

export default function TaskHistoryPanel() {
  const { state, dispatch } = useApp();
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [focusedIdx, setFocusedIdx] = useState(0);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const taskRefs = useRef<(HTMLDivElement | null)[]>([]);
  const listRef = useRef<HTMLDivElement>(null);

  const searchLower = search.toLowerCase();
  const filteredTasks = state.tasks
    .filter((t) => {
      if (filter === 'active' && t.status === 'archived') return false;
      if (filter === 'archived' && t.status !== 'archived') return false;
      if (searchLower) {
        const repo = state.repos.find((r) => r.id === t.repoId);
        const haystack = `${t.name} ${t.branch} ${repo?.name ?? ''}`.toLowerCase();
        return haystack.includes(searchLower);
      }
      return true;
    })
    .sort((a, b) => b.createdAt - a.createdAt);

  // Reset focus when filter or search changes
  useEffect(() => {
    setFocusedIdx(0);
  }, [filter, search]);

  // Clamp focus index when list shrinks
  useEffect(() => {
    if (focusedIdx >= filteredTasks.length && filteredTasks.length > 0) {
      setFocusedIdx(filteredTasks.length - 1);
    }
  }, [filteredTasks.length, focusedIdx]);

  // Scroll focused item into view
  useEffect(() => {
    taskRefs.current[focusedIdx]?.scrollIntoView({ block: 'nearest' });
  }, [focusedIdx]);

  // Focus the overlay on mount
  useEffect(() => {
    overlayRef.current?.focus();
  }, []);

  const close = useCallback(() => dispatch({ type: 'TOGGLE_TASK_HISTORY' }), [dispatch]);

  const repoName = (repoId: string) =>
    state.repos.find((r) => r.id === repoId)?.name ?? 'Unknown repo';

  const handleReopen = async (task: Task) => {
    setError(null);
    try {
      const updated = await window.bifrost.reopenTask(task.id);
      dispatch({ type: 'UPDATE_TASK', task: updated });
      dispatch({ type: 'SET_ACTIVE_TASK', taskId: updated.id });
      close();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to reopen task');
    }
  };

  const handleArchive = async (task: Task) => {
    setError(null);
    try {
      const updated = await window.bifrost.archiveTask(task.id);
      dispatch({ type: 'UPDATE_TASK', task: updated });
      if (state.activeTaskId === task.id) {
        const activeTasks = state.tasks.filter(
          (t) => t.id !== task.id && t.status !== 'archived',
        );
        dispatch({
          type: 'SET_ACTIVE_TASK',
          taskId: activeTasks.length > 0 ? activeTasks[activeTasks.length - 1].id : null,
        });
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to archive task');
    }
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
    if (task.status === 'running' || task.status === 'stopped') {
      dispatch({ type: 'SET_ACTIVE_TASK', taskId: task.id });
      close();
    }
  };

  const canReopen = (task: Task) => task.status === 'archived' || task.status === 'stopped';
  const canArchive = (task: Task) => task.status === 'running' || task.status === 'stopped';

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Don't handle keys while editing a name
    if (editingId) return;

    const focusedTask = filteredTasks[focusedIdx];

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
        setSearch((s) => s.slice(0, -1));
        break;

      case 'ArrowUp':
        e.preventDefault();
        setFocusedIdx((i) => (i > 0 ? i - 1 : filteredTasks.length - 1));
        break;

      case 'ArrowDown':
        e.preventDefault();
        setFocusedIdx((i) => (i < filteredTasks.length - 1 ? i + 1 : 0));
        break;

      case 'ArrowLeft': {
        e.preventDefault();
        const idx = filters.indexOf(filter);
        setFilter(filters[idx > 0 ? idx - 1 : filters.length - 1]);
        break;
      }

      case 'ArrowRight': {
        e.preventDefault();
        const idx = filters.indexOf(filter);
        setFilter(filters[idx < filters.length - 1 ? idx + 1 : 0]);
        break;
      }

      case 'Enter':
        e.preventDefault();
        if (focusedTask) {
          if (focusedTask.status === 'archived') {
            handleReopen(focusedTask);
          } else {
            handleActivate(focusedTask);
          }
        }
        break;

      case 'F2':
        e.preventDefault();
        if (focusedTask) startRename(focusedTask);
        break;

      default:
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
        } else if (!e.metaKey && !e.ctrlKey && e.key.length === 1) {
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
      className="fixed inset-0 z-20 flex items-center justify-center bg-black/60 focus:outline-none"
      onClick={close}
      onKeyDown={handleKeyDown}
    >
      <div
        className="bg-slate-800 rounded-lg border border-slate-600 w-[600px] max-h-[80vh] flex flex-col shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700">
          <h2 className="text-sm font-semibold text-slate-200">Task History</h2>
          <button
            onClick={close}
            tabIndex={-1}
            className="text-slate-400 hover:text-slate-200 text-lg leading-none"
          >
            &times;
          </button>
        </div>

        {/* Filter tabs */}
        <div className="flex gap-1 px-4 pt-3">
          {filters.map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              tabIndex={-1}
              className={`px-3 py-1 text-xs rounded ${
                filter === f
                  ? 'bg-slate-600 text-slate-200'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-700'
              }`}
            >
              {f.charAt(0).toUpperCase() + f.slice(1)}
            </button>
          ))}
          <span className="ml-auto text-xs text-slate-600 self-center">
            &larr;&rarr; tabs &uarr;&darr; tasks
          </span>
        </div>

        {error && (
          <p className="text-xs text-red-400 px-4 pt-2">{error}</p>
        )}

        {/* Search indicator */}
        {search && (
          <div className="mx-4 mt-3 px-3 py-1.5 bg-slate-700/70 border border-slate-600 rounded flex items-center gap-2">
            <span className="text-xs text-slate-500">Search:</span>
            <span className="text-sm text-slate-200 font-mono">{search}</span>
            <span className="ml-auto text-xs text-slate-600">Esc to clear</span>
          </div>
        )}

        {/* Task list */}
        <div ref={listRef} className="flex-1 overflow-y-auto p-4 space-y-2">
          {filteredTasks.length === 0 && (
            <p className="text-sm text-slate-500 text-center py-4">No tasks found.</p>
          )}
          {filteredTasks.map((task, idx) => (
            <div
              key={task.id}
              ref={(el) => { taskRefs.current[idx] = el; }}
              onMouseEnter={() => setFocusedIdx(idx)}
              onClick={() => handleActivate(task)}
              className={`rounded border p-3 cursor-default transition-colors ${
                idx === focusedIdx
                  ? 'bg-slate-700 border-blue-500/70 ring-1 ring-blue-500/40'
                  : 'bg-slate-700/50 border-slate-600/50'
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
                      className="px-2 py-0.5 bg-slate-600 border border-slate-500 rounded text-sm text-slate-200 focus:outline-none focus:border-blue-500 w-48"
                    />
                  ) : (
                    <span
                      className={`text-sm font-medium truncate ${
                        task.status === 'archived' ? 'text-slate-400' : 'text-slate-200'
                      }`}
                    >
                      {task.name}
                    </span>
                  )}
                  <span className={`text-xs ${statusColor[task.status]}`}>
                    {statusLabel[task.status]}
                  </span>
                </div>
                <div className="flex items-center gap-1 ml-2 flex-shrink-0">
                  <button
                    onClick={(e) => { e.stopPropagation(); startRename(task); }}
                    title="Rename (F2)"
                    tabIndex={-1}
                    className="px-1.5 py-0.5 text-xs text-slate-400 hover:text-slate-200 hover:bg-slate-600 rounded"
                  >
                    <ActionLabel text="Rename" showHint={idx === focusedIdx} />
                  </button>
                  {canReopen(task) && (
                    <button
                      onClick={(e) => { e.stopPropagation(); handleReopen(task); }}
                      title="Reopen task (Alt+O)"
                      tabIndex={-1}
                      className="px-1.5 py-0.5 text-xs text-blue-400 hover:text-blue-300 hover:bg-slate-600 rounded"
                    >
                      <ActionLabel text="Reopen" hintIndex={2} showHint={idx === focusedIdx} />
                    </button>
                  )}
                  {canArchive(task) && (
                    <button
                      onClick={(e) => { e.stopPropagation(); handleArchive(task); }}
                      title="Archive task (Alt+A)"
                      tabIndex={-1}
                      className="px-1.5 py-0.5 text-xs text-slate-400 hover:text-slate-200 hover:bg-slate-600 rounded"
                    >
                      <ActionLabel text="Archive" showHint={idx === focusedIdx} />
                    </button>
                  )}
                  <button
                    onClick={(e) => { e.stopPropagation(); handleDelete(task); }}
                    title="Delete task and worktree (Alt+D)"
                    tabIndex={-1}
                    className="px-1.5 py-0.5 text-xs text-red-400 hover:text-red-300 hover:bg-slate-600 rounded"
                  >
                    <ActionLabel text="Delete" showHint={idx === focusedIdx} />
                  </button>
                </div>
              </div>
              <div className="flex items-center gap-3 mt-1.5 text-xs text-slate-500">
                <span>{repoName(task.repoId)}</span>
                <span>{task.branch}</span>
                <span>{formatDate(task.createdAt)}</span>
                {task.archivedAt && <span>Archived {formatDate(task.archivedAt)}</span>}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
