import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ACTION_CATEGORIES,
  ACTION_REGISTRY,
  isCustomized,
  type KeyStroke,
  parseBinding,
  serializeBinding,
} from '../../shared/keymap';
import { useApp } from '../context/AppContext';
import { useKeymap } from '../context/KeymapContext';
import { requestArchive } from '../utils/archive';
import { altSymbol } from '../utils/platform';
import { matchesAllTerms } from '../utils/search';
import CloseButton from './CloseButton';
import Highlight from './Highlight';
import Kbd from './Kbd';
import OverlayFooter from './OverlayFooter';
import SectionHeader from './SectionHeader';

interface ActionItem {
  actionId: string;
  label: string;
  category: string;
  binding: string;
}

export default function KeyboardShortcutsPanel() {
  const { state, dispatch } = useApp();
  const { getDisplayString } = useKeymap();
  const overlayRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [recordingActionId, setRecordingActionId] = useState<string | null>(null);
  const [recordedStrokes, setRecordedStrokes] = useState<KeyStroke[]>([]);
  const [conflict, setConflict] = useState<string | null>(null);

  const allActions = useMemo<ActionItem[]>(() => {
    return Object.values(ACTION_REGISTRY).map((def) => ({
      actionId: def.id,
      label: def.label,
      category: ACTION_CATEGORIES.find((c) => c.id === def.category)?.label ?? def.category,
      binding: getDisplayString(def.id),
    }));
  }, [getDisplayString]);

  const filtered = useMemo(() => {
    if (!query) return allActions;
    return allActions.filter((a) => matchesAllTerms(`${a.label} ${a.binding}`, query));
  }, [query, allActions]);

  const { items, executableIndices } = useMemo(() => {
    const items: ({ type: 'header'; label: string } | { type: 'action'; item: ActionItem })[] = [];
    const executableIndices: number[] = [];

    if (query) {
      for (const a of filtered) {
        executableIndices.push(items.length);
        items.push({ type: 'action', item: a });
      }
    } else {
      for (const cat of ACTION_CATEGORIES) {
        const catItems = filtered.filter((a) => a.category === cat.label);
        if (catItems.length === 0) continue;
        items.push({ type: 'header', label: cat.label });
        for (const a of catItems) {
          executableIndices.push(items.length);
          items.push({ type: 'action', item: a });
        }
      }
    }

    return { items, executableIndices };
  }, [filtered, query]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [filtered.length]);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const itemIdx = executableIndices[selectedIndex];
    if (itemIdx == null) return;
    const el = list.children[itemIdx] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex, executableIndices]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const close = () => dispatch({ type: 'TOGGLE_KEYBOARD_SHORTCUTS' });

  const executeItem = (item: ActionItem) => {
    if (recordingActionId) return;

    if (item.actionId === 'task.archive') {
      close();
      const taskId = state.activeTaskId;
      if (!taskId) return;
      const task = state.tasks.find((t) => t.id === taskId);
      if (!task) return;
      requestArchive(taskId, task.name, state, dispatch);
      return;
    }

    const binding = item.binding;
    if (!binding) return;
    close();
    const strokes = parseBinding(binding);
    if (strokes.length === 0) return;
    const first = strokes[0];
    requestAnimationFrame(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: first.key,
          code: first.key === '/' ? 'Slash' : first.key.length === 1 ? `Key${first.key.toUpperCase()}` : first.key,
          metaKey: !!first.mod,
          ctrlKey: false,
          shiftKey: !!first.shift,
          altKey: !!first.alt,
          bubbles: true,
        }),
      );
    });
  };

  const startRecording = (actionId: string) => {
    setRecordingActionId(actionId);
    setRecordedStrokes([]);
    setConflict(null);
  };

  const refocus = () => requestAnimationFrame(() => inputRef.current?.focus());

  const cancelRecording = () => {
    setRecordingActionId(null);
    setRecordedStrokes([]);
    setConflict(null);
    refocus();
  };

  const saveBinding = async (actionId: string, strokes: KeyStroke[] | null) => {
    if (!state.config) return;
    const serialized = strokes ? serializeBinding(strokes) : null;
    const keybindings = { ...state.config.keybindings, [actionId]: serialized };
    const newConfig = { ...state.config, keybindings };
    await window.bifrost.saveConfig(newConfig);
    dispatch({ type: 'SET_CONFIG', config: newConfig });
    cancelRecording();
    refocus();
  };

  const resetBinding = async (actionId: string) => {
    if (!state.config?.keybindings) return;
    const { [actionId]: _, ...rest } = state.config.keybindings;
    void _;
    const keybindings = Object.keys(rest).length > 0 ? rest : undefined;
    const newConfig = { ...state.config, keybindings };
    await window.bifrost.saveConfig(newConfig);
    dispatch({ type: 'SET_CONFIG', config: newConfig });
    refocus();
  };

  const resetAllBindings = async () => {
    if (!state.config) return;
    const { keybindings: _, ...rest } = state.config;
    void _;
    const newConfig = rest as typeof state.config;
    await window.bifrost.saveConfig(newConfig);
    dispatch({ type: 'SET_CONFIG', config: newConfig });
    refocus();
  };

  // Handle recording keystrokes
  useEffect(() => {
    if (!recordingActionId) return;

    const handler = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();

      if (e.key === 'Escape') {
        cancelRecording();
        return;
      }

      // Enter confirms the current recorded strokes (e.g. single Cmd+K without chord)
      if (e.key === 'Enter' && recordedStrokes.length > 0) {
        saveBinding(recordingActionId, recordedStrokes);
        return;
      }

      if (['Meta', 'Control', 'Shift', 'Alt'].includes(e.key)) return;

      const stroke: KeyStroke = {
        mod: e.metaKey || e.ctrlKey,
        shift: e.shiftKey,
        alt: e.altKey,
        key: e.key.toLowerCase(),
      };

      const newStrokes = [...recordedStrokes, stroke];
      const serialized = serializeBinding(newStrokes);
      const conflictAction = allActions.find((a) => a.actionId !== recordingActionId && a.binding === serialized);

      if (conflictAction) {
        setConflict(`Conflicts with "${conflictAction.label}"`);
      } else {
        setConflict(null);
      }

      if (newStrokes.length >= 2 || !stroke.mod) {
        // Chord complete or single non-mod keystroke
        saveBinding(recordingActionId, newStrokes);
      } else {
        // First stroke of potential chord — Enter to confirm or press another key
        setRecordedStrokes(newStrokes);
      }
    };

    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [recordingActionId, recordedStrokes, allActions]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (recordingActionId) return;

    switch (e.key) {
      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        if (query) {
          setQuery('');
          inputRef.current?.focus();
        } else {
          close();
        }
        break;
      case 'ArrowDown':
        e.preventDefault();
        setSelectedIndex((i) => (i < executableIndices.length - 1 ? i + 1 : 0));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setSelectedIndex((i) => (i > 0 ? i - 1 : executableIndices.length - 1));
        break;
      case 'Enter': {
        e.preventDefault();
        const itemIdx = executableIndices[selectedIndex];
        const entry = itemIdx != null ? items[itemIdx] : null;
        if (entry?.type === 'action') executeItem(entry.item);
        break;
      }
      default: {
        // Alt+R to rebind — check e.code because macOS Alt+R produces '®' as e.key
        if (e.altKey && e.code === 'KeyR') {
          e.preventDefault();
          const itemIdx = executableIndices[selectedIndex];
          const entry = itemIdx != null ? items[itemIdx] : null;
          if (entry?.type === 'action') startRecording(entry.item.actionId);
        }
        // Alt+U to unassign
        if (e.altKey && e.code === 'KeyU') {
          e.preventDefault();
          const itemIdx = executableIndices[selectedIndex];
          const entry = itemIdx != null ? items[itemIdx] : null;
          if (entry?.type === 'action') saveBinding(entry.item.actionId, null);
        }
        break;
      }
    }
  };

  const hasCustomBindings = !!state.config?.keybindings && Object.keys(state.config.keybindings).length > 0;

  return (
    <div
      ref={overlayRef}
      tabIndex={-1}
      className="absolute inset-0 z-20 flex items-center justify-center bg-overlay focus:outline-hidden"
      onClick={close}
      onKeyDown={handleKeyDown}
    >
      <div
        className="bg-surface rounded-lg border border-border-input w-[480px] flex flex-col shadow-xl max-h-[80vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center px-4 py-3 border-b border-border-default">
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              // Intercept Alt+R at the input level to prevent macOS inserting '®'
              if (e.altKey && (e.nativeEvent.code === 'KeyR' || e.nativeEvent.code === 'KeyU')) {
                e.preventDefault();
              }
            }}
            placeholder="Search actions…"
            className="flex-1 bg-transparent text-sm text-primary placeholder-muted outline-hidden"
            disabled={!!recordingActionId}
          />
          <CloseButton onClick={close} className="ml-2" />
        </div>
        <div ref={listRef} className="p-2 overflow-y-auto">
          {items.length === 0 ? (
            <div className="text-sm text-muted text-center py-4">No matches</div>
          ) : (
            items.map((item, i) => {
              if (item.type === 'header') {
                return (
                  <SectionHeader key={`group-${item.label}`} className={`px-2 pt-3 pb-1 ${i === 0 ? 'pt-1' : ''}`}>
                    {item.label}
                  </SectionHeader>
                );
              }
              const navIdx = executableIndices.indexOf(i);
              const isRecording = recordingActionId === item.item.actionId;
              const isModified = isCustomized(item.item.actionId, state.config?.keybindings);
              return (
                <div
                  key={item.item.actionId}
                  className={`group/row flex items-center justify-between px-2 py-1.5 rounded cursor-pointer ${
                    navIdx === selectedIndex ? 'bg-surface-alt' : 'hover:bg-surface-alt/50'
                  }`}
                  onClick={() => executeItem(item.item)}
                  onMouseEnter={() => setSelectedIndex(navIdx)}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    startRecording(item.item.actionId);
                  }}
                >
                  <span className="text-sm text-secondary flex items-center gap-1.5">
                    {isModified && <span className="w-1.5 h-1.5 rounded-full bg-accent shrink-0" title="Customized" />}
                    <Highlight text={item.item.label} search={query} />
                  </span>
                  <div className="flex items-center gap-1">
                    {isRecording ? (
                      <span className="text-xs text-accent animate-pulse">
                        {recordedStrokes.length > 0
                          ? `${serializeBinding(recordedStrokes)} … Enter to confirm`
                          : 'Press shortcut…'}
                      </span>
                    ) : item.item.binding ? (
                      <Kbd size="sm">{item.item.binding}</Kbd>
                    ) : (
                      <span className="text-xs text-faint">&mdash;</span>
                    )}
                    {item.item.binding && !isRecording && (
                      <button
                        className="text-xs text-muted hover:text-primary transition-colors ml-1 hidden group-hover/row:block"
                        title="Unassign shortcut"
                        onClick={(e) => {
                          e.stopPropagation();
                          saveBinding(item.item.actionId, null);
                        }}
                      >
                        &#x2715;
                      </button>
                    )}
                    {isModified && !isRecording && (
                      <button
                        className="text-xs text-muted hover:text-primary transition-colors ml-1"
                        title="Reset to default"
                        onClick={(e) => {
                          e.stopPropagation();
                          resetBinding(item.item.actionId);
                        }}
                      >
                        &#x21BA;
                      </button>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
        {conflict && <div className="px-4 py-2 text-xs text-warning border-t border-border-default">{conflict}</div>}
        <OverlayFooter>
          <span className="text-xs text-faint">
            &uarr;&darr; navigate &middot; Enter execute &middot; {altSymbol}R rebind &middot; {altSymbol}U unassign
            &middot; Esc close
          </span>
          {hasCustomBindings && (
            <button
              className="text-xs text-muted hover:text-primary transition-colors ml-auto"
              onClick={resetAllBindings}
            >
              Reset all
            </button>
          )}
        </OverlayFooter>
      </div>
    </div>
  );
}
