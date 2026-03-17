import React, { useEffect, useRef, useState } from 'react';
import type {
  CuratorRunResult,
  CuratorState,
  SupervisorItem,
  SupervisorState,
  Task,
  TaskOutcome,
} from '../../shared/types';
import { useApp } from '../context/AppContext';
import { useOverlayFocus } from '../hooks/useOverlayFocus';
import { type TabDef, useTabMnemonics } from '../hooks/useTabMnemonics';
import { formatDate, formatRelative, formatTime } from '../utils/format-time';
import {
  allOutcomes,
  getTaskOutcome,
  outcomeBadgeColors,
  outcomeLabels,
  outcomeTextColors,
  taskStatusColor,
  taskStatusLabel,
} from '../utils/outcome';
import { altSymbol } from '../utils/platform';
import ActionLabel from './ActionLabel';
import CloseButton from './CloseButton';
import OverlayFooter from './OverlayFooter';
import PillToggle from './PillToggle';
import SectionHeader from './SectionHeader';
import Spinner from './Spinner';

type Tab = 'supervisor' | 'curator';

const TAB_DEFS: TabDef<Tab>[] = [
  { value: 'supervisor', label: 'Supervisor', hintIndex: 1 },
  { value: 'curator', label: 'Curator' },
];

// ── Supervisor tab ──────────────────────────────────────────────────────

