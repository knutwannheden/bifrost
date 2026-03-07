import type { Task, BifrostConfig, Repo } from '../../shared/types';
import { shortPath } from '../utils/paths';

interface StatusBarProps {
  activeTask: Task | null;
  config: BifrostConfig | null;
  repos: Repo[];
  apiPort: number | null;
  onToggleIde: () => void;
}

export default function StatusBar({
  activeTask,
  config,
  repos,
  apiPort,
  onToggleIde,
}: StatusBarProps) {
  return (
    <div className="h-6 bg-surface border-t border-border-default flex items-center px-4 text-xs text-muted">
      <div className="flex items-center gap-3 min-w-0 flex-1">
        {activeTask && (
          <>
            <span className="truncate" title={activeTask.worktreePath}>
              {shortPath(activeTask.worktreePath)}
            </span>
            <span className="capitalize">{activeTask.status}</span>
          </>
        )}
      </div>
      <div className="flex items-center gap-3 flex-shrink-0">
        {config && (
          <button
            type="button"
            className="hover:text-secondary transition-colors"
            onClick={onToggleIde}
            title={`IDE: ${config.ide} (click to toggle)`}
          >
            IDE: {config.ide}
          </button>
        )}
        <span>{apiPort ? `MCP :${apiPort}` : 'MCP off'}</span>
        <span>Repos: {repos.length}</span>
      </div>
    </div>
  );
}
