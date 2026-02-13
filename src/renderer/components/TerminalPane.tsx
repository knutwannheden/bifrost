import React, { useRef, useEffect, useCallback } from 'react';
import '@xterm/xterm/css/xterm.css';
import { useApp } from '../context/AppContext';
import { useTerminal } from '../hooks/useTerminal';

interface TerminalPaneProps {
  taskId: string;
  sessionId: string;
  active: boolean;
}

export default function TerminalPane({ taskId, sessionId, active }: TerminalPaneProps) {
  const { state } = useApp();
  const containerRef = useRef<HTMLDivElement>(null);

  const handleTitleChange = useCallback((title: string) => {
    if (active) {
      window.bifrost.setTerminalTitle(taskId, title);
    }
  }, [taskId, active]);

  const { terminal } = useTerminal(sessionId, containerRef, handleTitleChange);

  // Focus the terminal when it becomes active and no overlays are showing
  useEffect(() => {
    const anyOverlay = state.showRepoManager || state.showCreateDialog || state.showDiff || state.showTaskHistory;
    if (!anyOverlay && active && terminal.current) {
      terminal.current.focus();
    }
  }, [state.showRepoManager, state.showCreateDialog, state.showDiff, state.showTaskHistory, active, terminal]);

  return (
    <div
      ref={containerRef}
      className="w-full h-full"
      style={{ backgroundColor: '#0f172a' }}
    />
  );
}
