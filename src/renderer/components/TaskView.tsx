import React, { useCallback, useEffect, useState } from 'react';
import { useApp, defaultPaneState } from '../context/AppContext';
import type { PaneTarget } from '../context/AppContext';
import TerminalPane from './TerminalPane';

const shortcuts = [
  { keys: '⌘R', label: 'Add a repository' },
  { keys: '⌘T', label: 'Create a new task' },
  { keys: '⌘H', label: 'Resume from history' },
  { keys: '⌘K', label: 'All shortcuts' },
];

export default function TaskView() {
  const { state, dispatch } = useApp();
  const [splitRatio, setSplitRatio] = useState(0.7);

  const openTasks = state.tasks.filter((t) => t.status === 'running');
  const activeTask = openTasks.find((t) => t.id === state.activeTaskId);

  const handlePaneFocus = useCallback((taskId: string, pane: PaneTarget) => {
    dispatch({ type: 'SET_PANE_FOCUS', taskId, pane });
  }, [dispatch]);

  const handleTitleChange = useCallback((taskId: string, title: string) => {
    if (taskId === state.activeTaskId) {
      window.bifrost.setTerminalTitle(taskId, title);
    }
  }, [state.activeTaskId]);

  const handleDividerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const container = (e.target as HTMLElement).parentElement;
    if (!container) return;
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';

    const onMouseMove = (ev: MouseEvent) => {
      const rect = container.getBoundingClientRect();
      const ratio = (ev.clientY - rect.top) / rect.height;
      setSplitRatio(Math.min(0.9, Math.max(0.1, ratio)));
    };

    const onMouseUp = () => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, []);

  // Set window title from task name when active task changes
  useEffect(() => {
    if (activeTask) {
      window.bifrost.setTerminalTitle(activeTask.id, activeTask.name);
    }
  }, [activeTask?.id]);

  if (!activeTask) {
    // Don't show welcome screen while tasks are loading or running tasks exist
    // (avoids flashing during startup task restoration)
    if (!state.tasksLoaded || openTasks.length > 0) {
      return <div className="flex-1" />;
    }
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center text-slate-500 max-w-md">
          <p className="text-2xl font-semibold text-slate-300 mb-2">BIFROST</p>
          <p className="text-sm text-slate-400 mb-6 leading-relaxed">
            A keyboard-centric command center for orchestrating parallel Claude Code sessions.
            Each task runs in its own isolated git worktree, so agents work independently without
            stepping on each other.
          </p>
          <div className="inline-grid grid-cols-[auto_auto] gap-x-4 gap-y-1.5 text-left">
            {shortcuts.map((s) => (
              <React.Fragment key={s.keys}>
                <kbd className="px-1.5 py-0.5 bg-slate-700 rounded text-slate-300 text-xs text-center">
                  {s.keys}
                </kbd>
                <span className="text-xs text-slate-400">{s.label}</span>
              </React.Fragment>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 relative">
      {openTasks.map((task) => {
        const isActive = task.id === state.activeTaskId;
        const ps = state.paneStates[task.id] ?? defaultPaneState;

        const showClaude = !ps.claudeHidden;
        const showDev = !!ps.devSessionId && !ps.devHidden;

        return (
          <div
            key={task.id}
            className="absolute inset-0 flex flex-col"
            style={{ display: isActive ? 'flex' : 'none' }}
          >
            {/* Claude pane — always rendered, hidden via CSS to preserve xterm state */}
            <div
              style={{
                flex: showDev ? `0 0 ${splitRatio * 100}%` : '1 1 0%',
                minHeight: 0,
                display: showClaude ? 'block' : 'none',
                overflow: 'hidden',
                position: 'relative',
              }}
            >
              {/* Main terminal */}
              <div style={{
                position: 'absolute',
                inset: 0,
                display: ps.activeSession === 'main' ? 'block' : 'none',
              }}>
                <TerminalPane
                  sessionId={task.sessionId}
                  active={isActive && ps.activeSession === 'main'}
                  focused={ps.focusedPane === 'claude'}
                  hideCursor
                  onFocusRequest={() => handlePaneFocus(task.id, 'claude')}
                  onTitleChange={(title) => handleTitleChange(task.id, title)}
                />
              </div>
              {/* Review terminal — rendered when session exists, hidden via CSS */}
              {ps.reviewSessionId && (
                <div style={{
                  position: 'absolute',
                  inset: 0,
                  display: ps.activeSession === 'review' ? 'block' : 'none',
                }}>
                  <TerminalPane
                    sessionId={ps.reviewSessionId}
                    active={isActive && ps.activeSession === 'review'}
                    focused={ps.focusedPane === 'claude'}
                    hideCursor
                    themeBackground="#2d2636"
                    onFocusRequest={() => handlePaneFocus(task.id, 'claude')}
                  />
                </div>
              )}
            </div>

            {/* Draggable divider between panes */}
            {showDev && showClaude && (
              <div
                className="flex-shrink-0 bg-slate-700 hover:bg-blue-500 cursor-row-resize transition-colors"
                style={{ height: 4 }}
                onMouseDown={handleDividerMouseDown}
              />
            )}

            {/* Dev terminal pane — rendered when session exists, hidden via CSS */}
            {ps.devSessionId && (
              <div
                style={{
                  flex: '1 1 0%',
                  minHeight: showClaude ? 100 : 0,
                  display: showDev ? 'block' : 'none',
                  overflow: 'hidden',
                }}
              >
                <TerminalPane
                  sessionId={ps.devSessionId}
                  active={isActive}
                  focused={ps.focusedPane === 'dev'}
                  onFocusRequest={() => handlePaneFocus(task.id, 'dev')}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
