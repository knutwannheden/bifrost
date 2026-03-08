import type { AppAction, AppState } from '../context/AppContext';

/**
 * Archive a task immediately: switch active tab then remove worktree.
 * Used both for clean worktrees (direct) and after force-archive confirmation.
 */
export function performArchive(taskId: string, state: AppState, dispatch: React.Dispatch<AppAction>): void {
  const running = state.tasks.filter((t) => t.status === 'running');
  const idx = running.findIndex((t) => t.id === taskId);
  const remaining = running.filter((t) => t.id !== taskId);
  // Pick the next tab, or the previous one if archiving the last tab
  const nextIdx = Math.min(idx, remaining.length - 1);
  dispatch({
    type: 'SET_ACTIVE_TASK',
    taskId: nextIdx >= 0 ? remaining[nextIdx].id : null,
  });
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
