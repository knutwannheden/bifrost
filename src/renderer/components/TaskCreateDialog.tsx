import React, { useState, useEffect, useCallback } from 'react';
import { useApp } from '../context/AppContext';

export default function TaskCreateDialog() {
  const { state, dispatch } = useApp();
  const [repoId, setRepoId] = useState('');
  const [taskName, setTaskName] = useState('');
  const [branch, setBranch] = useState('');
  const [branches, setBranches] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = useCallback(() => {
    dispatch({ type: 'SHOW_CREATE_TASK_DIALOG', show: false });
  }, [dispatch]);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [close]);

  useEffect(() => {
    if (!repoId) {
      setBranches([]);
      setBranch('');
      return;
    }
    window.bifrost.getRepoBranches(repoId).then((b) => {
      setBranches(b);
      const repo = state.repos.find((r) => r.id === repoId);
      if (repo && b.includes(repo.defaultBranch)) {
        setBranch(repo.defaultBranch);
      } else if (b.length > 0) {
        setBranch(b[0]);
      }
    });
  }, [repoId, state.repos]);

  const handleSubmit = async () => {
    if (!repoId || !taskName.trim() || !branch) return;
    setLoading(true);
    setError(null);
    try {
      const task = await window.bifrost.createTask({
        repoId,
        name: taskName.trim(),
        branch,
      });
      dispatch({ type: 'ADD_TASK', task });
      dispatch({ type: 'SET_ACTIVE_TASK', taskId: task.id });
      close();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to create task');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/60" onClick={close}>
      <div
        className="bg-slate-800 rounded-lg border border-slate-600 w-[450px] shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700">
          <h2 className="text-sm font-semibold text-slate-200">Create Task</h2>
          <button
            onClick={close}
            className="text-slate-400 hover:text-slate-200 text-lg leading-none"
          >
            x
          </button>
        </div>

        <div className="p-4 space-y-4">
          {/* Repo select */}
          <div>
            <label className="block text-xs text-slate-400 mb-1">Repository</label>
            <select
              value={repoId}
              onChange={(e) => setRepoId(e.target.value)}
              className="w-full px-3 py-1.5 bg-slate-700 border border-slate-600 rounded text-sm text-slate-200 focus:outline-none focus:border-blue-500"
            >
              <option value="">Select a repository...</option>
              {state.repos.map((repo) => (
                <option key={repo.id} value={repo.id}>
                  {repo.name}
                </option>
              ))}
            </select>
          </div>

          {/* Task name */}
          <div>
            <label className="block text-xs text-slate-400 mb-1">Task Name</label>
            <input
              type="text"
              value={taskName}
              onChange={(e) => setTaskName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
              placeholder="my-feature"
              className="w-full px-3 py-1.5 bg-slate-700 border border-slate-600 rounded text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:border-blue-500"
              autoFocus
            />
          </div>

          {/* Branch select */}
          <div>
            <label className="block text-xs text-slate-400 mb-1">Branch</label>
            <select
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              disabled={branches.length === 0}
              className="w-full px-3 py-1.5 bg-slate-700 border border-slate-600 rounded text-sm text-slate-200 focus:outline-none focus:border-blue-500 disabled:opacity-50"
            >
              {branches.length === 0 && <option value="">Select a repo first</option>}
              {branches.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          </div>

          {error && <p className="text-xs text-red-400">{error}</p>}

          <div className="flex justify-end gap-2">
            <button
              onClick={close}
              className="px-3 py-1.5 text-sm text-slate-400 hover:text-slate-200"
            >
              Cancel
            </button>
            <button
              onClick={handleSubmit}
              disabled={loading || !repoId || !taskName.trim() || !branch}
              className="px-4 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm rounded"
            >
              {loading ? 'Creating...' : 'Create'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
