import { useEffect } from 'react';
import type { AppState } from '../context/AppContext';

type AppAction =
  | { type: 'SET_ACTIVE_TASK'; taskId: string | null }
  | { type: 'UPDATE_TASK'; task: import('../../shared/types').Task }
  | { type: 'SHOW_CREATE_TASK_DIALOG'; show: boolean }
  | { type: 'TOGGLE_REPO_MANAGER' }
  | { type: 'TOGGLE_DIFF' }
  | { type: 'TOGGLE_TASK_HISTORY' };

export function useKeyboard(state: AppState, dispatch: React.Dispatch<AppAction>) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!e.metaKey) return;

      const key = e.key.toLowerCase();

      // Cmd+1 through Cmd+9: switch to task at index
      if (key >= '1' && key <= '9') {
        const activeTasks = state.tasks.filter((t) => t.status !== 'archived');
        const index = parseInt(key, 10) - 1;
        if (index < activeTasks.length) {
          e.preventDefault();
          dispatch({ type: 'SET_ACTIVE_TASK', taskId: activeTasks[index].id });
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
            window.bifrost.archiveTask(taskId).then((updated) => {
              dispatch({ type: 'UPDATE_TASK', task: updated });
              const activeTasks = state.tasks.filter(
                (t) => t.id !== taskId && t.status !== 'archived',
              );
              dispatch({
                type: 'SET_ACTIVE_TASK',
                taskId: activeTasks.length > 0 ? activeTasks[activeTasks.length - 1].id : null,
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
