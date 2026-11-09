/**
 * Restarting sessions takes only those that run and are between turns, and
 * names the ones with text typed at Claude's prompt before it does. Run with
 * `npm run check:restart-sessions`.
 */
import { planRestart } from '../src/renderer/utils/restart-sessions.ts';
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
  const task = (id: string) => ({ id, name: id }) as Task;
  const state = (s: Partial<SessionState>): SessionState => ({ live: true, busy: false, draft: '', ...s });
  const plan = planRestart([
    { task: task('idle'), state: state({}) },
    { task: task('typed'), state: state({ draft: 'half a thought' }) },
    { task: task('busy'), state: state({ busy: true }) },
    { task: task('none'), state: state({ live: false }) },
    { task: task('away'), state: null },
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

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
