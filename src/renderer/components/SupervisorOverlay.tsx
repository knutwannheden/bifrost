import React, { useEffect, useRef, useState } from 'react';
import { useApp } from '../context/AppContext';
import type { SupervisorState, SupervisorItem } from '../../shared/types';
import Spinner from './Spinner';
import { formatTime } from '../utils/format-time';

function ItemRow({ item, repoName, onAction }: {
  item: SupervisorItem;
  repoName: string;
  onAction: (action: string, itemId: string) => void;
}) {
  return (
    <div className="flex items-start gap-2 px-3 py-2 rounded hover:bg-slate-700/50 group">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-500">{item.name}</span>
          <span className="text-xs text-slate-600">{repoName}</span>
        </div>
        <div className="text-sm text-slate-300 truncate">{item.noteText}</div>
        {item.errorMessage && (
          <div className="text-xs text-red-400 truncate mt-0.5">{item.errorMessage}</div>
        )}
      </div>
      <div className="flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
        {item.status === 'running' && (
          <button
            onClick={() => onAction('pause', item.id)}
            className="text-xs text-slate-400 hover:text-slate-200 px-1.5 py-0.5 rounded bg-slate-700 hover:bg-slate-600"
          >
            Pause
          </button>
        )}
        {item.status === 'paused' && (
          <button
            onClick={() => onAction('resume', item.id)}
            className="text-xs text-slate-400 hover:text-slate-200 px-1.5 py-0.5 rounded bg-slate-700 hover:bg-slate-600"
          >
            Resume
          </button>
        )}
        {(item.status === 'done' || item.status === 'error' || item.status === 'paused') && (
          <button
            onClick={() => onAction('open', item.id)}
            className="text-xs text-blue-400 hover:text-blue-300 px-1.5 py-0.5 rounded bg-slate-700 hover:bg-slate-600"
          >
            Open
          </button>
        )}
        {item.status !== 'running' && item.status !== 'opened' && (
          <button
            onClick={() => onAction('remove', item.id)}
            className="text-xs text-slate-500 hover:text-red-400 px-1.5 py-0.5 rounded bg-slate-700 hover:bg-slate-600"
          >
            &times;
          </button>
        )}
      </div>
      <span className="text-xs text-slate-600 whitespace-nowrap shrink-0">
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

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };

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

  return (
    <div
      className="absolute inset-0 z-20 flex items-center justify-center bg-overlay"
      onClick={close}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        className="bg-slate-800 rounded-lg border border-slate-600 w-[640px] flex flex-col shadow-xl max-h-[80vh] outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-slate-700">
          <span className="text-sm font-medium text-slate-200">Supervisor</span>
          {svState?.running && <Spinner />}
          {svState && svState.items.length > 0 && (
            <span className="text-xs text-slate-500">
              {running.length} running · {queued.length} queued · {done.length} done
            </span>
          )}
          <div className="flex-1" />

          {/* Concurrency */}
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-slate-500">Concurrency</span>
            <button
              onClick={() => handleConcurrency(-1)}
              className="w-5 h-5 flex items-center justify-center rounded text-slate-400 hover:text-slate-200 hover:bg-slate-700 text-sm"
            >
              &minus;
            </button>
            <span className="text-xs text-slate-300 w-4 text-center">{svState?.concurrency ?? 2}</span>
            <button
              onClick={() => handleConcurrency(1)}
              className="w-5 h-5 flex items-center justify-center rounded text-slate-400 hover:text-slate-200 hover:bg-slate-700 text-sm"
            >
              +
            </button>
          </div>

          {/* Start/Stop */}
          <button
            onClick={handleToggle}
            className={`text-xs px-2.5 py-1 rounded ${
              svState?.running
                ? 'bg-red-500/20 text-red-400 hover:bg-red-500/30'
                : 'bg-green-500/20 text-green-400 hover:bg-green-500/30'
            }`}
          >
            {svState?.running ? 'Stop' : 'Start'}
          </button>

          <button
            onClick={close}
            tabIndex={-1}
            className="text-slate-400 hover:text-slate-200 text-lg leading-none ml-1"
          >
            &times;
          </button>
        </div>

        {/* Body */}
        <div className="overflow-y-auto flex-1 min-h-0 p-2">
          {!svState || svState.items.length === 0 ? (
            <div className="px-2 py-8 text-sm text-slate-500 text-center">
              {svState?.running ? 'No notes found across repos' : 'Press Start to queue notes for processing'}
            </div>
          ) : (
            <>
              {running.length > 0 && (
                <Section title="Running" count={running.length}>
                  {running.map((item) => (
                    <ItemRow key={item.id} item={item} repoName={repoMap.get(item.repoId) ?? '?'} onAction={handleAction} />
                  ))}
                </Section>
              )}
              {queued.length > 0 && (
                <Section title="Queued" count={queued.length}>
                  {queued.map((item) => (
                    <ItemRow key={item.id} item={item} repoName={repoMap.get(item.repoId) ?? '?'} onAction={handleAction} />
                  ))}
                </Section>
              )}
              {done.length > 0 && (
                <Section title="Done" count={done.length}>
                  {done.map((item) => (
                    <ItemRow key={item.id} item={item} repoName={repoMap.get(item.repoId) ?? '?'} onAction={handleAction} />
                  ))}
                </Section>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 pb-3 pt-2 border-t border-slate-700">
          <p className="text-xs text-slate-500">
            Start scans all repos for notes and queues them for processing
          </p>
        </div>
      </div>
    </div>
  );
}

function Section({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return (
    <div className="mb-2">
      <div className="flex items-center gap-2 px-3 py-1">
        <span className="text-xs font-medium text-slate-400 uppercase tracking-wider">{title}</span>
        <span className="text-xs text-slate-600">{count}</span>
      </div>
      {children}
    </div>
  );
}
