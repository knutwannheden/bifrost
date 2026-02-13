import React, { useEffect } from 'react';
import { useApp } from '../context/AppContext';
import { useDiff } from '../hooks/useDiff';

function classifyLine(line: string): string {
  if (line.startsWith('diff ') || line.startsWith('---') || line.startsWith('+++')) {
    return 'font-bold text-slate-300';
  }
  if (line.startsWith('@@')) {
    return 'text-blue-400';
  }
  if (line.startsWith('+')) {
    return 'text-green-400';
  }
  if (line.startsWith('-')) {
    return 'text-red-400';
  }
  return 'text-slate-400';
}

export default function DiffOverlay() {
  const { state, dispatch } = useApp();
  const { diff, loading, error } = useDiff(state.showDiff ? state.activeTaskId : null);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        dispatch({ type: 'TOGGLE_DIFF' });
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [dispatch]);

  if (!state.showDiff) return null;

  return (
    <div className="fixed inset-0 z-30 bg-slate-900/95 flex flex-col">
      <div className="flex items-center justify-between h-10 px-4 border-b border-slate-700 flex-shrink-0">
        <span className="text-sm font-semibold text-slate-300">Diff</span>
        <button
          className="text-slate-400 hover:text-slate-200 text-lg"
          onClick={() => dispatch({ type: 'TOGGLE_DIFF' })}
        >
          &times;
        </button>
      </div>

      <div className="flex-1 overflow-auto p-4 font-mono text-sm">
        {loading && (
          <div className="flex items-center gap-2 text-slate-400">
            <div className="w-4 h-4 border-2 border-slate-500 border-t-slate-200 rounded-full animate-spin" />
            <span>Loading diff...</span>
          </div>
        )}

        {error && (
          <div className="text-red-400">Error: {error}</div>
        )}

        {!loading && !error && (diff === null || diff === '') && (
          <div className="text-slate-500">No changes</div>
        )}

        {!loading && !error && diff && (
          <pre className="whitespace-pre">
            {diff.split('\n').map((line, i) => (
              <div key={i} className={classifyLine(line)}>
                {line || '\n'}
              </div>
            ))}
          </pre>
        )}
      </div>
    </div>
  );
}
