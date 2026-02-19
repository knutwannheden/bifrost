import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../context/AppContext';

interface Shortcut {
  key: string;
  label: string;
  group: string;
  /** Simulated key for synthetic KeyboardEvent (lowercase). Omit for non-executable entries. */
  execKey?: string;
  execShift?: boolean;
  execCode?: string;
  /** Direct action — bypasses synthetic keyboard event. */
  action?: string;
}

const GROUPS = ['Tasks', 'Navigation', 'Views', 'Actions', 'App'] as const;

const shortcuts: Shortcut[] = [
  // Tasks
  { key: 'T', label: 'New task', group: 'Tasks', execKey: 't' },
  { key: 'W', label: 'Close pane / stop task', group: 'Tasks', execKey: 'w' },
  { key: 'Shift+W', label: 'Archive task', group: 'Tasks', action: 'archive-task' },

  // Navigation
  { key: 'Shift+[', label: 'Previous tab', group: 'Navigation', execKey: '[', execShift: true, execCode: 'BracketLeft' },
  { key: 'Shift+]', label: 'Next tab', group: 'Navigation', execKey: ']', execShift: true, execCode: 'BracketRight' },
  { key: '1-9', label: 'Switch to tab N', group: 'Navigation' },
  { key: '-', label: 'Switch to last active tab', group: 'Navigation', execKey: '-' },
  { key: '=', label: 'Switch to last notified tab', group: 'Navigation', execKey: '=' },

  // Views
  { key: '/', label: 'Toggle dev terminal', group: 'Views', execKey: '/' },
  { key: 'D', label: 'Git diff', group: 'Views', execKey: 'd' },
  { key: 'L', label: 'Git log', group: 'Views', execKey: 'l' },
  { key: 'H', label: 'Task history', group: 'Views', execKey: 'h' },
  { key: 'R', label: 'Repositories', group: 'Views', execKey: 'r' },
  { key: 'U', label: 'Review', group: 'Views', execKey: 'u' },

  // Actions
  { key: 'O', label: 'Open in IDE', group: 'Actions', execKey: 'o' },
  { key: 'G', label: 'Open PR in GitHub', group: 'Actions', execKey: 'g' },
  { key: 'F', label: 'Find in terminal', group: 'Actions', execKey: 'f' },
  { key: 'Shift+C', label: 'Capture context', group: 'Actions', execKey: 'c', execShift: true },

  // App
  { key: 'K', label: 'Keyboard shortcuts', group: 'App', execKey: 'k' },
  { key: ',', label: 'Settings', group: 'App', execKey: ',' },
];

