import { useEffect } from 'react';
import type { AppState, DiffMode } from '../context/AppContext';

type AppAction =
  | { type: 'SET_ACTIVE_TASK'; taskId: string | null }
  | { type: 'UPDATE_TASK'; task: import('../../shared/types').Task }
  | { type: 'SHOW_CREATE_TASK_DIALOG'; show: boolean }
  | { type: 'TOGGLE_REPO_MANAGER' }
  | { type: 'TOGGLE_DIFF' }
  | { type: 'TOGGLE_TASK_HISTORY' }
  | { type: 'SET_DIFF_MODE'; mode: DiffMode };

export function useKeyboard(state: AppState, dispatch: React.Dispatch<AppAction>) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!e.metaKey) return;

      const key = e.key.toLowerCase();

      // Cmd+Shift+[ or Cmd+Shift+]: switch to prev/next tab
      if (e.shiftKey && (e.code === 'BracketLeft' || e.code === 'BracketRight')) {
        e.preventDefault();
        const openTasks = state.tasks.filter((t) => t.status === 'running');
        if (openTasks.length === 0) return;
        const currentIdx = openTasks.findIndex((t) => t.id === state.activeTaskId);
        let newIdx: number;
        if (e.code === 'BracketLeft') {
          newIdx = currentIdx <= 0 ? openTasks.length - 1 : currentIdx - 1;
        } else {
          newIdx = currentIdx >= openTasks.length - 1 ? 0 : currentIdx + 1;
        }
        dispatch({ type: 'SET_ACTIVE_TASK', taskId: openTasks[newIdx].id });
        return;
      }

      // Cmd+1 through Cmd+9: switch to task at index
      if (key >= '1' && key <= '9') {
        const openTasks = state.tasks.filter((t) => t.status === 'running');
        const index = parseInt(key, 10) - 1;
        if (index < openTasks.length) {
          e.preventDefault();
          dispatch({ type: 'SET_ACTIVE_TASK', taskId: openTasks[index].id });
        }
        return;
      }

      switch (key) {
        case 't':
          e.preventDefault();
          dispatch({ type: 'SHOW_CREATE_TASK_DIALOG', show: true });
          break;

        case 'w': {
          e.preventDefault();
          if (state.activeTaskId) {
            const taskId = state.activeTaskId;
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

        case 'r':
          e.preventDefault();
          dispatch({ type: 'TOGGLE_REPO_MANAGER' });
          break;

        case 'd':
          e.preventDefault();
          dispatch({ type: 'TOGGLE_DIFF' });
          break;

        case 'h':
          e.preventDefault();
          dispatch({ type: 'TOGGLE_TASK_HISTORY' });
          break;

        case 'o': {
          e.preventDefault();
          const activeTask = state.tasks.find((t) => t.id === state.activeTaskId);
          if (activeTask) {
            window.bifrost.openInIde(activeTask.worktreePath);
          }
          break;
        }
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [state, dispatch]);
}
