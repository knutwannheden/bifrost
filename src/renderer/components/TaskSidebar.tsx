import { useEffect, useState } from 'react';
import { useApp } from '../context/AppContext';
import { repoDisplayName, shortPath } from '../utils/paths';
import { getTimeBucket, TIME_BUCKETS } from '../utils/time-buckets';
import TaskTab from './TaskTab';

const DEFAULT_WIDTH = 240;
// Anything older than the current week starts folded, so dormant work costs
// one line per group rather than one line per task.
const DEFAULT_COLLAPSED = ['This week', 'Last week', 'This month', 'Older'];

export default function TaskSidebar() {
  const { state, dispatch } = useApp();
  const [mtimes, setMtimes] = useState<Record<string, number>>({});

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

  const groups = new Map<string, typeof sorted>();
  for (const task of sorted) {
    const bucket = getTimeBucket(recency(task.id, task.createdAt));
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

  // The active task's group always renders expanded, even if folded, so the
  // highlighted row stays visible; collapsedBuckets itself is untouched so the
  // fold preference survives switching away from that task.
  const activeTask = sorted.find((t) => t.id === state.activeTaskId);
  const activeBucket = activeTask ? getTimeBucket(recency(activeTask.id, activeTask.createdAt)) : null;

  if (openTasks.length === 0) return null;

  return (
    <div
      className="flex flex-col shrink-0 overflow-y-auto bg-surface/50 border-r border-border-default"
      style={{ width }}
    >
      {TIME_BUCKETS.filter((b) => groups.has(b)).map((bucket) => {
        const tasks = groups.get(bucket) ?? [];
        const isCollapsed = collapsed.includes(bucket) && bucket !== activeBucket;
        return (
          <div key={bucket}>
            <button
              type="button"
              onClick={() => toggle(bucket)}
              className="flex w-full items-center gap-1 px-2 py-1 text-xs font-semibold text-secondary uppercase tracking-wider hover:text-primary transition-colors"
            >
              <span className="w-3 shrink-0">{isCollapsed ? '▸' : '▾'}</span>
              <span className="truncate">{bucket}</span>
              <span className="ml-auto text-muted">{tasks.length}</span>
            </button>
            {!isCollapsed &&
              tasks.map((task) => {
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
                          const remaining = openTasks.filter((t) => t.id !== task.id);
                          dispatch({
                            type: 'SET_ACTIVE_TASK',
                            taskId: remaining.length > 0 ? remaining[0].id : null,
                          });
                        }
                      });
                    }}
                    onRename={(name) => {
                      window.bifrost.renameTask(task.id, name).then((updated) => {
                        dispatch({ type: 'UPDATE_TASK', task: updated });
                      });
                    }}
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
  );
}
