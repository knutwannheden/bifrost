import type { AppAction, AppState } from '../context/AppContext';
import { nextActiveTaskId } from './next-active-task';

/**
 * Archive a task immediately: switch active tab then remove worktree.
 * Used both for clean worktrees (direct) and after force-archive confirmation.
 */
export function performArchive(taskId: string, state: AppState, dispatch: React.Dispatch<AppAction>): void {
  // Archiving from a row's menu can target a task the user is not on, and only
  // the tab being archived out from under them needs replacing.
  if (state.activeTaskId === taskId) {
    dispatch({ type: 'SET_ACTIVE_TASK', taskId: nextActiveTaskId(state, taskId) });
  }
  window.bifrost.archiveTask(taskId).then((updated) => {
    dispatch({ type: 'UPDATE_TASK', task: updated });
  });
}

/**
 * Request archiving a task. If the worktree is dirty, shows a confirmation
 * dialog; otherwise archives immediately.
 */
export async function requestArchive(
  taskId: string,
  taskName: string,
  state: AppState,
  dispatch: React.Dispatch<AppAction>,
): Promise<void> {
  const dirty = await window.bifrost.isWorktreeDirty(taskId);
  if (dirty) {
    dispatch({ type: 'SHOW_ARCHIVE_CONFIRM', taskId, taskName });
  } else {
    performArchive(taskId, state, dispatch);
  }
}
