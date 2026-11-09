import type { SessionState, Task } from '../../shared/types';
import type { AppAction } from '../context/AppContext';

type Dispatch = (action: AppAction) => void;

/** Each ask runs tmux, or calls another instance, so a long task list is asked a few at a time. */
const ASKED_AT_ONCE = 8;

/** Which of these sessions a restart takes, and which of those hold a draft a restart loses. */
export function planRestart(entries: Array<{ task: Task; state: SessionState | null }>): {
  restart: Task[];
  busy: Task[];
  drafted: Task[];
} {
  const live = entries.filter((e) => e.state?.live);
  const between = live.filter((e) => !e.state?.busy);
  return {
    restart: between.map((e) => e.task),
    busy: live.filter((e) => e.state?.busy).map((e) => e.task),
    drafted: between.filter((e) => e.state?.draft).map((e) => e.task),
  };
}

/**
 * Restarts the Claude session of each running task that has one, one after
 * another, and leaves a session that is mid-turn alone. Unless forced, it first
 * names the sessions with a draft at their prompt, and restarts only when told.
 */
export async function restartSessions(tasks: Task[], dispatch: Dispatch, force = false): Promise<void> {
  const running = tasks.filter((t) => t.status === 'running');
  const entries: Array<{ task: Task; state: SessionState | null }> = [];
  for (let i = 0; i < running.length; i += ASKED_AT_ONCE) {
    const batch = running.slice(i, i + ASKED_AT_ONCE);
    entries.push(...(await Promise.all(batch.map(async (task) => ({ task, state: await stateOf(task) })))));
  }
  const plan = planRestart(entries);
  if (!force && plan.drafted.length > 0) {
    dispatch({
      type: 'SHOW_TOAST',
      message: `A restart loses the text typed at the prompt in ${names(plan.drafted)}.`,
      duration: 15_000,
      action: { label: 'Restart anyway', callback: () => void restartSessions(tasks, dispatch, true) },
    });
    return;
  }

  const skipped = [...plan.busy];
  const failed: Task[] = [];
  let restarted = 0;
  for (const [i, task] of plan.restart.entries()) {
    dispatch({ type: 'SHOW_TOAST', message: `Restarting ${i + 1} of ${plan.restart.length}: ${task.name}` });
    const now = await stateOf(task);
    if (!now?.live) continue;
    if (now.busy) {
      skipped.push(task);
      continue;
    }
    try {
      dispatch({ type: 'UPDATE_TASK', task: await window.bifrost.stopTask(task.id) });
      dispatch({ type: 'UPDATE_TASK', task: await window.bifrost.reopenTask(task.id) });
      restarted++;
    } catch {
      failed.push(task);
    }
  }
  const parts = [`Restarted ${restarted} session${restarted === 1 ? '' : 's'}`];
  if (skipped.length > 0) parts.push(`skipped mid-turn: ${names(skipped)}`);
  if (failed.length > 0) parts.push(`failed: ${names(failed)}`);
  dispatch({
    type: 'SHOW_TOAST',
    message: `${parts.join(' · ')}.`,
    duration: skipped.length + failed.length ? 10_000 : 4000,
  });
}

/** Null when the instance that owns the task cannot be asked, as when its machine is away. */
function stateOf(task: Task): Promise<SessionState | null> {
  return window.bifrost.getSessionState(task.id).catch(() => null);
}

function names(tasks: Task[]): string {
  return tasks.map((t) => t.name).join(', ');
}
