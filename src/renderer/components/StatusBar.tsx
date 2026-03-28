import { useEffect, useRef, useState } from 'react';
import type { BifrostConfig, DiffStats, Task } from '../../shared/types';
import { shortPath } from '../utils/paths';
import DiffStatsBadge from './DiffStatsBadge';

function PathMenu({ worktreePath, onClose }: { worktreePath: string; onClose: () => void }) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  return (
    <div
      ref={menuRef}
      className="absolute bottom-full left-0 mb-1 bg-surface border border-border-input rounded-sm shadow-lg py-1 min-w-[160px] z-30"
    >
      <button
        type="button"
        className="block w-full text-left px-3 py-1 text-xs text-secondary hover:text-primary hover:bg-surface-hover transition-colors"
        onClick={() => {
          navigator.clipboard.writeText(worktreePath);
          onClose();
        }}
      >
        Copy path
      </button>
      <button
        type="button"
        className="block w-full text-left px-3 py-1 text-xs text-secondary hover:text-primary hover:bg-surface-hover transition-colors"
        onClick={() => {
          window.bifrost.openInTerminal(worktreePath);
          onClose();
        }}
      >
        Open in terminal
      </button>
    </div>
  );
}

interface StatusBarProps {
  activeTask: Task | null;
  config: BifrostConfig | null;
  onToggleIde: () => void;
}

export default function StatusBar({ activeTask, config, onToggleIde }: StatusBarProps) {
  const [diffStats, setDiffStats] = useState<DiffStats | null>(null);
  const [prUrl, setPrUrl] = useState<string | null>(null);
  const [pathMenuOpen, setPathMenuOpen] = useState(false);

  useEffect(() => {
    if (!activeTask) {
      setDiffStats(null);
      setPrUrl(null);
      return;
    }

    const fetchStats = () => {
      window.bifrost
        .getDiffStats(activeTask.id)
        .then(setDiffStats)
        .catch(() => setDiffStats(null));
    };

    fetchStats();
    window.bifrost
      .getPrUrl(activeTask.id)
      .then(setPrUrl)
      .catch(() => setPrUrl(null));

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
            <span className="relative">
              <button
                type="button"
                className="truncate hover:text-secondary transition-colors"
                title={activeTask.worktreePath}
                onClick={() => setPathMenuOpen((v) => !v)}
              >
                {shortPath(activeTask.worktreePath)}
              </button>
              {pathMenuOpen && (
                <PathMenu worktreePath={activeTask.worktreePath} onClose={() => setPathMenuOpen(false)} />
              )}
            </span>
            <DiffStatsBadge additions={diffStats?.additions ?? 0} deletions={diffStats?.deletions ?? 0} />
            {prUrl && (
              <button
                type="button"
                className="text-accent-hover hover:underline transition-colors"
                onClick={() => window.bifrost.openUrl(prUrl)}
                title={prUrl}
              >
                PR #{prUrl.split('/').pop()}
              </button>
            )}
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
