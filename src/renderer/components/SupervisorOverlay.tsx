import React, { useEffect, useRef, useState } from 'react';
import { useApp } from '../context/AppContext';
import type { SupervisorState, SupervisorItem } from '../../shared/types';
import { altSymbol } from '../utils/platform';
import ActionLabel from './ActionLabel';
import Spinner from './Spinner';
import { formatTime } from '../utils/format-time';

function ItemRow({ item, repoName, onAction, focused }: {
  item: SupervisorItem;
  repoName: string;
  onAction: (action: string, itemId: string) => void;
  focused?: boolean;
}) {
  return (
    <div className={`flex items-start gap-2 px-3 py-2 rounded group ${focused ? 'bg-surface-alt/50' : 'hover:bg-surface-alt/50'}`}>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted">{item.name}</span>
          <span className="text-xs text-faint">{repoName}</span>
        </div>
        <div className="text-sm text-secondary truncate">{item.noteText}</div>
        {item.errorMessage && (
          <div className="text-xs text-danger truncate mt-0.5">{item.errorMessage}</div>
        )}
      </div>
      <div className={`flex items-center gap-1 shrink-0 transition-opacity ${focused ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}>
        {item.status === 'running' && (
          <button
            onClick={() => onAction('pause', item.id)}
            className="text-xs text-secondary hover:text-primary px-1.5 py-0.5 rounded bg-surface-alt hover:bg-surface-hover"
          >
            Pause
          </button>
        )}
        {item.status === 'paused' && (
          <button
            onClick={() => onAction('resume', item.id)}
            className="text-xs text-secondary hover:text-primary px-1.5 py-0.5 rounded bg-surface-alt hover:bg-surface-hover"
          >
            Resume
          </button>
        )}
        {(item.status === 'done' || item.status === 'error' || item.status === 'paused') && (
          <button
            onClick={() => onAction('open', item.id)}
            className="text-xs text-accent-hover hover:brightness-125 px-1.5 py-0.5 rounded bg-surface-alt hover:bg-surface-hover"
          >
            Open
          </button>
        )}
        {item.status !== 'running' && item.status !== 'opened' && (
          <button
            onClick={() => onAction('remove', item.id)}
            className="text-xs text-muted hover:text-danger px-1.5 py-0.5 rounded bg-surface-alt hover:bg-surface-hover"
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

export default function SupervisorOverlay() {
  const { state: appState, dispatch } = useApp();
  const [svState, setSvState] = useState<SupervisorState | null>(null);

  const panelRef = useRef<HTMLDivElement>(null);
  const close = () => dispatch({ type: 'TOGGLE_SUPERVISOR' });

  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  useEffect(() => {
    window.bifrost.getSupervisorState().then(setSvState);
    const unsub = window.bifrost.onSupervisorUpdate(setSvState);
    return unsub;
  }, []);

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

  const repoMap = new Map(appState.repos.map((r) => [r.id, r.name]));

  const queued = svState?.items.filter((i) => i.status === 'queued') ?? [];
  const running = svState?.items.filter((i) => i.status === 'running') ?? [];
  const done = svState?.items.filter((i) =>
    i.status === 'done' || i.status === 'error' || i.status === 'paused',
  ) ?? [];

  const allItems = [...running, ...queued, ...done];
  const [focusedIdx, setFocusedIdx] = useState(-1);
  const focusedItem = focusedIdx >= 0 && focusedIdx < allItems.length ? allItems[focusedIdx] : null;

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }

    // Arrow Up/Down: navigate items
    if (e.key === 'ArrowDown' && allItems.length > 0) {
      e.preventDefault();
      setFocusedIdx((i) => (i < allItems.length - 1 ? i + 1 : 0));
      return;
    }
    if (e.key === 'ArrowUp' && allItems.length > 0) {
      e.preventDefault();
      setFocusedIdx((i) => (i > 0 ? i - 1 : allItems.length - 1));
      return;
    }

    // Enter: open focused item (if done/error/paused)
    if (e.key === 'Enter' && focusedItem) {
      const s = focusedItem.status;
      if (s === 'done' || s === 'error' || s === 'paused') {
        e.preventDefault();
        handleAction('open', focusedItem.id);
      }
      return;
    }

    // Alt shortcuts
    if (e.altKey) {
      switch (e.code) {
        case 'KeyS':
          e.preventDefault();
          handleToggle();
          break;
        case 'Minus':
          e.preventDefault();
          handleConcurrency(-1);
          break;
        case 'Equal':
          e.preventDefault();
          handleConcurrency(1);
          break;
      }
    }
  };

  return (
    <div
      className="absolute inset-0 z-20 flex items-center justify-center bg-overlay focus:outline-none"
      onClick={close}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        className="bg-surface rounded-lg border border-border-input w-[640px] flex flex-col shadow-xl max-h-[80vh] outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border-default">
          <span className="text-sm font-medium text-primary">Supervisor</span>
          {svState?.running && <Spinner />}
          {svState && svState.items.length > 0 && (
            <span className="text-xs text-muted">
              {running.length} running · {queued.length} queued · {done.length} done
            </span>
          )}
          <div className="flex-1" />

          {/* Concurrency */}
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-muted">Concurrency</span>
            <button
              onClick={() => handleConcurrency(-1)}
              className="w-5 h-5 flex items-center justify-center rounded text-secondary hover:text-primary hover:bg-surface-alt text-sm"
            >
              &minus;
            </button>
            <span className="text-xs text-secondary w-4 text-center">{svState?.concurrency ?? 2}</span>
            <button
              onClick={() => handleConcurrency(1)}
              className="w-5 h-5 flex items-center justify-center rounded text-secondary hover:text-primary hover:bg-surface-alt text-sm"
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
            }`}
          >
            <ActionLabel text={svState?.running ? 'Stop' : 'Start'} showHint={true} />
          </button>

          <button
            onClick={close}
            tabIndex={-1}
            className="text-secondary hover:text-primary text-lg leading-none ml-1"
          >
            &times;
          </button>
        </div>

        {/* Body */}
        <div className="overflow-y-auto flex-1 min-h-0 p-2">
          {!svState || svState.items.length === 0 ? (
            <div className="px-2 py-8 text-sm text-muted text-center">
              {svState?.running ? 'No notes found across repos' : 'Press Start to queue notes for processing'}
            </div>
          ) : (
            <>
              {running.length > 0 && (
                <Section title="Running" count={running.length}>
                  {running.map((item) => (
                    <ItemRow key={item.id} item={item} repoName={repoMap.get(item.repoId) ?? '?'} onAction={handleAction} focused={focusedItem?.id === item.id} />
                  ))}
                </Section>
              )}
              {queued.length > 0 && (
                <Section title="Queued" count={queued.length}>
                  {queued.map((item) => (
                    <ItemRow key={item.id} item={item} repoName={repoMap.get(item.repoId) ?? '?'} onAction={handleAction} focused={focusedItem?.id === item.id} />
                  ))}
                </Section>
              )}
              {done.length > 0 && (
                <Section title="Done" count={done.length}>
                  {done.map((item) => (
                    <ItemRow key={item.id} item={item} repoName={repoMap.get(item.repoId) ?? '?'} onAction={handleAction} focused={focusedItem?.id === item.id} />
                  ))}
                </Section>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 pb-3 pt-2 border-t border-border-default flex items-center justify-between">
          <span className="text-xs text-muted">
            Start scans all repos for notes and queues them for processing
          </span>
          <span className="text-xs text-faint">
            &uarr;&darr; navigate &middot; Enter open &middot; {altSymbol}S start/stop &middot; Esc close
          </span>
        </div>
      </div>
    </div>
  );
}

function Section({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return (
    <div className="mb-2">
      <div className="flex items-center gap-2 px-3 py-1">
        <span className="text-xs font-semibold text-secondary uppercase tracking-wider">{title}</span>
        <span className="text-xs text-faint">{count}</span>
      </div>
      {children}
    </div>
  );
}
