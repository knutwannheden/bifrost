/**
 * Reloading the task list, as when another instance connects or goes away,
 * keeps what only the renderer knows about a task. Run with `npm run check:task-sync`.
 */

import { syncTasks } from '../src/renderer/utils/sync-tasks.ts';
import type { Task } from '../src/shared/types.ts';

let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? 'ok' : 'FAIL'} — ${name}${ok || !detail ? '' : `\n  ${detail}`}`);
}
const show = (value: unknown) => JSON.stringify(value);
const task = (id: string, extra: Partial<Task> = {}): Task => ({
  id,
  name: id,
  repoId: 'r',
  baseBranch: 'main',
  worktreePath: `/w/${id}`,
  status: 'running',
  hasUnread: false,
  createdAt: 1,
  ...extra,
});

{
  const current = [task('a', { name: 'old', hasUnread: true, claudeActive: true }), task('gone')];
  const synced = syncTasks(current, [task('a', { name: 'new', unreachable: true }), task('b')]);
  const a = synced.find((t) => t.id === 'a');
  check(
    'a reload takes the tasks from their owners and keeps the unread mark and activity the renderer set',
    synced.map((t) => t.id).join() === 'a,b' &&
      a?.name === 'new' &&
      a.unreachable === true &&
      a.hasUnread === true &&
      a.claudeActive === true,
    show(synced),
  );
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
