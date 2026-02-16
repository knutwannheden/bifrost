import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../context/AppContext';

interface Shortcut {
  key: string;
  label: string;
  /** Simulated key for synthetic KeyboardEvent (lowercase). Omit for non-executable entries. */
  execKey?: string;
  execShift?: boolean;
  execCode?: string;
}

const shortcuts: Shortcut[] = [
  { key: 'T', label: 'New task', execKey: 't' },
  { key: 'W', label: 'Close pane / stop task', execKey: 'w' },
  { key: 'Shift+W', label: 'Archive task' },
  { key: '/', label: 'Toggle dev terminal', execKey: '/' },
  { key: 'D', label: 'Git diff', execKey: 'd' },
  { key: 'A', label: 'Activity log', execKey: 'a' },
  { key: 'L', label: 'Git log', execKey: 'l' },
  { key: 'R', label: 'Repositories', execKey: 'r' },
  { key: 'H', label: 'Task history', execKey: 'h' },
  { key: 'O', label: 'Open in IDE', execKey: 'o' },
  { key: 'G', label: 'Open PR in GitHub', execKey: 'g' },
  { key: 'K', label: 'Keyboard shortcuts', execKey: 'k' },
  { key: 'Shift+C', label: 'Capture context', execKey: 'c', execShift: true },
  { key: ',', label: 'Settings', execKey: ',' },
  { key: 'Shift+[', label: 'Previous tab', execKey: '[', execShift: true, execCode: 'BracketLeft' },
  { key: 'Shift+]', label: 'Next tab', execKey: ']', execShift: true, execCode: 'BracketRight' },
  { key: '1-9', label: 'Switch to tab N' },
];

export default function KeyboardShortcutsPanel() {
  const { dispatch } = useApp();
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

  // Reset selection when filter changes
  useEffect(() => {
    setSelectedIndex(0);
  }, [filtered.length]);

  // Scroll selected item into view
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const item = list.children[selectedIndex] as HTMLElement | undefined;
    item?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const close = () => dispatch({ type: 'TOGGLE_KEYBOARD_SHORTCUTS' });

  const execute = (shortcut: Shortcut) => {
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
        setSelectedIndex((i) => (i < filtered.length - 1 ? i + 1 : 0));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setSelectedIndex((i) => (i > 0 ? i - 1 : filtered.length - 1));
        break;
      case 'Enter': {
        e.preventDefault();
        const target = filtered[selectedIndex];
        if (target) execute(target);
        break;
      }
    }
  };

  return (
    <div
      className="fixed inset-0 z-20 flex items-center justify-center bg-black/30 backdrop-blur-sm focus:outline-none"
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
        <div ref={listRef} className="p-2 space-y-0.5 overflow-y-auto">
          {filtered.length === 0 ? (
            <div className="px-2 py-3 text-sm text-slate-500 text-center">No matches</div>
          ) : (
            filtered.map((s, i) => (
              <div
                key={s.key}
                className={`flex items-center justify-between px-2 py-1.5 rounded cursor-pointer ${
                  i === selectedIndex ? 'bg-slate-700' : 'hover:bg-slate-700/50'
                }`}
                onClick={() => execute(s)}
                onMouseEnter={() => setSelectedIndex(i)}
              >
                <span className="text-sm text-slate-300">{s.label}</span>
                <kbd className="px-2 py-0.5 text-xs font-mono bg-slate-700 border border-slate-600 rounded text-slate-300">
                  {s.key.includes('Shift+') ? `⌘⇧${s.key.replace('Shift+', '')}` : `⌘${s.key}`}
                </kbd>
              </div>
            ))
          )}
        </div>
        <div className="px-4 pb-3 pt-2 border-t border-slate-700">
          <p className="text-xs text-slate-500">Click URLs in terminal to open in browser</p>
        </div>
      </div>
    </div>
  );
}
