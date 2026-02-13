import { useEffect } from 'react';
import type { AppState } from '../context/AppContext';

type AppAction =
  | { type: 'SET_ACTIVE_TASK'; taskId: string | null }
  | { type: 'REMOVE_TASK'; taskId: string }
  | { type: 'SHOW_CREATE_TASK_DIALOG'; show: boolean }
  | { type: 'TOGGLE_REPO_MANAGER' }
  | { type: 'TOGGLE_DIFF' };

export function useKeyboard(state: AppState, dispatch: React.Dispatch<AppAction>) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!e.metaKey) return;

      const key = e.key.toLowerCase();

      // Cmd+1 through Cmd+9: switch to task at index
      if (key >= '1' && key <= '9') {
        const index = parseInt(key, 10) - 1;
        if (index < state.tasks.length) {
          e.preventDefault();
          dispatch({ type: 'SET_ACTIVE_TASK', taskId: state.tasks[index].id });
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
            window.bifrost.closeTask(state.activeTaskId).then(() => {
              dispatch({ type: 'REMOVE_TASK', taskId: state.activeTaskId! });
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
