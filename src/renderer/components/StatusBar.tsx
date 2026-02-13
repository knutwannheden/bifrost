import React from 'react';
import type { Task, BifrostConfig, Repo } from '../../shared/types';

interface StatusBarProps {
  activeTask: Task | null;
  config: BifrostConfig | null;
  repos: Repo[];
  onToggleIde: () => void;
}

export default function StatusBar({
  activeTask,
  config,
  repos,
  onToggleIde,
}: StatusBarProps) {
  return (
    <div className="h-6 bg-slate-800 border-t border-slate-700 flex items-center px-4 text-xs text-slate-500">
      <div className="flex items-center gap-3 min-w-0 flex-1">
        {activeTask && (
          <>
            <span className="truncate max-w-[300px]" title={activeTask.worktreePath}>
              {activeTask.worktreePath}
            </span>
            <span className="capitalize">{activeTask.status}</span>
          </>
        )}
      </div>
      <div className="flex items-center gap-3 flex-shrink-0">
        {config && (
          <button
            type="button"
            className="hover:text-slate-300 transition-colors"
            onClick={onToggleIde}
            title={`IDE: ${config.ide} (click to toggle)`}
          >
            IDE: {config.ide}
          </button>
        )}
        <span>Repos: {repos.length}</span>
      </div>
    </div>
  );
}
