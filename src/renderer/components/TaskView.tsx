import React, { useCallback, useEffect, useState } from 'react';
import type { PaneTarget } from '../context/AppContext';
import { defaultPaneState, useApp } from '../context/AppContext';
import { altSymbol, modSymbol, shiftSymbol } from '../utils/platform';
import Kbd from './Kbd';
import TerminalPane from './TerminalPane';

const shortcuts = [
  { keys: 'Cmd+R', label: 'Add a repository' },
  { keys: 'Cmd+T', label: 'Create a new task' },
  { keys: 'Cmd+H', label: 'Resume from history' },
  { keys: 'Cmd+K', label: 'Command palette' },
];

const tips = [
  'Most views support instant search \u2014 just start typing to filter. Space-separated terms are ANDed.',
  `Underlined characters in buttons are mnemonics \u2014 press ${altSymbol}that letter to activate.`,
  'Double-click a task tab to rename it inline.',
  `Press ${modSymbol}D to view git diff and activity log for the current task.`,
  'Hover over a task tab to see its summary, branch, and current activity.',
  `Use ${modSymbol}F to search within the terminal. Enter/Shift+Enter to navigate matches.`,
  'Each task runs in its own git worktree \u2014 agents work independently without conflicts.',
  `Press ${modSymbol}H to browse task history and resume archived tasks.`,
  `Use ${modSymbol}K to open the command palette for quick access to all actions.`,
  `Press ${modSymbol}, to open settings and customize font size, IDE, and more.`,
  `Press ${modSymbol}/ to open a dev terminal alongside Claude \u2014 press again to toggle focus between panes.`,
  `Press ${modSymbol}${shiftSymbol}C to capture context and copy a [Bifrost #N] reference to clipboard \u2014 paste it into any Claude Code session to share context.`,
  `Press ${modSymbol}U to run an AI review of your task\u2019s changes \u2014 get actionable feedback before committing.`,
  'When a permission prompt appears, press Tab to focus it \u2014 then use A/D to allow/deny, Esc to deny once.',
  `Press ${modSymbol}- to jump back to your previous tab \u2014 like cd - for tasks.`,
  `Press ${modSymbol}= to jump to the last tab that had a notification.`,
  `Copy a GitHub PR URL before pressing ${modSymbol}T \u2014 the new task dialog will auto-fill the PR details.`,
];

export default function TaskView() {
  const { state, dispatch } = useApp();
  const [splitRatio, setSplitRatio] = useState(0.7);
  const [integrationNeeded, setIntegrationNeeded] = useState(false);
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [justInstalled, setJustInstalled] = useState(false);
  const [tipIndex, setTipIndex] = useState(() => Math.floor(Math.random() * tips.length));
  const [ghMissing, setGhMissing] = useState(false);

  const openTasks = state.tasks.filter((t) => t.status === 'running');
  const activeTask = openTasks.find((t) => t.id === state.activeTaskId);

  const handlePaneFocus = useCallback(
    (taskId: string, pane: PaneTarget) => {
      dispatch({ type: 'SET_PANE_FOCUS', taskId, pane });
    },
    [dispatch],
  );

  const handleTitleChange = useCallback(
    (taskId: string, title: string) => {
      if (taskId === state.activeTaskId) {
        window.bifrost.setTerminalTitle(taskId, title);
      }
    },
    [state.activeTaskId],
  );

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
      window.bifrost.checkGhAvailable().then((available) => {
        setGhMissing(!available);
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
      dispatch({
        type: 'SHOW_TOAST',
        message: updateAvailable ? 'Claude integration updated' : 'Claude integration installed',
      });
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
        <div className="text-center text-muted max-w-md">
          <p className="text-2xl font-semibold text-primary mb-2">BIFROST</p>
          <p className="text-sm text-secondary mb-6 leading-relaxed">
            A keyboard-centric command center for orchestrating parallel Claude Code sessions. Each task runs in its own
            isolated git worktree, so agents work independently without stepping on each other.
          </p>
          {(integrationNeeded || updateAvailable || justInstalled) && (
            <div className="mb-6 flex flex-col items-center gap-2">
              {justInstalled ? (
                <span className="text-sm text-success">&#10003; {updateAvailable ? 'Updated' : 'Installed'}</span>
              ) : (
                <button
                  onClick={handleInstallIntegration}
                  disabled={installing}
                  className="px-4 py-2 bg-accent hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed text-white rounded text-sm font-medium transition-colors"
                >
                  {installing
                    ? updateAvailable
                      ? 'Updating...'
                      : 'Installing...'
                    : updateAvailable
                      ? 'Update Claude Integration'
                      : 'Install Claude Integration'}
                </button>
              )}
              <p className="text-xs text-muted max-w-sm text-center">
                {updateAvailable
                  ? 'A new version of the Bifrost plugin is available.'
                  : 'Adds the Bifrost MCP server and skills to your Claude Code configuration.'}
              </p>
            </div>
          )}
          {ghMissing && (
            <div className="mb-6">
              <div className="inline-flex items-center gap-2 bg-warning/10 border border-warning/30 rounded-full px-4 py-2">
                <span className="text-xs text-warning">
                  Install{' '}
                  <a
                    href="https://cli.github.com"
                    onClick={(e) => {
                      e.preventDefault();
                      window.bifrost.openUrl('https://cli.github.com');
                    }}
                    className="underline hover:text-warning/70"
                  >
                    GitHub CLI
                  </a>{' '}
                  to enable PR-based task creation
                </span>
              </div>
            </div>
          )}
          <div className="inline-grid grid-cols-[auto_auto] gap-x-4 gap-y-1.5 text-left">
            {shortcuts.map((s) => (
              <React.Fragment key={s.keys}>
                <Kbd size="sm">{s.keys}</Kbd>
                <span className="text-xs text-secondary">{s.label}</span>
              </React.Fragment>
            ))}
          </div>
          {state.config?.showTips !== false && (
            <div className="mt-6 flex flex-col items-center gap-1.5">
              <div className="bg-surface-alt/50 border border-border-input/50 rounded-full px-4 py-2 flex items-center gap-2 max-w-sm">
                <span className="text-warning text-sm flex-shrink-0">&#x1F4A1;</span>
                <p className="text-xs text-secondary leading-relaxed">{tips[tipIndex]}</p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setTipIndex((i) => (i + 1) % tips.length)}
                  className="text-[10px] text-muted hover:text-secondary transition-colors"
                >
                  Next tip
                </button>
                <span className="text-[10px] text-faint">|</span>
                <button
                  onClick={async () => {
                    if (!state.config) return;
                    const newConfig = { ...state.config, showTips: false };
                    await window.bifrost.saveConfig(newConfig);
                    dispatch({ type: 'SET_CONFIG', config: newConfig });
                  }}
                  className="text-[10px] text-faint hover:text-secondary transition-colors"
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
          <div key={task.id} className="absolute inset-0 flex flex-col" style={{ display: isActive ? 'flex' : 'none' }}>
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
                sessionId={task.id}
                taskId={task.id}
                active={isActive}
                focused={ps.focusedPane === 'claude'}
                hideCursor
                paneType="claude"
                onFocusRequest={() => handlePaneFocus(task.id, 'claude')}
                onTitleChange={(title) => handleTitleChange(task.id, title)}
              />
            </div>

            {/* Draggable divider between panes */}
            {showDev && showClaude && (
              <div
                className="flex-shrink-0 bg-border-default hover:bg-accent cursor-row-resize transition-colors"
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
                  paneType="dev"
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
