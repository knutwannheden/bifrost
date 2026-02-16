import React, { useRef, useEffect, useState, useCallback } from 'react';
import '@xterm/xterm/css/xterm.css';
import { useApp } from '../context/AppContext';
import { useTerminal } from '../hooks/useTerminal';
import TerminalSearchBar from './TerminalSearchBar';

interface TerminalPaneProps {
  sessionId: string;
  taskId?: string;
  active: boolean;
  focused: boolean;
  hideCursor?: boolean;
  onFocusRequest?: () => void;
  onTitleChange?: (title: string) => void;
}

export default function TerminalPane({ sessionId, taskId, active, focused, hideCursor = false, onFocusRequest, onTitleChange }: TerminalPaneProps) {
  const { state, dispatch } = useApp();
  const containerRef = useRef<HTMLDivElement>(null);
  const [showSearch, setShowSearch] = useState(false);

  const fontSize = state.config?.fontSize ?? 14;
  const fontFamily = state.config?.fontFamily;
  const fontWeight = state.config?.fontWeight;

  const notifications = state.config?.notifications !== false;

  const handleBell = useCallback(() => {
    if (!taskId || !notifications) return;
    const task = state.tasks.find((t) => t.id === taskId);
    if (!task) return;

    // Toast + blue ball only for background tasks
    if (taskId !== state.activeTaskId) {
      dispatch({ type: 'SHOW_TOAST', message: `${task.name}: Waiting for input`, duration: 5000 });
      dispatch({ type: 'SET_TASK_UNREAD', taskId, hasUnread: true });
    }

    // Sound, OS notification, dock bounce via main process
    window.bifrost.notifyBell(taskId);
  }, [taskId, notifications, state.tasks, state.activeTaskId, dispatch]);

  const { terminal } = useTerminal(sessionId, containerRef, onTitleChange, { hideCursor, fontSize, fontFamily, fontWeight, visible: active, onBell: handleBell });

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
