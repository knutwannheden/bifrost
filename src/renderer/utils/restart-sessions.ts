import type { SessionState, Task } from '../../shared/types';
import type { AppAction } from '../context/AppContext';

type Dispatch = (action: AppAction) => void;

/** Each ask runs tmux, or calls another instance, so a long list is asked a few at a time. */
const ASKED_AT_ONCE = 8;

/** One session the restart can ask about and restart, a task's or a console. */
interface Restartable {
  name: string;
  /** Null when the instance that runs it cannot be asked, as when its machine is away. */
  state(): Promise<SessionState | null>;
  restart(): Promise<void>;
}

/** Which of these sessions a restart takes, and which of those hold a draft a restart loses. */
export function planRestart<T>(entries: Array<{ session: T; state: SessionState | null }>): {
  restart: T[];
  busy: T[];
  drafted: T[];
} {
  const live = entries.filter((e) => e.state?.live);
  const between = live.filter((e) => !e.state?.busy);
  return {
    restart: between.map((e) => e.session),
    busy: live.filter((e) => e.state?.busy).map((e) => e.session),
    drafted: between.filter((e) => e.state?.draft).map((e) => e.session),
  };
}

/**
 * Restarts the Claude session of each running task that has one, then each
 * console, one after another, and leaves a session that is mid-turn alone.
 * Unless forced, it first names the sessions with a draft at their prompt, and
 * restarts only when told. `consoles` names the machine of each, '' for this one.
 */
export async function restartSessions(
  tasks: Task[],
  consoles: string[],
  dispatch: Dispatch,
  force = false,
): Promise<void> {
  const sessions = [
    ...tasks.filter((t) => t.status === 'running').map((t) => taskSession(t, dispatch)),
    ...consoles.map(consoleSession),
  ];
  const entries: Array<{ session: Restartable; state: SessionState | null }> = [];
  for (let i = 0; i < sessions.length; i += ASKED_AT_ONCE) {
    const batch = sessions.slice(i, i + ASKED_AT_ONCE);
    entries.push(...(await Promise.all(batch.map(async (session) => ({ session, state: await session.state() })))));
  }
  const plan = planRestart(entries);
  if (!force && plan.drafted.length > 0) {
    dispatch({
      type: 'SHOW_TOAST',
      message: `A restart loses the text typed at the prompt in ${names(plan.drafted)}.`,
      duration: 15_000,
      action: { label: 'Restart anyway', callback: () => void restartSessions(tasks, consoles, dispatch, true) },
    });
    return;
  }

  const skipped = [...plan.busy];
  const failed: Restartable[] = [];
  let restarted = 0;
  for (const [i, session] of plan.restart.entries()) {
    dispatch({ type: 'SHOW_TOAST', message: `Restarting ${i + 1} of ${plan.restart.length}: ${session.name}` });
    const now = await session.state();
    if (!now?.live) continue;
    if (now.busy) {
      skipped.push(session);
      continue;
    }
    try {
      await session.restart();
      restarted++;
    } catch {
      failed.push(session);
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

function taskSession(task: Task, dispatch: Dispatch): Restartable {
  return {
    name: task.name,
    state: () => window.bifrost.getSessionState(task.id).catch(() => null),
    restart: async () => {
      dispatch({ type: 'UPDATE_TASK', task: await window.bifrost.stopTask(task.id) });
      dispatch({ type: 'UPDATE_TASK', task: await window.bifrost.reopenTask(task.id) });
    },
  };
}

/** A console carries its conversation on, where a reset from its overlay starts a new one. */
function consoleSession(machine: string): Restartable {
  return {
    name: machine ? `Console on ${machine}` : 'Console',
    state: () => window.bifrost.consoleState(machine || undefined).catch(() => null),
    restart: async () => {
      await window.bifrost.resetConsole(machine || undefined, true);
    },
  };
}

function names(sessions: Restartable[]): string {
  return sessions.map((s) => s.name).join(', ');
}
