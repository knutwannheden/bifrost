import React, { useEffect } from 'react';
import { useApp, defaultPaneState } from './context/AppContext';
import type { PaneTarget } from './context/AppContext';
import type { BifrostAPI } from '../shared/ipc-channels';
import { useKeyboard } from './hooks/useKeyboard';
import TaskBar from './components/TaskBar';
import TaskView from './components/TaskView';
import StatusBar from './components/StatusBar';
import RepoManager from './components/RepoManager';
import TaskCreateDialog from './components/TaskCreateDialog';
import DiffOverlay from './components/DiffOverlay';
import TaskHistoryPanel from './components/TaskHistoryPanel';
import KeyboardShortcutsPanel from './components/KeyboardShortcutsPanel';
import SettingsOverlay from './components/SettingsOverlay';

declare global {
  interface Window {
    bifrost: BifrostAPI;
  }
}

export default function App() {
  const { state, dispatch } = useApp();

  useKeyboard(state, dispatch);

  const activeTask = state.tasks.find((t) => t.id === state.activeTaskId) ?? null;

  // Mark active task as read when switching to it
  useEffect(() => {
    if (state.activeTaskId) {
      dispatch({ type: 'SET_TASK_UNREAD', taskId: state.activeTaskId, hasUnread: false });
    }
  }, [state.activeTaskId, dispatch]);

  // Listen for session exit to update task status
  useEffect(() => {
    const unsub = window.bifrost.onSessionExit((sessionId, code) => {
      const task = state.tasks.find((t) => t.sessionId === sessionId);
      if (task && task.status !== 'archived') {
        dispatch({ type: 'SET_TASK_STATUS', taskId: task.id, status: 'stopped' });
        if (code !== 0 && code !== 143) { // 143 = SIGTERM (intentional kill)
          dispatch({ type: 'SHOW_TOAST', message: `${task.name} exited with code ${code}` });
        }
      }
    });
    return unsub;
  }, [state.tasks, dispatch]);

  // Mark non-active tasks as unread when new JSONL activity arrives
  // (actual Claude interactions, not terminal noise).
  useEffect(() => {
    const unsub = window.bifrost.onActivityEntry((entry) => {
      if (entry.type === 'claude_event' && entry.taskId !== state.activeTaskId) {
        dispatch({ type: 'SET_TASK_UNREAD', taskId: entry.taskId, hasUnread: true });
      }
    });
    return unsub;
  }, [state.activeTaskId, dispatch]);

  // Listen for menu actions from the main process
  useEffect(() => {
    const unsub = window.bifrost.onMenuAction((action) => {
      switch (action) {
        case 'new-task':
          dispatch({ type: 'SHOW_CREATE_TASK_DIALOG', show: true });
          break;
        case 'repositories':
          dispatch({ type: 'TOGGLE_REPO_MANAGER' });
          break;
        case 'diff':
          dispatch({ type: 'TOGGLE_DIFF' });
          break;
        case 'task-history':
          dispatch({ type: 'TOGGLE_TASK_HISTORY' });
          break;
        case 'toggle-dev-terminal': {
          if (!state.activeTaskId) break;
          const taskId = state.activeTaskId;
          const ps = state.paneStates[taskId] ?? defaultPaneState;
          if (!ps.devSessionId) {
            window.bifrost.createDevTerminal(taskId).then((devSessionId) => {
              dispatch({ type: 'SET_DEV_SESSION', taskId, devSessionId });
            });
          } else if (ps.claudeHidden) {
            dispatch({ type: 'SHOW_PANE', taskId, pane: 'claude' });
            dispatch({ type: 'SET_PANE_FOCUS', taskId, pane: 'claude' });
          } else if (ps.devHidden) {
            dispatch({ type: 'SHOW_PANE', taskId, pane: 'dev' });
            dispatch({ type: 'SET_PANE_FOCUS', taskId, pane: 'dev' });
          } else {
            const newFocus: PaneTarget = ps.focusedPane === 'claude' ? 'dev' : 'claude';
            dispatch({ type: 'SET_PANE_FOCUS', taskId, pane: newFocus });
          }
          break;
        }
        case 'close-pane': {
          if (!state.activeTaskId) break;
          const taskId = state.activeTaskId;
          const ps = state.paneStates[taskId] ?? defaultPaneState;
          const hiding = ps.focusedPane;
          const otherPane: PaneTarget = hiding === 'claude' ? 'dev' : 'claude';
          const otherHidden = otherPane === 'claude' ? ps.claudeHidden : ps.devHidden;
          const otherExists = otherPane === 'dev' ? !!ps.devSessionId : true;
          if (otherExists && !otherHidden) {
            // Other pane visible — hide focused pane, switch to other
            dispatch({ type: 'HIDE_PANE', taskId, pane: hiding });
            dispatch({ type: 'SET_PANE_FOCUS', taskId, pane: otherPane });
          } else {
            // Other pane hidden or doesn't exist — closing last visible pane stops the task
            if (ps.devSessionId) {
              window.bifrost.closeDevTerminal(taskId);
              dispatch({ type: 'CLOSE_DEV_SESSION', taskId });
            }
            window.bifrost.stopTask(taskId).then((updated) => {
              dispatch({ type: 'UPDATE_TASK', task: updated });
              const remaining = state.tasks.filter(
                (t) => t.id !== taskId && t.status === 'running',
              );
              dispatch({
                type: 'SET_ACTIVE_TASK',
                taskId: remaining.length > 0 ? remaining[remaining.length - 1].id : null,
              });
            });
          }
          break;
        }
        case 'archive-task': {
          const archiveId = state.activeTaskId;
          if (!archiveId) break;
          window.bifrost.archiveTask(archiveId).then((updated) => {
            dispatch({ type: 'UPDATE_TASK', task: updated });
            const remaining = state.tasks.filter(
              (t) => t.id !== archiveId && t.status === 'running',
            );
            dispatch({
              type: 'SET_ACTIVE_TASK',
              taskId: remaining.length > 0 ? remaining[remaining.length - 1].id : null,
            });
          });
          break;
        }
        case 'quit-confirm':
          dispatch({ type: 'SHOW_TOAST', message: 'Press ⌘Q again to quit' });
          break;
        case 'open-in-ide': {
          const task = state.tasks.find((t) => t.id === state.activeTaskId);
          if (task) {
            // From menu, try last changed file as fallback
            window.bifrost.getLastChangedFile(task.id)
              .then((lastFile) => window.bifrost.openInIde(task.worktreePath, lastFile ?? undefined))
              .catch(() => window.bifrost.openInIde(task.worktreePath));
          }
          break;
        }
      }
    });
    return unsub;
  }, [state, dispatch]);

  // Show toast when an agent finishes and the task is not active
  useEffect(() => {
    const unsub = window.bifrost.onAgentNotification((taskId, title, body) => {
      if (taskId === state.activeTaskId) return; // task is visible, suppress
      const truncated = body.length > 100 ? body.slice(0, 100) + '...' : body;
      dispatch({ type: 'SHOW_TOAST', message: `${title}: ${truncated}` });
    });
    return unsub;
  }, [state.activeTaskId, dispatch]);

  // Auto-dismiss toast after 2s
  useEffect(() => {
    if (!state.toast) return;
    const timer = setTimeout(() => dispatch({ type: 'HIDE_TOAST' }), 2000);
    return () => clearTimeout(timer);
  }, [state.toast, dispatch]);

  const handleToggleIde = async () => {
    if (!state.config) return;
    const newIde = state.config.ide === 'code' ? 'idea' : 'code';
    await window.bifrost.setIde(newIde);
    dispatch({ type: 'SET_CONFIG', config: { ...state.config, ide: newIde } });
  };

  return (
    <div className="flex flex-col h-screen bg-slate-900 text-slate-200">
      {/* Title bar drag area */}
      <div className="h-8 bg-slate-800 border-b border-slate-700 flex items-center justify-center"
           style={{ WebkitAppRegion: 'drag', paddingLeft: 78 } as React.CSSProperties}>
        <span className="text-xs font-semibold tracking-wide text-slate-500">BIFROST</span>
      </div>

      {/* Task tab bar */}
      <TaskBar />

      {/* Main content: terminal */}
      <TaskView />

      {/* Status bar */}
      <StatusBar
        activeTask={activeTask}
        config={state.config}
        repos={state.repos}
        apiPort={state.apiPort}
        onToggleIde={handleToggleIde}
      />

      {/* Modals */}
      {state.showRepoManager && <RepoManager />}
      {state.showCreateDialog && <TaskCreateDialog />}
      {state.showTaskHistory && <TaskHistoryPanel />}
      {state.showKeyboardShortcuts && <KeyboardShortcutsPanel />}
      {state.showSettings && <SettingsOverlay />}

      {/* Diff overlay */}
      <DiffOverlay />

      {/* Toast notification */}
      {state.toast && (
        <div className="fixed bottom-12 left-1/2 -translate-x-1/2 z-50 px-4 py-2 bg-slate-700 text-slate-200 text-sm rounded shadow-lg animate-fade-in">
          {state.toast}
        </div>
      )}
    </div>
  );
}
