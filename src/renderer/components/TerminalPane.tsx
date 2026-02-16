import React, { useRef, useEffect, useState, useCallback } from 'react';
import '@xterm/xterm/css/xterm.css';
import { useApp } from '../context/AppContext';
import { useTerminal } from '../hooks/useTerminal';
import TerminalSearchBar from './TerminalSearchBar';

interface TerminalPaneProps {
  sessionId: string;
  active: boolean;
  focused: boolean;
  hideCursor?: boolean;
  onFocusRequest?: () => void;
  onTitleChange?: (title: string) => void;
}

export default function TerminalPane({ sessionId, active, focused, hideCursor = false, onFocusRequest, onTitleChange }: TerminalPaneProps) {
  const { state } = useApp();
  const containerRef = useRef<HTMLDivElement>(null);
  const [showSearch, setShowSearch] = useState(false);

  const fontSize = state.config?.fontSize ?? 14;
  const { terminal } = useTerminal(sessionId, containerRef, onTitleChange, { hideCursor, fontSize, visible: active });

  // Focus the terminal when it becomes the focused pane and no overlays are showing
  const anyOverlay = state.showRepoManager || state.showCreateDialog || state.showDiff || state.showTaskHistory;
  useEffect(() => {
    if (!anyOverlay && active && focused && terminal.current && !showSearch) {
      terminal.current.focus();
    }
  }, [anyOverlay, active, focused, terminal, showSearch]);

  // Listen for Cmd+F to open search bar
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.metaKey && !e.shiftKey && e.key.toLowerCase() === 'f' && focused && active && !anyOverlay) {
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
        backgroundColor: '#282a36',
        borderTop: focused ? '2px solid #3b82f6' : '2px solid transparent',
      }}
      onMouseDown={onFocusRequest}
    >
      {showSearch && (
        <TerminalSearchBar sessionId={sessionId} onClose={handleSearchClose} />
      )}
      <div ref={containerRef} className="w-full h-full" />
    </div>
  );
}
