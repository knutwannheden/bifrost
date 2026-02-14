import React, { useRef, useEffect } from 'react';
import '@xterm/xterm/css/xterm.css';
import { useApp } from '../context/AppContext';
import { useTerminal } from '../hooks/useTerminal';

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

  const fontSize = state.config?.fontSize ?? 14;
  const { terminal } = useTerminal(sessionId, containerRef, onTitleChange, { hideCursor, fontSize });

  // Focus the terminal when it becomes the focused pane and no overlays are showing
  const anyOverlay = state.showRepoManager || state.showCreateDialog || state.showDiff || state.showTaskHistory;
  useEffect(() => {
    if (!anyOverlay && active && focused && terminal.current) {
      terminal.current.focus();
    }
  }, [anyOverlay, active, focused, terminal]);

  return (
    <div
      ref={containerRef}
      className="w-full h-full"
      style={{
        backgroundColor: '#282a36',
        borderTop: focused ? '2px solid #3b82f6' : '2px solid transparent',
      }}
      onMouseDown={onFocusRequest}
    />
  );
}
