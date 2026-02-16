import React, { useCallback, useEffect, useState } from 'react';
import { useApp, defaultPaneState } from '../context/AppContext';
import type { PaneTarget } from '../context/AppContext';
import TerminalPane from './TerminalPane';

const shortcuts = [
  { keys: '⌘R', label: 'Add a repository' },
  { keys: '⌘T', label: 'Create a new task' },
  { keys: '⌘H', label: 'Resume from history' },
  { keys: '⌘K', label: 'Command palette' },
];

const tips = [
  'Most views support instant search \u2014 just start typing to filter. Space-separated terms are ANDed.',
  'Underlined characters in buttons are mnemonics \u2014 press Option + that letter to activate.',
  'Double-click a task tab to rename it inline.',
  'Press \u2318D to view git diff and activity log for the current task.',
  'Hover over a task tab to see its summary, branch, and current activity.',
  'Use \u2318F to search within the terminal. Enter/Shift+Enter to navigate matches.',
  'Each task runs in its own git worktree \u2014 agents work independently without conflicts.',
  'Press \u2318H to browse task history and resume archived tasks.',
  'Use \u2318K to open the command palette for quick access to all actions.',
  'Press \u2318, to open settings and customize font size, IDE, and more.',
];

export default function TaskView() {
  const { state, dispatch } = useApp();
  const [splitRatio, setSplitRatio] = useState(0.7);
  const [integrationNeeded, setIntegrationNeeded] = useState(false);
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [justInstalled, setJustInstalled] = useState(false);
  const [tipIndex, setTipIndex] = useState(() => Math.floor(Math.random() * tips.length));

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

  // Check integration status when welcome screen would show
  useEffect(() => {
    if (!activeTask && state.tasksLoaded && openTasks.length === 0) {
      window.bifrost.checkIntegration().then((status) => {
        setIntegrationNeeded(!status.installed);
        setUpdateAvailable(status.updateAvailable);
      });
    }
  }, [activeTask, state.tasksLoaded, openTasks.length]);

  const handleInstallIntegration = useCallback(async () => {
    setInstalling(true);
    try {
      await window.bifrost.installIntegration();
      setIntegrationNeeded(false);
      setUpdateAvailable(false);
      setJustInstalled(true);
      dispatch({ type: 'SHOW_TOAST', message: updateAvailable ? 'Claude integration updated' : 'Claude integration installed' });
      setTimeout(() => setJustInstalled(false), 2000);
    } catch (err) {
      dispatch({ type: 'SHOW_TOAST', message: `Install failed: ${err instanceof Error ? err.message : String(err)}` });
    } finally {
      setInstalling(false);
    }
  }, [dispatch]);

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
          {(integrationNeeded || updateAvailable || justInstalled) && (
            <div className="mb-6 flex flex-col items-center gap-2">
              {justInstalled ? (
                <span className="text-sm text-green-400">&#10003; {updateAvailable ? 'Updated' : 'Installed'}</span>
              ) : (
                <button
                  onClick={handleInstallIntegration}
                  disabled={installing}
                  className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-slate-700 text-white rounded-lg text-sm font-medium transition-colors"
                >
                  {installing ? (updateAvailable ? 'Updating...' : 'Installing...') : (updateAvailable ? 'Update Claude Integration' : 'Install Claude Integration')}
                </button>
              )}
              <p className="text-xs text-slate-500 max-w-sm text-center">
                {updateAvailable
                  ? 'A new version of the Bifrost plugin is available.'
                  : 'Adds the Bifrost MCP server and skills to your Claude Code configuration.'}
              </p>
            </div>
          )}
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
          {state.config?.showTips !== false && (
            <div className="mt-6 flex flex-col items-center gap-1.5">
              <div className="bg-slate-700/50 border border-slate-600/50 rounded-full px-4 py-2 flex items-center gap-2 max-w-sm">
                <span className="text-amber-400 text-sm flex-shrink-0">&#x1F4A1;</span>
                <p className="text-xs text-slate-300 leading-relaxed">
                  {tips[tipIndex]}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setTipIndex((i) => (i + 1) % tips.length)}
                  className="text-[10px] text-slate-500 hover:text-slate-300 transition-colors"
                >
                  Next tip
                </button>
                <span className="text-[10px] text-slate-700">|</span>
                <button
                  onClick={async () => {
                    if (!state.config) return;
                    const newConfig = { ...state.config, showTips: false };
                    await window.bifrost.saveConfig(newConfig);
                    dispatch({ type: 'SET_CONFIG', config: newConfig });
                  }}
                  className="text-[10px] text-slate-600 hover:text-slate-400 transition-colors"
                >
                  Don&apos;t show tips
                </button>
              </div>
            </div>
          )}
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
