import React, { useCallback, useEffect, useState } from 'react';
import { useApp, defaultPaneState } from '../context/AppContext';
import type { PaneTarget } from '../context/AppContext';
import TerminalPane from './TerminalPane';

const shortcuts = [
  { keys: '⌘T', label: 'New task' },
  { keys: '⌘W', label: 'Close pane' },
  { keys: '⌘/', label: 'Toggle dev terminal' },
  { keys: '⌘H', label: 'Task history' },
  { keys: '⌘R', label: 'Repositories' },
  { keys: '⌘D', label: 'View diff' },
  { keys: '⌘O', label: 'Open in IDE' },
  { keys: '⌘1-9', label: 'Switch task' },
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
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center text-slate-500">
          <p className="text-lg mb-4">No active tasks</p>
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
              }}
            >
              <TerminalPane
                sessionId={task.sessionId}
                active={isActive}
                focused={ps.focusedPane === 'claude'}
                hideCursor
                onFocusRequest={() => handlePaneFocus(task.id, 'claude')}
                onTitleChange={(title) => handleTitleChange(task.id, title)}
              />
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
