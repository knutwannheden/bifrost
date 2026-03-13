import { useEffect, useState } from 'react';
import type { BifrostConfig, DiffStats, Task } from '../../shared/types';
import { shortPath } from '../utils/paths';
import DiffStatsBadge from './DiffStatsBadge';

interface StatusBarProps {
  activeTask: Task | null;
  config: BifrostConfig | null;
  onToggleIde: () => void;
}

export default function StatusBar({ activeTask, config, onToggleIde }: StatusBarProps) {
  const [diffStats, setDiffStats] = useState<DiffStats | null>(null);

  useEffect(() => {
    if (!activeTask) {
      setDiffStats(null);
      return;
    }

    const fetchStats = () => {
      window.bifrost
        .getDiffStats(activeTask.id)
        .then(setDiffStats)
        .catch(() => setDiffStats(null));
    };
    fetchStats();

    const unsub = window.bifrost.onActivityEntry((entry) => {
      if (entry.taskId === activeTask.id) fetchStats();
    });
    return unsub;
  }, [activeTask?.id]);

  return (
    <div className="h-6 bg-surface border-t border-border-default flex items-center px-4 text-xs text-muted">
      <div className="flex items-center gap-3 min-w-0 flex-1">
        {activeTask && (
          <>
            <span className="truncate" title={activeTask.worktreePath}>
              {shortPath(activeTask.worktreePath)}
            </span>
            <DiffStatsBadge additions={diffStats?.additions ?? 0} deletions={diffStats?.deletions ?? 0} />
          </>
        )}
      </div>
      <div className="flex items-center gap-3 shrink-0">
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
      </div>
    </div>
  );
}
