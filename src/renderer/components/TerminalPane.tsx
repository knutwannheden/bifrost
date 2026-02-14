import React, { useRef, useEffect, useCallback } from 'react';
import '@xterm/xterm/css/xterm.css';
import { useApp } from '../context/AppContext';
import { useTerminal } from '../hooks/useTerminal';

interface TerminalPaneProps {
  taskId: string;
  sessionId: string;
  active: boolean;
  focused: boolean;
  hideCursor?: boolean;
  onFocusRequest?: () => void;
  onTitleChange?: (title: string) => void;
}

export default function TerminalPane({ taskId, sessionId, active, focused, hideCursor = false, onFocusRequest, onTitleChange }: TerminalPaneProps) {
  const { state } = useApp();
  const containerRef = useRef<HTMLDivElement>(null);

  const handleTitleChange = useCallback((title: string) => {
    onTitleChange?.(title);
  }, [onTitleChange]);

  const { terminal } = useTerminal(sessionId, containerRef, handleTitleChange, { hideCursor });

  // Focus the terminal when it becomes the focused pane and no overlays are showing
  useEffect(() => {
    const anyOverlay = state.showRepoManager || state.showCreateDialog || state.showDiff || state.showTaskHistory;
    if (!anyOverlay && active && focused && terminal.current) {
      terminal.current.focus();
    }
  }, [state.showRepoManager, state.showCreateDialog, state.showDiff, state.showTaskHistory, active, focused, terminal]);

  return (
    <div
      ref={containerRef}
      className="w-full h-full"
      style={{
        backgroundColor: '#0f172a',
        borderTop: focused ? '2px solid #3b82f6' : '2px solid transparent',
      }}
      onMouseDown={onFocusRequest}
    />
  );
}
