import { useEffect, useState } from 'react';
import { useApp } from '../context/AppContext';
import { repoDisplayName, shortPath } from '../utils/paths';
import { getTimeBucket, TIME_BUCKETS } from '../utils/time-buckets';
import TaskTab from './TaskTab';

const DEFAULT_WIDTH = 240;
// Pinned tasks leave their time group for this one, so every task still belongs
// to exactly one group and the header counts stay true.
const PINNED = 'Pinned';
const GROUPS = [PINNED, ...TIME_BUCKETS] as const;
// Anything older than the current week starts folded, so dormant work costs
// one line per group rather than one line per task.
const DEFAULT_COLLAPSED: (typeof GROUPS)[number][] = ['This week', 'Last week', 'This month', 'Older'];

export default function TaskSidebar() {
  const { state, dispatch } = useApp();
  const [mtimes, setMtimes] = useState<Record<string, number>>({});
  const [dragWidth, setDragWidth] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      window.bifrost.getSessionMtimes().then((m) => {
        if (!cancelled) setMtimes(m);
      });
    };
    load();
    const timer = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const config = state.config;
  const collapsed = config?.collapsedBuckets ?? DEFAULT_COLLAPSED;
  const width = config?.sidebarWidth ?? DEFAULT_WIDTH;

  const openTasks = state.tasks.filter((t) => t.status === 'running');

  const recency = (id: string, createdAt: number) => mtimes[id] ?? createdAt;
  const sorted = [...openTasks].sort((a, b) => recency(b.id, b.createdAt) - recency(a.id, a.createdAt));

  const pinnedIds = config?.pinnedTaskIds ?? [];

  const groups = new Map<string, typeof sorted>();
  for (const task of sorted) {
    const bucket = pinnedIds.includes(task.id) ? PINNED : getTimeBucket(recency(task.id, task.createdAt));
    const list = groups.get(bucket);
    if (list) list.push(task);
    else groups.set(bucket, [task]);
  }

  const toggle = (bucket: string) => {
    const next = collapsed.includes(bucket) ? collapsed.filter((b) => b !== bucket) : [...collapsed, bucket];
    if (config) {
      const updated = { ...config, collapsedBuckets: next };
      dispatch({ type: 'SET_CONFIG', config: updated });
      window.bifrost.saveConfig(updated);
    }
  };

  // A collapsed group still shows the active task's row, so this is not simply
  // "skip collapsed buckets" — shared by the published order and the rendered rows below.
  const visibleTasksFor = (bucket: string) => {
    const tasks = groups.get(bucket) ?? [];
    return collapsed.includes(bucket) ? tasks.filter((t) => t.id === state.activeTaskId) : tasks;
  };

  const visibleTaskIds = GROUPS.filter((b) => groups.has(b)).flatMap((b) => visibleTasksFor(b).map((t) => t.id));

  const togglePin = (taskId: string) => {
    const next = pinnedIds.includes(taskId) ? pinnedIds.filter((id) => id !== taskId) : [...pinnedIds, taskId];
    if (config) {
      const updated = { ...config, pinnedTaskIds: next };
      dispatch({ type: 'SET_CONFIG', config: updated });
      window.bifrost.saveConfig(updated);
    }
  };

  useEffect(() => {
    dispatch({ type: 'SET_VISIBLE_TASK_IDS', taskIds: visibleTaskIds });
  }, [visibleTaskIds.join(',')]);

  // TaskSidebar unmounts rather than hiding via CSS when the sidebar is toggled
  // off, so clearing the published order here re-engages the keymap's fallback.
  useEffect(() => {
    return () => {
      dispatch({ type: 'SET_VISIBLE_TASK_IDS', taskIds: [] });
    };
  }, []);

  if (openTasks.length === 0) return null;

  return (
    <div
      className="relative flex flex-col shrink-0 bg-surface/50 border-r border-border-default"
      style={{ width: dragWidth ?? width }}
    >
      <div className="flex-1 overflow-y-auto">
        {GROUPS.filter((b) => groups.has(b)).map((bucket) => {
          const tasks = groups.get(bucket) ?? [];
          const isCollapsed = collapsed.includes(bucket);
          const visibleTasks = visibleTasksFor(bucket);
          return (
            <div key={bucket}>
              <button
                type="button"
                onClick={() => toggle(bucket)}
                className="flex w-full items-center gap-1 px-2 py-1 bg-surface-alt text-xs font-semibold text-secondary uppercase tracking-wider hover:bg-surface-hover hover:text-primary transition-colors"
              >
                <span className="w-3 shrink-0">{isCollapsed ? '▸' : '▾'}</span>
                <span className="truncate">{bucket}</span>
                <span className="ml-auto text-muted">{tasks.length}</span>
              </button>
              {visibleTasks.map((task) => {
                const repo = state.repos.find((r) => r.id === task.repoId);
                return (
                  <TaskTab
                    key={task.id}
                    task={task}
                    repoName={repo ? repoDisplayName(repo) : shortPath(task.worktreePath)}
                    isActive={task.id === state.activeTaskId}
                    onClick={() => dispatch({ type: 'SET_ACTIVE_TASK', taskId: task.id })}
                    onClose={() => {
                      window.bifrost.stopTask(task.id).then((updated) => {
                        dispatch({ type: 'UPDATE_TASK', task: updated });
                        if (state.activeTaskId === task.id) {
                          const next = sorted.find((t) => t.id !== task.id);
                          dispatch({
                            type: 'SET_ACTIVE_TASK',
                            taskId: next ? next.id : null,
                          });
                        }
                      });
                    }}
                    onRename={(name) => {
                      window.bifrost.renameTask(task.id, name).then((updated) => {
                        dispatch({ type: 'UPDATE_TASK', task: updated });
                      });
                    }}
                    isPinned={pinnedIds.includes(task.id)}
                    onTogglePin={() => togglePin(task.id)}
                    onRegenerateTitle={async () => {
                      try {
                        const result = await window.bifrost.regenerateTaskTitle(task.id);
                        if (!result) {
                          dispatch({ type: 'SHOW_TOAST', message: 'No transcript to generate a title from' });
                          return;
                        }
                        dispatch({ type: 'UPDATE_TASK', task: result.task });
                        dispatch({
                          type: 'SHOW_TOAST',
                          message: result.renamedBranch
                            ? `Renamed to "${result.task.name}" on ${result.renamedBranch}`
                            : `Renamed to "${result.task.name}"`,
                        });
                      } catch {
                        dispatch({ type: 'SHOW_TOAST', message: 'Title generation failed' });
                      }
                    }}
                  />
                );
              })}
            </div>
          );
        })}
      </div>
      <div
        onMouseDown={(e) => {
          e.preventDefault();
          const startX = e.clientX;
          const startWidth = width;
          const onMove = (ev: MouseEvent) => {
            setDragWidth(Math.min(480, Math.max(160, startWidth + ev.clientX - startX)));
          };
          const onUp = () => {
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
            setDragWidth((w) => {
              if (w != null && config) {
                const updated = { ...config, sidebarWidth: w };
                dispatch({ type: 'SET_CONFIG', config: updated });
                window.bifrost.saveConfig(updated);
              }
              return null;
            });
          };
          window.addEventListener('mousemove', onMove);
          window.addEventListener('mouseup', onUp);
        }}
        className="absolute top-0 right-0 bottom-0 w-1 cursor-col-resize hover:bg-accent/40 transition-colors"
      />
    </div>
  );
}
