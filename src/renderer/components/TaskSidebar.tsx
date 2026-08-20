import { useEffect, useRef, useState } from 'react';
import { useApp } from '../context/AppContext';
import { useKeymap } from '../context/KeymapContext';
import { terminalRegistry } from '../hooks/useTerminal';
import { repoDisplayName, shortPath } from '../utils/paths';
import { matchesTaskSearch } from '../utils/search';
import { getTimeBucket, TIME_BUCKETS } from '../utils/time-buckets';
import FormInput from './FormInput';
import Kbd from './Kbd';
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
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState(0);
  const [filterFocused, setFilterFocused] = useState(false);
  const filterRef = useRef<HTMLInputElement>(null);
  const filterShortcut = useKeymap().getDisplayString('nav.filterTasks');

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

  // The nonce starts at 0, so the box is only focused on a deliberate request.
  useEffect(() => {
    if (state.sidebarFilterFocus === 0) return;
    filterRef.current?.focus();
    filterRef.current?.select();
  }, [state.sidebarFilterFocus]);

  const config = state.config;
  const collapsed = config?.collapsedBuckets ?? DEFAULT_COLLAPSED;
  const width = config?.sidebarWidth ?? DEFAULT_WIDTH;

  const openTasks = state.tasks.filter((t) => t.status === 'running');

  const recency = (id: string, createdAt: number) => mtimes[id] ?? createdAt;
  const sorted = [...openTasks].sort((a, b) => recency(b.id, b.createdAt) - recency(a.id, a.createdAt));

  const repoNameFor = (task: (typeof sorted)[number]) => {
    const repo = state.repos.find((r) => r.id === task.repoId);
    return repo ? repoDisplayName(repo) : shortPath(task.worktreePath);
  };

  const filtering = filter.trim().length > 0;
  const matchedIds = filtering
    ? new Set(sorted.filter((t) => matchesTaskSearch(t, repoNameFor(t), filter)).map((t) => t.id))
    : null;
  // Keeps the row you are looking at from vanishing as you type.
  const shown = matchedIds ? sorted.filter((t) => matchedIds.has(t.id) || t.id === state.activeTaskId) : sorted;

  const pinnedIds = config?.pinnedTaskIds ?? [];

  const groups = new Map<string, typeof sorted>();
  for (const task of shown) {
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

  // A filter overrides folds, since a hidden match defeats it, and an unfiltered
  // fold still shows the active task's row — so this is not simply "skip folded
  // buckets". Shared by the published order and the rendered rows below.
  const visibleTasksFor = (bucket: string) => {
    const tasks = groups.get(bucket) ?? [];
    if (filtering) return tasks;
    return collapsed.includes(bucket) ? tasks.filter((t) => t.id === state.activeTaskId) : tasks;
  };

  const visibleTaskIds = GROUPS.filter((b) => groups.has(b)).flatMap((b) => visibleTasksFor(b).map((t) => t.id));

  // The active task's row is listed whether or not it matches, and it usually
  // sorts first, so the cursor starts on the first real match instead.
  const firstMatch = matchedIds
    ? Math.max(
        0,
        visibleTaskIds.findIndex((id) => matchedIds.has(id)),
      )
    : 0;
  // The cursor only means something while the box has focus.
  const selectedId = filterFocused ? visibleTaskIds[Math.min(selected, visibleTaskIds.length - 1)] : undefined;
  useEffect(() => {
    setSelected(firstMatch);
  }, [filter]);

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

  const returnFocusToTerminal = () => {
    filterRef.current?.blur();
    const taskId = state.activeTaskId;
    if (!taskId) return;
    const ps = state.paneStates[taskId];
    terminalRegistry.get(ps?.focusedPane === 'dev' && ps.devSessionId ? ps.devSessionId : taskId)?.focus();
  };

  if (openTasks.length === 0) return null;

  return (
    <div
      className="relative flex flex-col shrink-0 bg-surface/50 border-r border-border-default"
      style={{ width: dragWidth ?? width }}
    >
      <div className="p-2 border-b border-border-default">
        <div className="relative">
          <FormInput
            ref={filterRef}
            value={filter}
            placeholder="Filter tasks…"
            className="w-full px-2 py-1 pr-11 text-xs"
            onChange={(e) => setFilter(e.target.value)}
            onFocus={() => setFilterFocused(true)}
            onBlur={() => setFilterFocused(false)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                const count = visibleTaskIds.length;
                if (count > 0) {
                  const step = e.key === 'ArrowDown' ? 1 : -1;
                  setSelected((i) => (Math.min(i, count - 1) + step + count) % count);
                }
              } else if (e.key === 'Enter') {
                if (selectedId) dispatch({ type: 'SET_ACTIVE_TASK', taskId: selectedId });
                setFilter('');
                returnFocusToTerminal();
              } else if (e.key === 'Escape') {
                setFilter('');
                returnFocusToTerminal();
              }
              // Modified strokes stay with the global keymap (Cmd+B, tab switching);
              // bare keys and F2 belong to the filter.
              if (!e.metaKey && !e.ctrlKey) e.stopPropagation();
            }}
          />
          {!filterFocused && !filter && filterShortcut ? (
            <span className="absolute right-1.5 top-1/2 -translate-y-1/2 pointer-events-none">
              <Kbd>{filterShortcut}</Kbd>
            </span>
          ) : null}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto">
        {filtering && groups.size === 0 ? (
          <div className="text-sm text-muted text-center py-4">No matching tasks</div>
        ) : null}
        {GROUPS.filter((b) => groups.has(b)).map((bucket) => {
          const tasks = groups.get(bucket) ?? [];
          const isCollapsed = !filtering && collapsed.includes(bucket);
          const visibleTasks = visibleTasksFor(bucket);
          const headerClass =
            'flex w-full items-center gap-1 px-2 py-1 bg-surface-alt text-xs font-semibold text-secondary uppercase tracking-wider';
          return (
            <div key={bucket}>
              {filtering ? (
                // A click here would rewrite a fold preference the filtered list ignores.
                <div className={headerClass}>
                  <span className="w-3 shrink-0" />
                  <span className="truncate">{bucket}</span>
                  <span className="ml-auto text-muted">{tasks.length}</span>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => toggle(bucket)}
                  className={`${headerClass} hover:bg-surface-hover hover:text-primary transition-colors`}
                >
                  <span className="w-3 shrink-0">{isCollapsed ? '▸' : '▾'}</span>
                  <span className="truncate">{bucket}</span>
                  <span className="ml-auto text-muted">{tasks.length}</span>
                </button>
              )}
              {visibleTasks.map((task) => (
                <TaskTab
                  key={task.id}
                  task={task}
                  repoName={repoNameFor(task)}
                  isActive={task.id === state.activeTaskId}
                  search={filter}
                  isSelected={task.id === selectedId}
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
              ))}
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
