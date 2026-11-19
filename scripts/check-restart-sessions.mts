/**
 * Restarting sessions takes those that run and are between turns, and names the
 * ones with text typed at Claude's prompt before it does. One that is mid-turn
 * restarts once its turn has ended. Run with `npm run check:restart-sessions`.
 */
import { planRestart, restartAll } from '../src/renderer/utils/restart-sessions.ts';
import { promptDraft } from '../src/shared/prompt-draft.ts';
import type { SessionState, Task } from '../src/shared/types.ts';

let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? 'ok' : 'FAIL'} — ${name}${ok || !detail ? '' : `\n  ${detail}`}`);
}
const show = (value: unknown) => JSON.stringify(value);

// Screens as `tmux capture-pane -e` prints them. Claude pads the prompt with a no-break space.
const rule = '\x1b[2m────────────────────────────────────────\x1b[0m';
const screen = (input: string) =>
  ['● Done. Next, run:', '  ❯ npm test', '', rule, `\x1b[39m❯ ${input}`, rule, '  ⏵⏵ bypass permissions on'].join('\n');
{
  const empty = promptDraft(screen(''));
  const suggested = promptDraft(screen('\x1b[2mrun the template push\x1b[0m'));
  const typed = promptDraft(screen('fix the \x1b[1mbuild\x1b[22m first'));
  const menu = promptDraft(['● Done.', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No'].join('\n'));
  check(
    "a draft is the text typed at Claude's prompt, not its faint suggestion, a menu's choice or a ❯ in the conversation",
    empty === '' && suggested === '' && typed === 'fix the build first' && menu === '',
    show({ empty, suggested, typed, menu }),
  );
}

{
  // Codex marks its earlier prompts with a faint › and its placeholder faint too.
  const codex = (composer: string) =>
    [
      '\x1b[1;2m› \x1b[0mReply with ok.',
      '• ok',
      '  Worked for 2s',
      `\x1b[1m›\x1b[0m ${composer}`,
      '  GPT-6-Luna default · ~/repo',
    ].join('\n');
  const placeholder = promptDraft(codex('\x1b[2mAsk Codex to do anything\x1b[0m'));
  const typed = promptDraft(codex('hello draft'));
  check(
    "a draft at Codex's › prompt is its typed text, not its placeholder or an earlier prompt",
    placeholder === '' && typed === 'hello draft',
    show({ placeholder, typed }),
  );
}

{
  const task = (id: string) => ({ id, name: id }) as Task;
  const state = (s: Partial<SessionState>): SessionState => ({ live: true, busy: false, draft: '', ...s });
  const plan = planRestart([
    { session: task('idle'), state: state({}) },
    { session: task('typed'), state: state({ draft: 'half a thought' }) },
    { session: task('busy'), state: state({ busy: true }) },
    { session: task('none'), state: state({ live: false }) },
    { session: task('away'), state: null },
  ]);
  const ids = (tasks: Task[]) => tasks.map((t) => t.id);
  check(
    'a restart takes the sessions that run between turns, names those with a draft, and leaves out the rest',
    show(ids(plan.restart)) === show(['idle', 'typed']) &&
      show(ids(plan.drafted)) === show(['typed']) &&
      show(ids(plan.busy)) === show(['busy']),
    show({ restart: ids(plan.restart), drafted: ids(plan.drafted), busy: ids(plan.busy) }),
  );
}

{
  const state = (s: Partial<SessionState>): SessionState => ({ live: true, busy: false, draft: '', ...s });
  /** A session whose state the check sets, counting how often it is asked and restarted. */
  const fake = (key: string) => {
    const session = {
      key,
      name: key,
      now: state({ busy: true }),
      checks: 0,
      restarts: 0,
      state: async () => {
        session.checks++;
        return session.now;
      },
      restart: async () => {
        session.restarts++;
      },
    };
    return session;
  };
  const EVERY_MS = 10;
  const ignore = () => {};
  const pause = () => new Promise((r) => setTimeout(r, EVERY_MS * 4));

  const ending = fake('ending');
  await restartAll([ending], ignore, false, EVERY_MS);
  await pause();
  const midTurn = ending.restarts;
  ending.now = state({ draft: 'half a thought' });
  await pause();
  const typed = ending.restarts;
  ending.now = state({});
  await pause();
  const ended = ending.restarts;
  await pause();
  check(
    'a session mid-turn restarts once its turn has ended and nothing is typed at its prompt',
    midTurn === 0 && typed === 0 && ended === 1 && ending.restarts === 1,
    show({ midTurn, typed, ended, after: ending.restarts }),
  );

  const stopping = fake('stopping');
  await restartAll([stopping], ignore, false, EVERY_MS);
  stopping.now = state({ live: false });
  await pause();
  const checks = stopping.checks;
  await pause();
  check(
    'a session that stops running while it waits is no longer asked',
    stopping.restarts === 0 && stopping.checks === checks,
    show({ restarts: stopping.restarts, checks: [checks, stopping.checks] }),
  );

  const twice = fake('twice');
  await restartAll([twice], ignore, false, EVERY_MS);
  twice.now = state({});
  await restartAll([twice], ignore, false, EVERY_MS);
  const byRun = twice.restarts;
  await pause();
  check(
    'a later run leaves a session that waits to its wait, which restarts it once',
    byRun === 0 && twice.restarts === 1,
    show({ byRun, total: twice.restarts }),
  );
}

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
