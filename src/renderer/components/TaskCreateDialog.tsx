import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useApp } from '../context/AppContext';
import { generateTaskName } from '../utils/name-generator';

export default function TaskCreateDialog() {
  const { state, dispatch } = useApp();
  const [repoId, setRepoId] = useState('');
  const [taskName, setTaskName] = useState('');
  const [branch, setBranch] = useState('');
  const [branches, setBranches] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const repoRef = useRef<HTMLSelectElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const branchRef = useRef<HTMLSelectElement>(null);
  const createRef = useRef<HTMLButtonElement>(null);

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

  // Focus the repo select on open
  useEffect(() => {
    if (state.repos.length > 0) {
      repoRef.current?.focus();
    }
  }, [state.repos.length]);

  useEffect(() => {
    if (!repoId) {
      setBranches([]);
      setBranch('');
      return;
    }
    setTaskName(generateTaskName());
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

  const regenerateName = () => {
    setTaskName(generateTaskName());
    nameRef.current?.focus();
  };

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

  const handleFormKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.defaultPrevented) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/60" onClick={close}>
      <div
        className="bg-slate-800 rounded-lg border border-slate-600 w-[450px] shadow-xl"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleFormKeyDown}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700">
          <h2 className="text-sm font-semibold text-slate-200">Create Task</h2>
          <button
            onClick={close}
            tabIndex={-1}
            className="text-slate-400 hover:text-slate-200 text-lg leading-none"
          >
            x
          </button>
        </div>

        <div className="p-4 space-y-4">
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
          <div>
            <label className="block text-xs text-slate-400 mb-1">Repository</label>
            <select
              ref={repoRef}
              value={repoId}
              onChange={(e) => setRepoId(e.target.value)}
              className="w-full px-3 py-1.5 bg-slate-700 border border-slate-600 rounded text-sm text-slate-200 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
            >
              <option value="">Select a repository...</option>
              {state.repos.map((repo) => (
                <option key={repo.id} value={repo.id}>
                  {repo.name}
                </option>
              ))}
            </select>
          </div>
          )}

          {state.repos.length > 0 && (
          <>
          {/* Task name */}
          <div>
            <label className="block text-xs text-slate-400 mb-1">Task Name</label>
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
                title="Generate new name"
                tabIndex={-1}
                className="px-2 py-1.5 bg-slate-700 border border-slate-600 rounded text-slate-400 hover:text-slate-200 hover:border-slate-500 text-sm"
              >
                &#x21bb;
              </button>
            </div>
          </div>

          {/* Branch select */}
          <div>
            <label className="block text-xs text-slate-400 mb-1">Branch</label>
            <select
              ref={branchRef}
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              disabled={branches.length === 0}
              className="w-full px-3 py-1.5 bg-slate-700 border border-slate-600 rounded text-sm text-slate-200 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 disabled:opacity-50"
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
              className="px-3 py-1.5 text-sm text-slate-400 hover:text-slate-200 rounded focus:outline-none focus:ring-1 focus:ring-slate-500"
            >
              Cancel
            </button>
            <button
              ref={createRef}
              onClick={handleSubmit}
              disabled={loading || !repoId || !taskName.trim() || !branch}
              className="px-4 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm rounded focus:outline-none focus:ring-2 focus:ring-blue-400"
            >
              {loading ? 'Creating...' : 'Create'}
            </button>
          </div>
          </>
          )}
        </div>
      </div>
    </div>
  );
}
