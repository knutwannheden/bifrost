/**
 * A task is working while its subagents are, whatever the turn-level hooks say,
 * and a subagent whose stop never arrives stops holding the turn open.
 * Run with `npm run check:activity-state`.
 */
import {
  forgetTask,
  SUBAGENT_MAX_MS,
  subagentStarted,
  subagentStopped,
  subagentsRunning,
  sweepHeldTurns,
  turnEnded,
} from '../src/main/activity-state.ts';

let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? 'ok' : 'FAIL'} — ${name}${ok || !detail ? '' : `\n${detail}`}`);
}

const T0 = 1_000_000;

{
  forgetTask('t');
  subagentStarted('t', T0);
  subagentStarted('t', T0);
  check('a turn does not end while subagents run', turnEnded('t', T0 + 1) === false);
  check('the first subagent back does not end it either', subagentStopped('t', T0 + 2) === false);
  check('the last one back ends the held turn', subagentStopped('t', T0 + 3) === true);
  check('a turn is ended once, not once per stop', subagentStopped('t', T0 + 4) === false);
}

{
  // A stop that arrives with no turn waiting on it has nothing to end.
  forgetTask('t');
  subagentStarted('t', T0);
  check('a subagent back before the turn ends nothing', subagentStopped('t', T0 + 1) === false);
}

{
  forgetTask('t');
  check('a turn with no subagents ends at once', turnEnded('t', T0) === true);
  const before = subagentsRunning('t', T0);
  subagentStarted('t', T0);
  check('a task is working exactly while a subagent is out', !before && subagentsRunning('t', T0));
}

{
  forgetTask('t');
  subagentStarted('t', T0);
  turnEnded('t', T0 + 1);
  check('a stale subagent stops counting', subagentsRunning('t', T0 + SUBAGENT_MAX_MS + 1) === false);
  check('the turn it held open is finished by the sweep', sweepHeldTurns(T0 + SUBAGENT_MAX_MS + 1).join(',') === 't');
  check('and only once', sweepHeldTurns(T0 + SUBAGENT_MAX_MS + 2).length === 0);
}

{
  forgetTask('t');
  subagentStarted('t', T0);
  turnEnded('t', T0 + 1);
  check('a live subagent is left alone by the sweep', sweepHeldTurns(T0 + 2).length === 0);
}

{
  forgetTask('t');
  subagentStarted('t', T0);
  forgetTask('t');
  check('a new turn starts with no subagents outstanding', turnEnded('t', T0 + 1) === true);
}

process.exit(failed === 0 ? 0 : 1);