export default function KeyboardShortcutsPanel() {
  const { state, dispatch } = useApp();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);

  const filtered = useMemo(() => {
    if (!query) return shortcuts;
    const lower = query.toLowerCase();
    return shortcuts.filter(
      (s) => s.label.toLowerCase().includes(lower) || s.key.toLowerCase().includes(lower),
    );
  }, [query]);

  // Build a flat list of items (group headers + shortcuts) for rendering and navigation
  const { items, executableIndices } = useMemo(() => {
    const items: ({ type: 'header'; label: string } | { type: 'shortcut'; shortcut: Shortcut; flatIdx: number })[] = [];
    const executableIndices: number[] = [];
    const isSearching = !!query;

    if (isSearching) {
      // Flat list when searching — no group headers
      filtered.forEach((s, i) => {
        executableIndices.push(items.length);
        items.push({ type: 'shortcut', shortcut: s, flatIdx: i });
      });
    } else {
      let flatIdx = 0;
      for (const group of GROUPS) {
        const groupItems = filtered.filter((s) => s.group === group);
        if (groupItems.length === 0) continue;
        items.push({ type: 'header', label: group });
        for (const s of groupItems) {
          executableIndices.push(items.length);
          items.push({ type: 'shortcut', shortcut: s, flatIdx: flatIdx++ });
        }
      }
    }

    return { items, executableIndices };
  }, [filtered, query]);

  // Reset selection when filter changes
  useEffect(() => {
    setSelectedIndex(0);
  }, [filtered.length]);

  // Scroll selected item into view
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const itemIdx = executableIndices[selectedIndex];
    if (itemIdx == null) return;
    const item = list.children[itemIdx] as HTMLElement | undefined;
    item?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex, executableIndices]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const close = () => dispatch({ type: 'TOGGLE_KEYBOARD_SHORTCUTS' });

  const executeAction = (action: string) => {
    if (action === 'archive-task') {
      const taskId = state.activeTaskId;
      if (!taskId) return;
      window.bifrost.archiveTask(taskId).then((updated) => {
        dispatch({ type: 'UPDATE_TASK', task: updated });
        const remaining = state.tasks.filter(
          (t) => t.id !== taskId && t.status === 'running',
        );
        dispatch({
          type: 'SET_ACTIVE_TASK',
          taskId: remaining.length > 0 ? remaining[remaining.length - 1].id : null,
        });
      });
    }
  };

  const execute = (shortcut: Shortcut) => {
    if (shortcut.action) {
      close();
      executeAction(shortcut.action);
      return;
    }
    const { execKey } = shortcut;
    if (!execKey) return;
    close();
    // Dispatch synthetic keyboard event so useKeyboard handles it
    requestAnimationFrame(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: execKey,
          code: shortcut.execCode ?? (execKey === '/' ? 'Slash' : `Key${execKey.toUpperCase()}`),
          metaKey: true,
          shiftKey: !!shortcut.execShift,
          bubbles: true,
        }),
      );
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        close();
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
        const item = itemIdx != null ? items[itemIdx] : null;
        if (item?.type === 'shortcut') execute(item.shortcut);
        break;
      }
    }
  };

  return (
    <div
      className="absolute inset-0 z-20 flex items-center justify-center bg-black/30 focus:outline-none"
      onClick={close}
      onKeyDown={handleKeyDown}
    >
      <div
        className="bg-slate-800 rounded-lg border border-slate-600 w-[400px] flex flex-col shadow-xl max-h-[80vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center px-4 py-3 border-b border-slate-700">
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search shortcuts…"
            className="flex-1 bg-transparent text-sm text-slate-200 placeholder-slate-500 outline-none"
          />
          <button
            onClick={close}
            tabIndex={-1}
            className="text-slate-400 hover:text-slate-200 text-lg leading-none ml-2"
          >
            &times;
          </button>
        </div>
        <div ref={listRef} className="p-2 overflow-y-auto">
          {items.length === 0 ? (
            <div className="px-2 py-3 text-sm text-slate-500 text-center">No matches</div>
          ) : (
            items.map((item, i) => {
              if (item.type === 'header') {
                return (
                  <div
                    key={`group-${item.label}`}
                    className={`px-2 pt-3 pb-1 text-xs font-semibold text-slate-500 uppercase tracking-wider ${i === 0 ? 'pt-1' : ''}`}
                  >
                    {item.label}
                  </div>
                );
              }
              const navIdx = executableIndices.indexOf(i);
              return (
                <div
                  key={item.shortcut.key}
                  className={`flex items-center justify-between px-2 py-1.5 rounded cursor-pointer ${
                    navIdx === selectedIndex ? 'bg-slate-700' : 'hover:bg-slate-700/50'
                  }`}
                  onClick={() => execute(item.shortcut)}
                  onMouseEnter={() => setSelectedIndex(navIdx)}
                >
                  <span className="text-sm text-slate-300">{item.shortcut.label}</span>
                  <kbd className="px-2 py-0.5 text-xs font-mono bg-slate-700 border border-slate-600 rounded text-slate-300">
                    {item.shortcut.key.includes('Shift+') ? `\u2318\u21E7${item.shortcut.key.replace('Shift+', '')}` : `\u2318${item.shortcut.key}`}
                  </kbd>
                </div>
              );
            })
          )}
        </div>
        <div className="px-4 pb-3 pt-2 border-t border-slate-700">
          <p className="text-xs text-slate-500">Click URLs in terminal to open in browser</p>
        </div>
      </div>
    </div>
  );
}