function ItemRow({
  item,
  repoName,
  onAction,
  focused,
}: {
  item: SupervisorItem;
  repoName: string;
  onAction: (action: string, itemId: string) => void;
  focused?: boolean;
}) {
  return (
    <div
      className={`flex items-start gap-2 px-3 py-2 rounded-sm group transition-colors ${focused ? 'bg-surface-alt/50' : 'hover:bg-surface-alt/50'}`}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted">{item.name}</span>
          <span className="text-xs text-faint">{repoName}</span>
        </div>
        <div className="text-sm text-secondary truncate">{item.noteText}</div>
        {item.errorMessage && <div className="text-xs text-danger truncate mt-0.5">{item.errorMessage}</div>}
      </div>
      <div
        className={`flex items-center gap-1 shrink-0 transition-opacity ${focused ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
      >
        {item.status === 'running' && (
          <button
            onClick={() => onAction('pause', item.id)}
            className="text-xs text-secondary hover:text-primary px-1.5 py-0.5 rounded-sm bg-surface-alt hover:bg-surface-hover transition-colors"
          >
            Pause
          </button>
        )}
        {item.status === 'paused' && (
          <button
            onClick={() => onAction('resume', item.id)}
            className="text-xs text-secondary hover:text-primary px-1.5 py-0.5 rounded-sm bg-surface-alt hover:bg-surface-hover transition-colors"
          >
            Resume
          </button>
        )}
        {(item.status === 'done' || item.status === 'error' || item.status === 'paused') && (
          <button
            onClick={() => onAction('open', item.id)}
            className="text-xs text-accent-hover hover:brightness-125 px-1.5 py-0.5 rounded-sm bg-surface-alt hover:bg-surface-hover transition-colors"
          >
            Open
          </button>
        )}
        {item.status !== 'running' && item.status !== 'opened' && (
          <button
            onClick={() => onAction('remove', item.id)}
            className="text-xs text-muted hover:text-danger px-1.5 py-0.5 rounded-sm bg-surface-alt hover:bg-surface-hover transition-colors"
          >
            &times;
          </button>
        )}
      </div>
      <span className="text-xs text-faint whitespace-nowrap shrink-0">
        {formatTime(item.startedAt ?? item.createdAt)}
      </span>
    </div>
  );
}

function Section({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return (
    <div className="mb-2">
      <div className="flex items-center gap-2 px-3 py-1">
        <SectionHeader>{title}</SectionHeader>
        <span className="text-xs text-faint">{count}</span>
      </div>
      {children}
    </div>
  );
}

function SupervisorTab({
  svState,
  setSvState,
  repoMap,
  dispatch,
  focusedIdx,
}: {
  svState: SupervisorState | null;
  setSvState: (s: SupervisorState) => void;
  repoMap: Map<string, string>;
  dispatch: ReturnType<typeof useApp>['dispatch'];
  focusedIdx: number;
}) {
  const handleToggle = async () => {
    if (!svState) return;
    if (svState.running) {
      setSvState(await window.bifrost.stopSupervisor());
    } else {
      setSvState(await window.bifrost.startSupervisor());
    }
  };

  const handleConcurrency = async (delta: number) => {
    if (!svState) return;
    const n = Math.max(1, Math.min(svState.concurrency + delta, 10));
    setSvState(await window.bifrost.setSupervisorConcurrency(n));
  };

  const handleAction = async (action: string, itemId: string) => {
    switch (action) {
      case 'pause':
        setSvState(await window.bifrost.pauseSupervisorItem(itemId));
        break;
      case 'resume':
        setSvState(await window.bifrost.resumeSupervisorItem(itemId));
        break;
      case 'open': {
        const task = await window.bifrost.openSupervisorItem(itemId);
        dispatch({ type: 'ADD_TASK', task });
        dispatch({ type: 'SET_ACTIVE_TASK', taskId: task.id });
        break;
      }
      case 'remove':
        setSvState(await window.bifrost.removeSupervisorItem(itemId));
        break;
    }
  };

  const queued = svState?.items.filter((i) => i.status === 'queued') ?? [];
  const running = svState?.items.filter((i) => i.status === 'running') ?? [];
  const done = svState?.items.filter((i) => i.status === 'done' || i.status === 'error' || i.status === 'paused') ?? [];

  const allItems = [...running, ...queued, ...done];
  const focusedItem = focusedIdx >= 0 && focusedIdx < allItems.length ? allItems[focusedIdx] : null;

  return (
    <>
      {/* Supervisor header controls */}
      <div className="flex items-center gap-3 px-4 py-2 border-b border-border-default">
        {svState?.running && <Spinner />}
        {svState && svState.items.length > 0 && (
          <span className="text-xs text-muted">
            {running.length} running &middot; {queued.length} queued &middot; {done.length} done
          </span>
        )}
        <div className="flex-1" />

        {/* Concurrency */}
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-secondary">Concurrency</span>
          <button
            onClick={() => handleConcurrency(-1)}
            className="w-5 h-5 flex items-center justify-center rounded-sm text-secondary hover:text-primary hover:bg-surface-alt text-sm transition-colors"
          >
            &minus;
          </button>
          <span className="text-xs text-secondary w-4 text-center">{svState?.concurrency ?? 2}</span>
          <button
            onClick={() => handleConcurrency(1)}
            className="w-5 h-5 flex items-center justify-center rounded-sm text-secondary hover:text-primary hover:bg-surface-alt text-sm transition-colors"
          >
            +
          </button>
        </div>

        {/* Start/Stop */}
        <button
          onClick={handleToggle}
          className={`text-xs px-2.5 py-1 rounded ${
            svState?.running
              ? 'bg-danger/20 text-danger hover:bg-danger/30'
              : 'bg-success/20 text-success hover:bg-success/30'
          } transition-colors`}
        >
          <ActionLabel text={svState?.running ? 'Stop' : 'Start'} showHint={true} />
        </button>
      </div>

      {/* Body */}
      <div className="overflow-y-auto flex-1 min-h-0 p-2">
        {!svState || svState.items.length === 0 ? (
          <div className="text-sm text-muted text-center py-4">
            {svState?.running ? 'No notes found across repos' : 'Press Start to queue notes for processing'}
          </div>
        ) : (
          <>
            {running.length > 0 && (
              <Section title="Running" count={running.length}>
                {running.map((item) => (
                  <ItemRow
                    key={item.id}
                    item={item}
                    repoName={repoMap.get(item.repoId) ?? '?'}
                    onAction={handleAction}
                    focused={focusedItem?.id === item.id}
                  />
                ))}
              </Section>
            )}
            {queued.length > 0 && (
              <Section title="Queued" count={queued.length}>
                {queued.map((item) => (
                  <ItemRow
                    key={item.id}
                    item={item}
                    repoName={repoMap.get(item.repoId) ?? '?'}
                    onAction={handleAction}
                    focused={focusedItem?.id === item.id}
                  />
                ))}
              </Section>
            )}
            {done.length > 0 && (
              <Section title="Done" count={done.length}>
                {done.map((item) => (
                  <ItemRow
                    key={item.id}
                    item={item}
                    repoName={repoMap.get(item.repoId) ?? '?'}
                    onAction={handleAction}
                    focused={focusedItem?.id === item.id}
                  />
                ))}
              </Section>
            )}
          </>
        )}
      </div>
    </>
  );
}

// ── Curator tab ─────────────────────────────────────────────────────────

type CuratorFilter = 'unclassified' | 'pending' | 'all';

const curatorFilterOptions: PillOption<CuratorFilter>[] = [
  { value: 'unclassified', label: 'Unclassified' },
  { value: 'pending', label: 'Pending' },
  { value: 'all', label: 'All' },
];

function CuratorTaskRow({
  task,
  repoName,
  focused,
  onOutcome,
  onOpen,
}: {
  task: Task;
  repoName: string;
  focused: boolean;
  onOutcome: (taskId: string, outcome: TaskOutcome) => void;
  onOpen: (task: Task) => void;
}) {
  const outcome = getTaskOutcome(task);

  return (
    <div
      className={`rounded border p-3 transition-colors ${
        focused
          ? 'bg-surface-alt border-accent-muted ring-1 ring-accent-muted'
          : 'bg-surface-alt/50 border-border-input/50'
      }`}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <span className="text-sm font-medium text-primary truncate">{task.name}</span>
          <span className={`text-xs ${taskStatusColor[task.status]}`}>{taskStatusLabel[task.status]}</span>
          {task.curation && (
            <span
              className={`px-1.5 py-0.5 text-xs rounded-sm font-medium ${outcomeBadgeColors[task.curation.userOverride ?? task.curation.outcome]}`}
              title={task.curation.reason}
            >
              {outcomeLabels[task.curation.userOverride ?? task.curation.outcome]}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1 ml-2 shrink-0">
          <button
            onClick={() => onOpen(task)}
            className="px-1.5 py-0.5 text-xs text-accent-hover hover:brightness-125 hover:bg-surface-hover rounded-sm transition-colors"
          >
            Open
          </button>
        </div>
      </div>

      {task.summary && <div className="mt-1 text-xs text-muted truncate">{task.summary}</div>}

      <div className="flex items-center gap-3 mt-1.5 text-xs text-muted">
        <span>{repoName}</span>
        <span>{task.branch}</span>
        <span>{formatDate(task.createdAt)}</span>
        {task.archivedAt && <span>Archived {formatDate(task.archivedAt)}</span>}
      </div>

      {/* Outcome selector */}
      <div className="flex items-center gap-1 mt-2">
        {allOutcomes.map((o) => (
          <button
            key={o}
            onClick={() => onOutcome(task.id, o)}
            className={`px-2 py-0.5 text-xs rounded-sm transition-colors ${
              outcome === o
                ? `${outcomeBadgeColors[o]} font-medium`
                : 'text-muted hover:text-secondary hover:bg-surface-hover'
            }`}
          >
            {outcomeLabels[o]}
          </button>
        ))}
      </div>
    </div>
  );
}

function CuratorResultRow({ result }: { result: CuratorRunResult }) {
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 text-xs">
      <span className="text-secondary truncate">{result.taskName}</span>
      <span
        className={`px-1.5 py-0.5 rounded-sm font-medium ${
          result.action === 'auto-archived'
            ? 'bg-secondary/15 text-secondary'
            : result.outcome
              ? outcomeBadgeColors[result.outcome]
              : 'text-muted'
        }`}
      >
        {result.action === 'auto-archived'
          ? 'Auto-archived'
          : result.outcome
            ? outcomeLabels[result.outcome]
            : 'Classified'}
      </span>
      {result.reason && <span className="text-muted truncate">{result.reason}</span>}
      <span className="text-faint ml-auto shrink-0">{formatTime(result.timestamp)}</span>
    </div>
  );
}

function CuratorTab({
  tasks,
  repoMap,
  dispatch,
  focusedIdx,
  onFilteredCount,
}: {
  tasks: Task[];
  repoMap: Map<string, string>;
  dispatch: ReturnType<typeof useApp>['dispatch'];
  focusedIdx: number;
  onFilteredCount: (count: number) => void;
}) {
  const [curatorFilter, setCuratorFilter] = useState<CuratorFilter>('unclassified');
  const [curState, setCurState] = useState<CuratorState | null>(null);

  useEffect(() => {
    window.bifrost.getCuratorState().then(setCurState);
    const unsub = window.bifrost.onCuratorUpdate((_taskId, _curation) => {
      // Refresh curator state when any task is curated
      window.bifrost.getCuratorState().then(setCurState);
    });
    return unsub;
  }, []);

  const handleRunNow = async () => {
    await window.bifrost.runCuratorNow();
    const fresh = await window.bifrost.getCuratorState();
    setCurState(fresh);
  };

  const handleOutcome = async (taskId: string, outcome: TaskOutcome) => {
    try {
      const updated = await window.bifrost.setCuratorOutcome(taskId, outcome);
      dispatch({ type: 'UPDATE_TASK', task: updated });
    } catch {
      // ignore
    }
  };

  const handleOpen = (task: Task) => {
    if (task.status === 'running') {
      dispatch({ type: 'SET_ACTIVE_TASK', taskId: task.id });
    } else {
      window.bifrost.reopenTask(task.id).then((updated) => {
        dispatch({ type: 'UPDATE_TASK', task: updated });
        dispatch({ type: 'SET_ACTIVE_TASK', taskId: updated.id });
      });
    }
    dispatch({ type: 'TOGGLE_SUPERVISOR' });
  };

  const curatable = tasks.filter((t) => t.status === 'stopped' || t.status === 'archived');
  const filtered = curatable.filter((t) => {
    const outcome = getTaskOutcome(t);
    if (curatorFilter === 'unclassified') return outcome === 'unclassified';
    if (curatorFilter === 'pending') return outcome === 'pending';
    return true;
  });

  // Report filtered count to parent for keyboard navigation
  useEffect(() => {
    onFilteredCount(filtered.length);
  }, [filtered.length, onFilteredCount]);

  const unclassifiedCount = curatable.filter((t) => getTaskOutcome(t) === 'unclassified').length;
  const pendingCount = curatable.filter((t) => getTaskOutcome(t) === 'pending').length;
  const mergedCount = curatable.filter((t) => getTaskOutcome(t) === 'merged').length;
  const abandonedCount = curatable.filter((t) => getTaskOutcome(t) === 'abandoned').length;

  return (
    <>
      {/* Filter bar */}
      <div className="flex items-center gap-3 px-4 py-2 border-b border-border-default">
        <PillToggle
          options={curatorFilterOptions}
          value={curatorFilter}
          onChange={(v) => setCuratorFilter(v)}
          size="sm"
        />
        <div className="flex-1" />
        <div className="flex items-center gap-3 text-xs text-muted">
          <span className={outcomeTextColors.unclassified}>{unclassifiedCount} unclassified</span>
          <span className={outcomeTextColors.pending}>{pendingCount} pending</span>
          <span className={outcomeTextColors.merged}>{mergedCount} merged</span>
          <span className={outcomeTextColors.abandoned}>{abandonedCount} abandoned</span>
        </div>
        <button
          onClick={handleRunNow}
          className="text-xs px-2.5 py-1 rounded bg-accent/20 text-accent hover:bg-accent/30 transition-colors"
        >
          Run now
        </button>
      </div>

      {/* Task list */}
      <div className="overflow-y-auto flex-1 min-h-0 p-4 space-y-2">
        {filtered.length === 0 ? (
          <div className="text-sm text-muted text-center py-4">
            {curatorFilter === 'unclassified'
              ? 'No unclassified tasks. All tasks have been curated.'
              : curatorFilter === 'pending'
                ? 'No pending tasks.'
                : 'No stopped or archived tasks to curate.'}
          </div>
        ) : (
          filtered.map((task, idx) => (
            <CuratorTaskRow
              key={task.id}
              task={task}
              repoName={repoMap.get(task.repoId) ?? '?'}
              focused={idx === focusedIdx}
              onOutcome={handleOutcome}
              onOpen={handleOpen}
            />
          ))
        )}

        {/* Last run results */}
        {curState && curState.lastRunResults.length > 0 && (
          <div className="mt-4">
            <SectionHeader className="px-1 pb-1">
              Last run {curState.lastRunAt ? formatRelative(curState.lastRunAt) : ''}
            </SectionHeader>
            {curState.lastRunResults.map((result) => (
              <CuratorResultRow key={`${result.taskId}-${result.timestamp}`} result={result} />
            ))}
          </div>
        )}
      </div>
    </>
  );
}

// ── Main overlay ────────────────────────────────────────────────────────

export default function SupervisorOverlay() {
  const { state: appState, dispatch } = useApp();
  const [tab, setTab] = useState<Tab>('supervisor');
  const { options: tabOptions, handleTabKey } = useTabMnemonics(TAB_DEFS, tab, setTab);
  const [svState, setSvState] = useState<SupervisorState | null>(null);
  const [svFocusedIdx, setSvFocusedIdx] = useState(-1);
  const [curFocusedIdx, setCurFocusedIdx] = useState(0);
  const curFilteredCountRef = useRef(0);

  const panelRef = useRef<HTMLDivElement>(null);
  const close = () => dispatch({ type: 'TOGGLE_SUPERVISOR' });

  useOverlayFocus(panelRef);

  useEffect(() => {
    window.bifrost.getSupervisorState().then(setSvState);
    const unsub = window.bifrost.onSupervisorUpdate(setSvState);
    return unsub;
  }, []);

  const repoMap = new Map(appState.repos.map((r) => [r.id, r.name]));

  const allSvItems = (() => {
    if (!svState) return [];
    const running = svState.items.filter((i) => i.status === 'running');
    const queued = svState.items.filter((i) => i.status === 'queued');
    const done = svState.items.filter((i) => i.status === 'done' || i.status === 'error' || i.status === 'paused');
    return [...running, ...queued, ...done];
  })();

  const svFocusedItem = svFocusedIdx >= 0 && svFocusedIdx < allSvItems.length ? allSvItems[svFocusedIdx] : null;

  const handleSvToggle = async () => {
    if (!svState) return;
    if (svState.running) {
      setSvState(await window.bifrost.stopSupervisor());
    } else {
      setSvState(await window.bifrost.startSupervisor());
    }
  };

  const handleSvConcurrency = async (delta: number) => {
    if (!svState) return;
    const n = Math.max(1, Math.min(svState.concurrency + delta, 10));
    setSvState(await window.bifrost.setSupervisorConcurrency(n));
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }

    if (handleTabKey(e)) return;

    if (tab === 'supervisor') {
      // Arrow Up/Down: navigate items
      if (e.key === 'ArrowDown' && allSvItems.length > 0) {
        e.preventDefault();
        setSvFocusedIdx((i) => (i < allSvItems.length - 1 ? i + 1 : 0));
        return;
      }
      if (e.key === 'ArrowUp' && allSvItems.length > 0) {
        e.preventDefault();
        setSvFocusedIdx((i) => (i > 0 ? i - 1 : allSvItems.length - 1));
        return;
      }

      // Enter: open focused item (if done/error/paused)
      if (e.key === 'Enter' && svFocusedItem) {
        const s = svFocusedItem.status;
        if (s === 'done' || s === 'error' || s === 'paused') {
          e.preventDefault();
          window.bifrost.openSupervisorItem(svFocusedItem.id).then((task) => {
            dispatch({ type: 'ADD_TASK', task });
            dispatch({ type: 'SET_ACTIVE_TASK', taskId: task.id });
          });
        }
        return;
      }

      // Alt shortcuts
      if (e.altKey) {
        switch (e.code) {
          case 'KeyS':
            e.preventDefault();
            handleSvToggle();
            break;
          case 'Minus':
            e.preventDefault();
            handleSvConcurrency(-1);
            break;
          case 'Equal':
            e.preventDefault();
            handleSvConcurrency(1);
            break;
        }
      }
    }

    if (tab === 'curator') {
      const count = curFilteredCountRef.current;
      if (e.key === 'ArrowDown' && count > 0) {
        e.preventDefault();
        setCurFocusedIdx((i) => (i < count - 1 ? i + 1 : 0));
        return;
      }
      if (e.key === 'ArrowUp' && count > 0) {
        e.preventDefault();
        setCurFocusedIdx((i) => (i > 0 ? i - 1 : count - 1));
        return;
      }
    }
  };

  return (
    <div
      className="absolute inset-0 z-20 flex items-center justify-center bg-overlay focus:outline-hidden"
      onClick={close}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        className="bg-surface rounded-lg border border-border-input w-[720px] flex flex-col shadow-xl max-h-[80vh] outline-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border-default">
          <PillToggle options={tabOptions} value={tab} onChange={(v) => setTab(v)} size="md" />
          <div className="flex-1" />
          <CloseButton onClick={close} />
        </div>

        {/* Tab content */}
        {tab === 'supervisor' ? (
          <SupervisorTab
            svState={svState}
            setSvState={setSvState}
            repoMap={repoMap}
            dispatch={dispatch}
            focusedIdx={svFocusedIdx}
          />
        ) : (
          <CuratorTab
            tasks={appState.tasks}
            repoMap={repoMap}
            dispatch={dispatch}
            focusedIdx={curFocusedIdx}
            onFilteredCount={(count) => {
              curFilteredCountRef.current = count;
            }}
          />
        )}

        {/* Footer */}
        <OverlayFooter>
          <span className="text-xs text-faint">
            {tab === 'supervisor' ? (
              <>
                &uarr;&darr; navigate &middot; Enter open &middot; {altSymbol}S start/stop &middot; {altSymbol}+/&minus;
                concurrency &middot; Esc close
              </>
            ) : (
              <>&uarr;&darr; navigate &middot; Esc close</>
            )}
          </span>
        </OverlayFooter>
      </div>
    </div>
  );
}
