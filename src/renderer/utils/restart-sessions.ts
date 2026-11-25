import type { SessionState, Task } from '../../shared/types';
import type { AppAction } from '../context/AppContext';

type Dispatch = (action: AppAction) => void;

/** Each ask runs tmux, or calls another instance, so a long list is asked a few at a time. */
const ASKED_AT_ONCE = 8;
/** How often a session left mid-turn is asked whether its turn has ended. */
const TURN_CHECK_MS = 5000;

/** One session the restart can ask about and restart, a task's or a console. */
interface Restartable {
  /** The task's id, or the console's machine, which tells the session apart across runs. */
  key: string;
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

/** The sessions waiting for their turn to end, by key. Only that wait restarts them. */
const waiting = new Set<string>();

/**
 * Restarts the Claude session of each running task that has one, then each
 * console. `consoles` names the machine of each, '' for this one.
 */
export async function restartSessions(tasks: Task[], consoles: string[], dispatch: Dispatch): Promise<void> {
  await restartAll(
    [
      // An adopted session is not Bifrost's to restart.
      ...tasks.filter((t) => t.status === 'running' && !t.adopted).map((t) => taskSession(t, dispatch)),
      ...consoles.map(consoleSession),
    ],
    dispatch,
  );
}

/**
 * Restarts these sessions one after another, and each that is mid-turn once its
 * turn has ended. Unless forced, it first names the sessions with a draft at
 * their prompt, and restarts only when told.
 */
export async function restartAll(
  all: Restartable[],
  dispatch: Dispatch,
  force = false,
  everyMs = TURN_CHECK_MS,
): Promise<void> {
  const already = all.filter((s) => waiting.has(s.key));
  const sessions = all.filter((s) => !waiting.has(s.key));
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
      action: { label: 'Restart anyway', callback: () => void restartAll(all, dispatch, true, everyMs) },
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
  for (const session of skipped) void restartWhenIdle(session, dispatch, everyMs);
  const later = [...already, ...skipped];
  const parts = [`Restarted ${restarted} session${restarted === 1 ? '' : 's'}`];
  if (later.length > 0) parts.push(`restarting once their turn ends: ${names(later)}`);
  if (failed.length > 0) parts.push(`failed: ${names(failed)}`);
  dispatch({
    type: 'SHOW_TOAST',
    message: `${parts.join(' · ')}.`,
    duration: later.length + failed.length ? 10_000 : 4000,
  });
}

/** Restarts the session at the first check that finds it between turns with nothing typed at its prompt. */
async function restartWhenIdle(session: Restartable, dispatch: Dispatch, everyMs: number): Promise<void> {
  waiting.add(session.key);
  try {
    for (;;) {
      await new Promise((r) => setTimeout(r, everyMs));
      const state = await session.state();
      if (!state?.live) return;
      if (state.busy || state.draft) continue;
      await session.restart();
      dispatch({ type: 'SHOW_TOAST', message: `Restarted ${session.name}, whose turn ended.` });
      return;
    }
  } catch {
    dispatch({ type: 'SHOW_TOAST', message: `Restarting ${session.name} failed.` });
  } finally {
    waiting.delete(session.key);
  }
}

function taskSession(task: Task, dispatch: Dispatch): Restartable {
  return {
    key: task.id,
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
    key: `console:${machine}`,
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
