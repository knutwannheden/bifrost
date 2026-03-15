import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { TriageEntry } from '../../shared/types';
import type { TriageItem, TriageTab } from '../context/AppContext';
import { useApp } from '../context/AppContext';
import { useInstantSearch } from '../hooks/useInstantSearch';
import { useOverlayFocus } from '../hooks/useOverlayFocus';
import { type TabDef, useTabMnemonics } from '../hooks/useTabMnemonics';
import { formatTime } from '../utils/format-time';
import { altSymbol } from '../utils/platform';
import ActionLabel from './ActionLabel';
import FormTextarea from './FormTextarea';
import Highlight from './Highlight';
import OverlayFooter from './OverlayFooter';
import OverlayHeader from './OverlayHeader';
import PillToggle from './PillToggle';
import PrimaryButton from './PrimaryButton';
import SearchIndicator from './SearchIndicator';
import Spinner from './Spinner';
import TerminalPane from './TerminalPane';

const TAB_DEFS: TabDef<TriageTab>[] = [
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
            <span className="px-1.5 py-0.5 text-[10px] font-medium bg-warning/20 text-warning rounded-sm">Waiting</span>
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
        {item.status === 'done' && <span className="text-success text-xs">✓</span>}
        {item.status === 'error' && <span className="text-danger text-xs">✗</span>}
        <span className="text-xs text-primary truncate flex-1">{item.prompt}</span>
        {item.waiting && (
          <span className="px-1.5 py-0.5 text-[10px] font-medium bg-warning/20 text-warning rounded-sm">Waiting</span>
        )}
      </div>
      {lastActivity && <div className="text-xs text-muted truncate mb-2">{lastActivity}</div>}
      <div className="flex items-center gap-2">
        {item.status === 'running' && (
          <>
            <PrimaryButton size="sm" onClick={() => onEnter(id)}>
              <ActionLabel text="Enter" hintIndex={0} showHint={showAlt} />
            </PrimaryButton>
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

const statusConfig = {
  done: { icon: '✓', color: 'text-success', label: 'Completed' },
  error: { icon: '✗', color: 'text-danger', label: 'Error' },
  cancelled: { icon: '—', color: 'text-muted', label: 'Cancelled' },
  running: { icon: '…', color: 'text-accent', label: 'Running' },
} as const;

/** A history row for completed triages — richer than just a checkmark. */
function HistoryRow({
  entry,
  search,
  focused,
  onEnter,
  taskNames,
}: {
  entry: TriageEntry;
  search: string;
  focused: boolean;
  onEnter: (entry: TriageEntry) => void;
  taskNames: Map<string, string>;
}) {
  const cfg = statusConfig[entry.status] ?? statusConfig.done;
  const taskLabels = entry.taskIds?.map((id) => taskNames.get(id) ?? id.slice(0, 8)).filter(Boolean);

  return (
    <div
      className={`px-3 py-2 rounded-sm cursor-default transition-colors ${
        focused
          ? 'bg-surface-alt border-l-2 border-accent-hover'
          : 'border-l-2 border-transparent hover:bg-surface-hover'
      }`}
      onClick={() => onEnter(entry)}
    >
      <div className="flex items-center gap-2">
        <span className={`text-xs ${cfg.color} w-4 text-center shrink-0`}>{cfg.icon}</span>
        <span className="text-xs text-primary truncate flex-1">
          <Highlight text={entry.prompt} search={search} />
        </span>
        <span className="text-xs text-muted shrink-0">{formatTime(entry.createdAt)}</span>
      </div>
      {/* Summary or last activity */}
      {(entry.summary || entry.lastActivity) && (
        <div className="ml-6 mt-1 text-[11px] text-muted line-clamp-2">
          <Highlight text={entry.summary ?? entry.lastActivity ?? ''} search={search} />
        </div>
      )}
      {/* Task links */}
      {(taskLabels?.length || entry.claudeSessionId) && (
        <div className="ml-6 mt-1 flex items-center gap-3 text-[11px]">
          {taskLabels && taskLabels.length > 0 && <span className="text-secondary">→ {taskLabels.join(', ')}</span>}
          {entry.claudeSessionId && (
            <span className="text-faint" title="Press Enter to review session">
              ◉ session
            </span>
          )}
        </div>
      )}
    </div>
  );
}

export default function TriageOverlay() {
  const { state, dispatch } = useApp();
  const panelRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const historyItemRefs = useRef<(HTMLDivElement | null)[]>([]);
  const [interactiveId, setInteractiveId] = useState<string | null>(null);
  const [historyPtySessionId, setHistoryPtySessionId] = useState<string | null>(null);
  const [historyEntryId, setHistoryEntryId] = useState<string | null>(null);
  const { options: tabOptions, handleTabKey } = useTabMnemonics(TAB_DEFS, (tab) =>
    dispatch({ type: 'SET_TRIAGE_TAB', tab }),
  );
  const [altHeld, setAltHeld] = useState(false);
  const [historyFocusedIdx, setHistoryFocusedIdx] = useState(0);

  const { search, searchVisible, handleSearchKey, clearSearch } = useInstantSearch();

  const triageEntries = Object.entries(state.triages);
  const hasRunning = triageEntries.some(([, t]) => t.status === 'running');

  // Build task name lookup from app state
  const taskNames = new Map(state.tasks.map((t) => [t.id, t.name]));

  // Load history when History tab is selected
  useEffect(() => {
    if (state.triageTab === 'history') {
      window.bifrost.listTriages().then((history) => {
        dispatch({ type: 'SET_TRIAGE_HISTORY', history });
      });
    }
  }, [state.triageTab, dispatch]);

  useOverlayFocus(panelRef);

  const close = useCallback(() => {
    if (historyPtySessionId) {
      setHistoryPtySessionId(null);
      setHistoryEntryId(null);
      return;
    }
    if (interactiveId) {
      setInteractiveId(null);
      return;
    }
    dispatch({ type: 'CLOSE_TRIAGE' });
  }, [interactiveId, historyPtySessionId, dispatch]);

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
      dispatch({ type: 'UPDATE_TRIAGE', id, updates: { status: 'cancelled', waiting: false } });
    },
    [dispatch],
  );

  const handleEnter = useCallback((id: string) => {
    setInteractiveId(id);
  }, []);

  const handleBack = useCallback((_id: string) => {
    setInteractiveId(null);
  }, []);

  const handleHistoryEnter = useCallback(async (entry: TriageEntry) => {
    if (!entry.claudeSessionId) return;
    const result = await window.bifrost.enterTriage(entry.id);
    if (result) {
      setHistoryPtySessionId(result.ptySessionId);
      setHistoryEntryId(entry.id);
    }
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

  // Reset history focus when search changes
  useEffect(() => {
    setHistoryFocusedIdx(0);
  }, [search]);

  // Scroll focused history item into view
  useEffect(() => {
    historyItemRefs.current[historyFocusedIdx]?.scrollIntoView({ block: 'nearest' });
  }, [historyFocusedIdx]);

  // Filter history by search
  const filteredHistory = search
    ? state.triageHistory.filter((h) => h.prompt.toLowerCase().includes(search.toLowerCase()))
    : state.triageHistory;

  // Clamp focus when list shrinks
  useEffect(() => {
    if (historyFocusedIdx >= filteredHistory.length && filteredHistory.length > 0) {
      setHistoryFocusedIdx(filteredHistory.length - 1);
    }
  }, [filteredHistory.length, historyFocusedIdx]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // Esc to close / go back
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close();
        return;
      }

      // In interactive mode (new tab or history), only handle Alt+B for back
      if (interactiveId || historyPtySessionId) {
        if (e.altKey && e.code === 'KeyB') {
          e.preventDefault();
          close();
        }
        return;
      }

      // History tab: handle instant search keys and navigation
      if (state.triageTab === 'history') {
        if (handleSearchKey(e)) return;

        if (e.key === 'ArrowDown' && filteredHistory.length > 0) {
          e.preventDefault();
          setHistoryFocusedIdx((i) => (i < filteredHistory.length - 1 ? i + 1 : 0));
          return;
        }
        if (e.key === 'ArrowUp' && filteredHistory.length > 0) {
          e.preventDefault();
          setHistoryFocusedIdx((i) => (i > 0 ? i - 1 : filteredHistory.length - 1));
          return;
        }
        if (e.key === 'Enter' && filteredHistory.length > 0) {
          e.preventDefault();
          const entry = filteredHistory[historyFocusedIdx];
          if (entry?.claudeSessionId) handleHistoryEnter(entry);
          return;
        }
      }

      if (handleTabKey(e)) return;

      // Alt+letter shortcuts (use e.code since Alt produces special chars on macOS)
      if (e.altKey) {
        switch (e.code) {
          case 'KeyS':
            e.preventDefault();
            handleStart();
            return;
          case 'KeyE': {
            e.preventDefault();
            const running = triageEntries.find(([, t]) => t.status === 'running');
            if (running) handleEnter(running[0]);
            return;
          }
          case 'KeyC': {
            e.preventDefault();
            const running = triageEntries.find(([, t]) => t.status === 'running');
            if (running) handleCancel(running[0]);
            return;
          }
        }
      }

      // Enter to start when textarea not focused (New tab)
      if (
        state.triageTab === 'new' &&
        e.key === 'Enter' &&
        !e.shiftKey &&
        document.activeElement !== textareaRef.current
      ) {
        e.preventDefault();
        handleStart();
        return;
      }
    },
    [
      close,
      interactiveId,
      historyPtySessionId,
      state.triageTab,
      handleSearchKey,
      handleTabKey,
      handleStart,
      handleHistoryEnter,
      filteredHistory,
      historyFocusedIdx,
      dispatch,
    ],
  );

  // Find the entry for the interactive history view
  const historyEntry = historyEntryId ? state.triageHistory.find((e) => e.id === historyEntryId) : null;

  return (
    <div
      className="absolute inset-0 z-20 bg-overlay focus:outline-hidden"
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
        <OverlayHeader title="Triage" onClose={close}>
          <PillToggle
            options={tabOptions}
            value={state.triageTab}
            onChange={(tab) => {
              dispatch({ type: 'SET_TRIAGE_TAB', tab });
              clearSearch();
              setHistoryPtySessionId(null);
              setHistoryEntryId(null);
            }}
          />
        </OverlayHeader>

        {/* Content */}
        <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
          {state.triageTab === 'new' ? (
            <div className="flex-1 min-h-0 flex flex-col">
              {/* Prompt input */}
              <div className="p-4 border-b border-border-default">
                <FormTextarea
                  ref={textareaRef}
                  value={state.triageDraftPrompt}
                  onChange={(e) => dispatch({ type: 'SET_TRIAGE_DRAFT_PROMPT', prompt: e.target.value })}
                  placeholder="Paste a URL or describe what to triage…"
                  rows={3}
                  className="w-full resize-none p-2"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      handleStart();
                    }
                  }}
                />
                <div className="flex items-center justify-end mt-2">
                  <PrimaryButton
                    size="sm"
                    onClick={handleStart}
                    disabled={!state.triageDraftPrompt.trim()}
                    className="px-3 py-1"
                  >
                    <ActionLabel text="Start" hintIndex={0} showHint={altHeld} />
                  </PrimaryButton>
                </div>
              </div>

              {/* Running triages */}
              <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-3">
                {triageEntries.length === 0 && !hasRunning && (
                  <div className="text-sm text-muted text-center py-4">
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
          ) : historyPtySessionId ? (
            /* History interactive view — showing a resumed triage session */
            <div className="flex flex-col flex-1 min-h-0">
              <div className="flex items-center gap-2 px-3 py-2 border-b border-border-default">
                <button
                  onClick={() => close()}
                  className="px-2 py-0.5 text-xs text-secondary hover:text-primary transition-colors"
                >
                  <ActionLabel text="Back" hintIndex={0} showHint={altHeld} />
                </button>
                <span className="text-xs text-secondary truncate flex-1">{historyEntry?.prompt}</span>
              </div>
              <div className="flex-1 min-h-0">
                <TerminalPane sessionId={historyPtySessionId} active focused hideCursor={false} />
              </div>
            </div>
          ) : (
            /* History tab — list view */
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
                  <div className="text-sm text-muted text-center py-4">
                    {state.triageHistory.length === 0 ? 'No triage history yet.' : 'No matches.'}
                  </div>
                ) : (
                  filteredHistory.map((entry, idx) => (
                    <div
                      key={entry.id}
                      ref={(el) => {
                        historyItemRefs.current[idx] = el;
                      }}
                      onMouseEnter={() => setHistoryFocusedIdx(idx)}
                    >
                      <HistoryRow
                        entry={entry}
                        search={search}
                        focused={idx === historyFocusedIdx}
                        onEnter={handleHistoryEnter}
                        taskNames={taskNames}
                      />
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <OverlayFooter>
          <div className="text-xs text-faint flex items-center gap-3">
            {interactiveId || historyPtySessionId ? (
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
                {state.triageTab === 'history' && (
                  <>
                    <span>&uarr;&darr; navigate</span>
                    <span>Enter open</span>
                    <span>type to search</span>
                  </>
                )}
                <span>
                  {altSymbol}N/{altSymbol}H tabs
                </span>
                <span>Esc close</span>
              </>
            )}
          </div>
        </OverlayFooter>
      </div>
    </div>
  );
}
