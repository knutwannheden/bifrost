import React, { useRef, useEffect, useState, useCallback } from 'react';
import '@xterm/xterm/css/xterm.css';
import { useApp, getActiveDiffState } from '../context/AppContext';
import { useTerminal } from '../hooks/useTerminal';
import TerminalSearchBar from './TerminalSearchBar';
import { isModKey } from '../utils/platform';

interface TerminalPaneProps {
  sessionId: string;
  taskId?: string;
  active: boolean;
  focused: boolean;
  hideCursor?: boolean;
  paneType?: 'claude' | 'dev';
  onFocusRequest?: () => void;
  onTitleChange?: (title: string) => void;
}

function LoadingOverlay() {
  const [dots, setDots] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setDots((d) => (d + 1) % 4), 400);
    return () => clearInterval(id);
  }, []);
  return (
    <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-10">
      <span className="text-muted text-sm font-mono">
        Loading{'.'.repeat(dots)}
      </span>
    </div>
  );
}

export default function TerminalPane({ sessionId, active, focused, hideCursor = false, paneType, onFocusRequest, onTitleChange }: TerminalPaneProps) {
  const { state } = useApp();
  const containerRef = useRef<HTMLDivElement>(null);
  const [showSearch, setShowSearch] = useState(false);

  const fontSize = state.config?.fontSize ?? 14;
  const fontFamily = state.config?.fontFamily;
  const fontWeight = state.config?.fontWeight;

  const { terminal, loading } = useTerminal(sessionId, containerRef, onTitleChange, { hideCursor, fontSize, fontFamily, fontWeight, visible: active, paneType });

  // Focus the terminal when it becomes the focused pane and no overlays are showing.
  // When `focused` transitions to true, the caller explicitly wants focus (e.g. discussion
  // terminal inside the diff overlay), so skip the overlay guard in that case.
  const { showDiff } = getActiveDiffState(state);
  const anyOverlay = state.showRepoManager || state.showCreateDialog || showDiff || state.showTaskHistory || state.showKeyboardShortcuts || state.showSettings || state.showNotes || state.showStats || state.showSupervisor;
  const prevFocused = useRef(false);
  useEffect(() => {
    const becameFocused = focused && !prevFocused.current;
    prevFocused.current = focused;
    if (active && focused && terminal.current && !showSearch && (becameFocused || !anyOverlay)) {
      terminal.current.focus();
    }
  }, [anyOverlay, active, focused, terminal, showSearch]);

  // Listen for Cmd+F to open search bar
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (isModKey(e) && !e.shiftKey && e.key.toLowerCase() === 'f' && focused && active && !anyOverlay) {
        e.preventDefault();
        setShowSearch(true);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [focused, active, anyOverlay]);

  const handleSearchClose = useCallback(() => {
    setShowSearch(false);
    terminal.current?.scrollToBottom();
    terminal.current?.focus();
  }, [terminal]);

  return (
    <div
      className="w-full h-full relative"
      style={{
        backgroundColor: 'var(--color-app)',
        borderTop: focused ? '2px solid var(--color-accent-hover)' : '2px solid transparent',
      }}
      onMouseDown={onFocusRequest}
    >
      {showSearch && (
        <TerminalSearchBar sessionId={sessionId} onClose={handleSearchClose} />
      )}
      {loading && <LoadingOverlay />}
      <div ref={containerRef} className="w-full h-full" />
    </div>
  );
}
