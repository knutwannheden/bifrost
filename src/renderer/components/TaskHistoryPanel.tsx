import React, { useState } from 'react';
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

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function TaskHistoryPanel() {
  const { state, dispatch } = useApp();
  const [filter, setFilter] = useState<'all' | 'active' | 'archived'>('all');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const close = () => dispatch({ type: 'TOGGLE_TASK_HISTORY' });

  const handleOverlayKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  };

  const filteredTasks = state.tasks
    .filter((t) => {
      if (filter === 'active') return t.status !== 'archived';
      if (filter === 'archived') return t.status === 'archived';
      return true;
    })
    .sort((a, b) => b.createdAt - a.createdAt);

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

  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/60" onClick={close} onKeyDown={handleOverlayKeyDown}>
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
          {(['all', 'active', 'archived'] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-3 py-1 text-xs rounded ${
                filter === f
                  ? 'bg-slate-600 text-slate-200'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-700'
              }`}
            >
              {f.charAt(0).toUpperCase() + f.slice(1)}
            </button>
          ))}
        </div>

        {error && (
          <p className="text-xs text-red-400 px-4 pt-2">{error}</p>
        )}

        {/* Task list */}
        <div className="flex-1 overflow-y-auto p-4 space-y-2">
          {filteredTasks.length === 0 && (
            <p className="text-sm text-slate-500 text-center py-4">No tasks found.</p>
          )}
          {filteredTasks.map((task) => (
            <div
              key={task.id}
              className="bg-slate-700/50 rounded border border-slate-600/50 p-3"
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
                        if (e.key === 'Escape') setEditingId(null);
                      }}
                      onBlur={() => submitRename(task.id)}
                      className="px-2 py-0.5 bg-slate-600 border border-slate-500 rounded text-sm text-slate-200 focus:outline-none focus:border-blue-500 w-48"
                    />
                  ) : (
                    <span
                      className={`text-sm font-medium truncate ${
                        task.status === 'archived' ? 'text-slate-400' : 'text-slate-200'
                      } ${task.status !== 'archived' ? 'cursor-pointer hover:text-blue-400' : ''}`}
                      onClick={() => handleActivate(task)}
                      title={task.status !== 'archived' ? 'Click to activate' : undefined}
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
                    onClick={() => startRename(task)}
                    title="Rename"
                    className="px-1.5 py-0.5 text-xs text-slate-400 hover:text-slate-200 hover:bg-slate-600 rounded"
                  >
                    Rename
                  </button>
                  {task.status === 'archived' || task.status === 'stopped' ? (
                    <button
                      onClick={() => handleReopen(task)}
                      title="Reopen task"
                      className="px-1.5 py-0.5 text-xs text-blue-400 hover:text-blue-300 hover:bg-slate-600 rounded"
                    >
                      Reopen
                    </button>
                  ) : null}
                  {task.status === 'running' || task.status === 'stopped' ? (
                    <button
                      onClick={() => handleArchive(task)}
                      title="Archive task"
                      className="px-1.5 py-0.5 text-xs text-slate-400 hover:text-slate-200 hover:bg-slate-600 rounded"
                    >
                      Archive
                    </button>
                  ) : null}
                  <button
                    onClick={() => handleDelete(task)}
                    title="Delete task and worktree"
                    className="px-1.5 py-0.5 text-xs text-red-400 hover:text-red-300 hover:bg-slate-600 rounded"
                  >
                    Delete
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
