/**
 * A starting Bifrost joins the sessions still running in tmux at once, and
 * leaves the rest for their tabs. A session id that cannot resume is dropped,
 * but never one a running session uses. Run with `npm run check:restore-plan`.
 */
import { planRestore } from '../src/main/restore-plan.ts';
import type { Task } from '../src/shared/types.ts';

let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? 'ok' : 'FAIL'} — ${name}${ok || !detail ? '' : `\n  ${detail}`}`);
}
const show = (value: unknown) => JSON.stringify(value);

const task = (id: string, extra: Partial<Task> = {}): Task =>
  ({ id, name: id, worktreePath: `/wt/${id}`, sessionId: `sid-${id}`, status: 'running', ...extra }) as Task;
const everyTranscriptStale = () => true;
const everyWorktreeThere = () => true;

{
  const plan = planRestore([task('live')], new Set(['live']), everyTranscriptStale, everyWorktreeThere);
  check(
    'a task whose session still runs in tmux is joined at once and keeps its session id',
    show(plan.join) === show(['live']) && plan.defer.length === 0 && plan.dropSessionId.length === 0,
    show(plan),
  );
}

{
  const plan = planRestore([task('gone')], new Set(), everyTranscriptStale, everyWorktreeThere);
  check(
    'a task whose session is gone waits for its tab and drops a session id that cannot resume',
    plan.join.length === 0 && show(plan.defer) === show(['gone']) && show(plan.dropSessionId) === show(['gone']),
    show(plan),
  );
}

{
  const remote = task('remote', { machine: 'perf' });
  const missing = task('missing');
  const plan = planRestore(
    [remote, missing],
    new Set(['remote']),
    everyTranscriptStale,
    (p) => p !== missing.worktreePath,
  );
  check(
    'a task on another machine waits for its tab with its session id, and one whose worktree is gone stays stopped',
    plan.join.length === 0 && show(plan.defer) === show(['remote']) && plan.dropSessionId.length === 0,
    show(plan),
  );
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
