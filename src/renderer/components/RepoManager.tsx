import React, { useState, useEffect, useCallback } from 'react';
import { useApp } from '../context/AppContext';

export default function RepoManager() {
  const { state, dispatch } = useApp();
  const [localPath, setLocalPath] = useState('');
  const [error, setError] = useState<string | null>(null);

  const close = useCallback(() => {
    dispatch({ type: 'TOGGLE_REPO_MANAGER' });
  }, [dispatch]);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [close]);

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

  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/60" onClick={close}>
      <div
        className="bg-slate-800 rounded-lg border border-slate-600 w-[500px] max-h-[80vh] overflow-hidden shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700">
          <h2 className="text-sm font-semibold text-slate-200">Manage Repositories</h2>
          <button
            onClick={close}
            className="text-slate-400 hover:text-slate-200 text-lg leading-none"
          >
            x
          </button>
        </div>

        <div className="p-4 space-y-4">
          {/* Repo list */}
          <div className="space-y-2 max-h-[300px] overflow-y-auto">
            {state.repos.length === 0 && (
              <p className="text-sm text-slate-500">No repositories added yet.</p>
            )}
            {state.repos.map((repo) => (
              <div
                key={repo.id}
                className="flex items-center justify-between bg-slate-700/50 rounded px-3 py-2"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-slate-200 truncate">{repo.name}</p>
                  <p className="text-xs text-slate-400 truncate">{repo.path}</p>
                </div>
                <button
                  onClick={() => handleRemove(repo.id)}
                  className="ml-3 text-xs text-red-400 hover:text-red-300"
                >
                  Remove
                </button>
              </div>
            ))}
          </div>

          {/* Add local repo */}
          <div>
            <label className="block text-xs text-slate-400 mb-1">Add Local Repository</label>
            <div className="flex gap-2">
              <input
                type="text"
                value={localPath}
                onChange={(e) => setLocalPath(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleAddLocal()}
                placeholder="/path/to/repo"
                className="flex-1 px-3 py-1.5 bg-slate-700 border border-slate-600 rounded text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:border-blue-500"
              />
              <button
                onClick={handleBrowse}
                className="px-3 py-1.5 bg-slate-600 hover:bg-slate-500 text-slate-200 text-sm rounded"
              >
                Browse
              </button>
              <button
                onClick={handleAddLocal}
                disabled={!localPath.trim()}
                className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm rounded"
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
