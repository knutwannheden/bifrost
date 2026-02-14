import type { Task, BifrostConfig, Repo } from '../../shared/types';

function shortenHome(p: string): string {
  const home = window.bifrost.homeDir;
  if (home && p.startsWith(home)) {
    return '~' + p.slice(home.length);
  }
  return p;
}

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
    <div className="h-6 bg-slate-800 border-t border-slate-700 flex items-center px-4 text-xs text-slate-500">
      <div className="flex items-center gap-3 min-w-0 flex-1">
        {activeTask && (
          <>
            <span className="truncate max-w-[300px]" title={activeTask.worktreePath}>
              {shortenHome(activeTask.worktreePath)}
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
        <span>{apiPort ? `MCP :${apiPort}` : 'MCP off'}</span>
        <span>Repos: {repos.length}</span>
      </div>
    </div>
  );
}
