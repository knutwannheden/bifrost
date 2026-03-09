import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { TriageEntry } from '../../shared/types';
import type { TriageItem, TriageTab } from '../context/AppContext';
import { useApp } from '../context/AppContext';
import { useInstantSearch } from '../hooks/useInstantSearch';
import { formatTime } from '../utils/format-time';
import { altSymbol } from '../utils/platform';
import ActionLabel from './ActionLabel';
import Highlight from './Highlight';
import PillToggle from './PillToggle';
import SearchIndicator from './SearchIndicator';
import Spinner from './Spinner';
import TerminalPane from './TerminalPane';

const tabOptions: { value: TriageTab; label: string }[] = [
  { value: 'new', label: 'New' },
  { value: 'history', label: 'History' },
];

/** A single running triage card in the "New" tab. */
function TriageCard({
  id,
  item,
  interactiveId,
  onEnter,
  onCancel,
  onBack,
  showAlt,
}: {
  id: string;
  item: TriageItem;
  interactiveId: string | null;
  onEnter: (id: string) => void;
  onCancel: (id: string) => void;
  onBack: (id: string) => void;
  showAlt: boolean;
}) {
  const isInteractive = interactiveId === id;

  if (isInteractive) {
    return (
      <div className="flex flex-col flex-1 min-h-0">
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border-default">
          <button
            onClick={() => onBack(id)}
            className="px-2 py-0.5 text-xs text-secondary hover:text-primary transition-colors"
          >
            <ActionLabel text="Back" hintIndex={0} showHint={showAlt} />
          </button>
          <span className="text-xs text-secondary truncate flex-1">{item.prompt}</span>
          {item.waiting && (
            <span className="px-1.5 py-0.5 text-[10px] font-medium bg-amber-500/20 text-amber-400 rounded">
              Waiting
            </span>
          )}
        </div>
        <div className="flex-1 min-h-0">
          <TerminalPane sessionId={item.ptySessionId!} active focused hideCursor={false} />
        </div>
      </div>
    );
  }

  const lastActivity = item.activity.length > 0 ? item.activity[item.activity.length - 1] : null;

  return (
    <div className="border border-border-default rounded-lg bg-surface-alt p-3">
      <div className="flex items-center gap-2 mb-2">
        {item.status === 'running' && <Spinner size="sm" />}
        {item.status === 'done' && <span className="text-green-400 text-xs">✓</span>}
        {item.status === 'error' && <span className="text-danger text-xs">✗</span>}
        <span className="text-xs text-primary truncate flex-1">{item.prompt}</span>
        {item.waiting && (
          <span className="px-1.5 py-0.5 text-[10px] font-medium bg-amber-500/20 text-amber-400 rounded">Waiting</span>
        )}
      </div>
      {lastActivity && <div className="text-xs text-muted truncate mb-2">{lastActivity}</div>}
      <div className="flex items-center gap-2">
        {item.status === 'running' && (
          <>
            <button
              onClick={() => onEnter(id)}
              className="px-2 py-0.5 text-xs bg-accent hover:bg-accent-hover text-white rounded transition-colors"
            >
              <ActionLabel text="Enter" hintIndex={0} showHint={showAlt} />
            </button>
            <button
              onClick={() => onCancel(id)}
              className="px-2 py-0.5 text-xs text-secondary hover:text-danger transition-colors"
            >
              <ActionLabel text="Cancel" hintIndex={0} showHint={showAlt} />
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/** A history row for completed triages. */
function HistoryRow({ entry, search }: { entry: TriageEntry; search: string }) {
  const statusColor =
    entry.status === 'done'
      ? 'text-green-400'
      : entry.status === 'error'
        ? 'text-danger'
        : entry.status === 'cancelled'
          ? 'text-muted'
          : 'text-accent';

  const statusLabel =
    entry.status === 'done' ? '✓' : entry.status === 'error' ? '✗' : entry.status === 'cancelled' ? '—' : '…';

  return (
    <div className="flex items-center gap-3 px-3 py-2 hover:bg-surface-hover transition-colors rounded">
      <span className={`text-xs ${statusColor} w-4 text-center`}>{statusLabel}</span>
      <span className="text-xs text-primary truncate flex-1">
        <Highlight text={entry.prompt} search={search} />
      </span>
      {entry.taskIds && entry.taskIds.length > 0 && (
        <span className="text-[10px] text-muted">{entry.taskIds.length} task(s)</span>
      )}
      <span className="text-xs text-muted shrink-0">{formatTime(entry.createdAt)}</span>
    </div>
  );
}

export default function TriageOverlay() {
  const { state, dispatch } = useApp();
  const panelRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [interactiveId, setInteractiveId] = useState<string | null>(null);
  const [altHeld, setAltHeld] = useState(false);

  const { search, searchVisible, handleSearchKey, clearSearch } = useInstantSearch();

  const triageEntries = Object.entries(state.triages);
  const hasRunning = triageEntries.some(([, t]) => t.status === 'running');

  // Load history when History tab is selected
  useEffect(() => {
    if (state.triageTab === 'history') {
      window.bifrost.listTriages().then((history) => {
        dispatch({ type: 'SET_TRIAGE_HISTORY', history });
      });
    }
  }, [state.triageTab, dispatch]);

  // Focus panel on mount
  useEffect(() => {
    if (!interactiveId) {
      panelRef.current?.focus();
    }
  }, [interactiveId]);

  const close = useCallback(() => {
    if (interactiveId) {
      setInteractiveId(null);
      return;
    }
    dispatch({ type: 'CLOSE_TRIAGE' });
  }, [interactiveId, dispatch]);

  const handleStart = useCallback(async () => {
    const prompt = state.triageDraftPrompt.trim();
    if (!prompt) return;
    const { triageId, ptySessionId } = await window.bifrost.startTriage(prompt);
    dispatch({
      type: 'ADD_TRIAGE',
      id: triageId,
      item: {
        prompt,
        status: 'running',
        ptySessionId,
        activity: [],
        waiting: false,
        expanded: true,
      },
    });
    dispatch({ type: 'SET_TRIAGE_DRAFT_PROMPT', prompt: '' });
  }, [state.triageDraftPrompt, dispatch]);

  const handleCancel = useCallback(
    async (id: string) => {
      await window.bifrost.cancelTriage(id);
      dispatch({ type: 'UPDATE_TRIAGE', id, updates: { status: 'error' } });
    },
    [dispatch],
  );

  const handleEnter = useCallback((id: string) => {
    setInteractiveId(id);
  }, []);

  const handleBack = useCallback((_id: string) => {
    setInteractiveId(null);
  }, []);

  // Track Alt key
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === 'Alt') setAltHeld(true);
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === 'Alt') setAltHeld(false);
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // Esc to close
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close();
        return;
      }

      // In interactive mode, only handle Alt+B for back
      if (interactiveId) {
        if (e.altKey && e.key.toLowerCase() === 'b') {
          e.preventDefault();
          setInteractiveId(null);
        }
        return;
      }

      // History tab: handle instant search keys
      if (state.triageTab === 'history') {
        if (handleSearchKey(e)) return;
      }

      // Alt+S to start
      if (e.altKey && e.key.toLowerCase() === 's') {
        e.preventDefault();
        handleStart();
        return;
      }

      // Alt+E to enter first running triage
      if (e.altKey && e.key.toLowerCase() === 'e') {
        e.preventDefault();
        const running = triageEntries.find(([, t]) => t.status === 'running');
        if (running) handleEnter(running[0]);
        return;
      }

      // Alt+C to cancel first running triage
      if (e.altKey && e.key.toLowerCase() === 'c') {
        e.preventDefault();
        const running = triageEntries.find(([, t]) => t.status === 'running');
        if (running) handleCancel(running[0]);
        return;
      }

      // Alt+N / Alt+H to switch tabs
      if (e.altKey && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        dispatch({ type: 'SET_TRIAGE_TAB', tab: 'new' });
        return;
      }
      if (e.altKey && e.key.toLowerCase() === 'h') {
        e.preventDefault();
        dispatch({ type: 'SET_TRIAGE_TAB', tab: 'history' });
        return;
      }

      // Enter to start when textarea not focused
      if (e.key === 'Enter' && !e.shiftKey && document.activeElement !== textareaRef.current) {
        e.preventDefault();
        handleStart();
        return;
      }
    },
    [close, interactiveId, state.triageTab, handleSearchKey, handleStart, dispatch],
  );

  // Filter history by search
  const filteredHistory = search
    ? state.triageHistory.filter((h) => h.prompt.toLowerCase().includes(search.toLowerCase()))
    : state.triageHistory;

  return (
    <div
      className="absolute inset-0 z-20 bg-overlay focus:outline-none"
      tabIndex={-1}
      ref={panelRef}
      onClick={close}
      onKeyDown={handleKeyDown}
    >
      <div
        className="absolute inset-x-4 top-4 bottom-4 mx-auto max-w-2xl bg-surface rounded-lg border border-border-input shadow-xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border-default">
          <div className="flex items-center gap-3">
            <h2 className="text-sm font-semibold text-primary">Triage</h2>
            <PillToggle
              options={tabOptions}
              value={state.triageTab}
              onChange={(tab) => {
                dispatch({ type: 'SET_TRIAGE_TAB', tab });
                clearSearch();
              }}
            />
          </div>
          <button onClick={close} className="text-secondary hover:text-primary text-lg leading-none transition-colors">
            ×
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
          {state.triageTab === 'new' ? (
            <div className="flex-1 min-h-0 flex flex-col">
              {/* Prompt input */}
              <div className="p-4 border-b border-border-default">
                <textarea
                  ref={textareaRef}
                  value={state.triageDraftPrompt}
                  onChange={(e) => dispatch({ type: 'SET_TRIAGE_DRAFT_PROMPT', prompt: e.target.value })}
                  placeholder="Paste a URL or describe what to triage…"
                  rows={3}
                  className="w-full bg-surface-alt border border-border-input rounded text-sm text-primary placeholder-muted p-2 resize-none focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      handleStart();
                    }
                  }}
                />
                <div className="flex items-center justify-end mt-2">
                  <button
                    onClick={handleStart}
                    disabled={!state.triageDraftPrompt.trim()}
                    className="px-3 py-1 text-xs bg-accent hover:bg-accent-hover text-white rounded transition-colors disabled:opacity-40"
                  >
                    <ActionLabel text="Start" hintIndex={0} showHint={altHeld} />
                  </button>
                </div>
              </div>

              {/* Running triages */}
              <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-3">
                {triageEntries.length === 0 && !hasRunning && (
                  <div className="text-xs text-muted text-center py-8">
                    No active triages. Enter a URL or prompt above to start.
                  </div>
                )}
                {triageEntries.map(([id, item]) => (
                  <TriageCard
                    key={id}
                    id={id}
                    item={item}
                    interactiveId={interactiveId}
                    onEnter={handleEnter}
                    onCancel={handleCancel}
                    onBack={handleBack}
                    showAlt={altHeld}
                  />
                ))}
              </div>
            </div>
          ) : (
            /* History tab */
            <div className="flex-1 min-h-0 flex flex-col">
              {searchVisible && (
                <div className="px-4 pt-3">
                  <SearchIndicator
                    search={search}
                    visible={searchVisible}
                    matchInfo={`${filteredHistory.length} of ${state.triageHistory.length}`}
                  />
                </div>
              )}
              <div className="flex-1 min-h-0 overflow-y-auto p-2">
                {filteredHistory.length === 0 ? (
                  <div className="text-xs text-muted text-center py-8">
                    {state.triageHistory.length === 0 ? 'No triage history yet.' : 'No matches.'}
                  </div>
                ) : (
                  filteredHistory.map((entry) => <HistoryRow key={entry.id} entry={entry} search={search} />)
                )}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 pb-3 pt-2 border-t border-border-default">
          <div className="text-xs text-faint flex items-center gap-3">
            {interactiveId ? (
              <>
                <span>{altSymbol}B back</span>
                <span>Esc back</span>
              </>
            ) : (
              <>
                {state.triageTab === 'new' && (
                  <>
                    <span>Enter start · {altSymbol}S</span>
                    {triageEntries.some(([, t]) => t.status === 'running') && (
                      <>
                        <span>{altSymbol}E enter</span>
                        <span>{altSymbol}C cancel</span>
                      </>
                    )}
                  </>
                )}
                <span>
                  {altSymbol}N/{altSymbol}H tabs
                </span>
                <span>Esc close</span>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
