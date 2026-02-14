import React, { useEffect } from 'react';
import { useApp } from './context/AppContext';
import type { BifrostAPI } from '../shared/ipc-channels';
import { useKeyboard } from './hooks/useKeyboard';
import TaskBar from './components/TaskBar';
import TaskView from './components/TaskView';
import StatusBar from './components/StatusBar';
import RepoManager from './components/RepoManager';
import TaskCreateDialog from './components/TaskCreateDialog';
import DiffOverlay from './components/DiffOverlay';
import TaskHistoryPanel from './components/TaskHistoryPanel';

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
    const unsub = window.bifrost.onSessionExit((sessionId, _code) => {
      const task = state.tasks.find((t) => t.sessionId === sessionId);
      if (task) {
        dispatch({ type: 'SET_TASK_STATUS', taskId: task.id, status: 'stopped' });
      }
    });
    return unsub;
  }, [state.tasks, dispatch]);

  // Listen for session data to mark non-active tasks as unread
  useEffect(() => {
    const unsub = window.bifrost.onSessionData((sessionId, _data) => {
      const task = state.tasks.find((t) => t.sessionId === sessionId);
      if (task && task.id !== state.activeTaskId) {
        dispatch({ type: 'SET_TASK_UNREAD', taskId: task.id, hasUnread: true });
      }
    });
    return unsub;
  }, [state.tasks, state.activeTaskId, dispatch]);

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
