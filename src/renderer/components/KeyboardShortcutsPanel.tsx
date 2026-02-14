import React, { useEffect, useRef } from 'react';
import { useApp } from '../context/AppContext';

const shortcuts = [
  { key: 'T', label: 'New task' },
  { key: 'W', label: 'Close pane / stop task' },
  { key: '/', label: 'Toggle dev terminal' },
  { key: 'D', label: 'Git diff' },
  { key: 'A', label: 'Activity log' },
  { key: 'R', label: 'Repositories' },
  { key: 'H', label: 'Task history' },
  { key: 'O', label: 'Open in IDE' },
  { key: 'K', label: 'Keyboard shortcuts' },
  { key: 'Shift+C', label: 'Capture context' },
  { key: 'Shift+[', label: 'Previous tab' },
  { key: 'Shift+]', label: 'Next tab' },
  { key: '1-9', label: 'Switch to tab N' },
];

export default function KeyboardShortcutsPanel() {
  const { dispatch } = useApp();
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    overlayRef.current?.focus();
  }, []);

  const close = () => dispatch({ type: 'TOGGLE_KEYBOARD_SHORTCUTS' });

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };

  return (
    <div
      ref={overlayRef}
      tabIndex={-1}
      className="fixed inset-0 z-20 flex items-center justify-center bg-black/60 focus:outline-none"
      onClick={close}
      onKeyDown={handleKeyDown}
    >
      <div
        className="bg-slate-800 rounded-lg border border-slate-600 w-[400px] flex flex-col shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700">
          <h2 className="text-sm font-semibold text-slate-200">Keyboard Shortcuts</h2>
          <button
            onClick={close}
            tabIndex={-1}
            className="text-slate-400 hover:text-slate-200 text-lg leading-none"
          >
            &times;
          </button>
        </div>
        <div className="p-4 space-y-1.5">
          {shortcuts.map((s) => (
            <div key={s.key} className="flex items-center justify-between py-1">
              <span className="text-sm text-slate-300">{s.label}</span>
              <kbd className="px-2 py-0.5 text-xs font-mono bg-slate-700 border border-slate-600 rounded text-slate-300">
                Cmd+{s.key}
              </kbd>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
