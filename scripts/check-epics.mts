import assert from 'node:assert/strict';
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import type { Task } from '../src/shared/types.ts';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bifrost-epics-'));
process.env.HOME = home;
process.env.TMUX_TMPDIR = home;

const sourceImports = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.includes('/src/') && specifier.startsWith('.') && !path.extname(specifier)) {
      return next(`${specifier}.ts`, context);
    }
    return next(specifier, context);
  },
});

const { closeDatabase, getDb, openDatabase } = await import('../src/main/db.ts');
const { getEpic, markEpicCheckedIn, reportEpicResult, updateEpic } = await import('../src/main/epic-service.ts');
const { forgetTasks, getTasks, importTasks, prepareTaskHandover, updateTask } = await import(
  '../src/main/task-service.ts'
);
const { loadTasks } = await import('../src/main/task-store.ts');
const { createEpicState } = await import('../src/shared/epic.ts');

function task(id: string, fields: Partial<Task> = {}): Task {
  return {
    id,
    name: id,
    repoId: 'repo',
    baseBranch: 'main',
    worktreePath: path.join(home, id),
    status: 'stopped',
    hasUnread: false,
    createdAt: 1,
    ...fields,
  };
}

try {
  openDatabase();
  getDb().exec('ALTER TABLE tasks DROP COLUMN epic; UPDATE schema_version SET version = 11');
  closeDatabase();
  openDatabase();

  const epic = createEpicState({ goal: 'Improve search', template: 'Implement and measure.\n' });
  importTasks(
    [
      task('epic', { epic }),
      task('measure', { createdByTaskId: 'epic' }),
      task('existing', { createdByTaskId: 'old-coordinator' }),
      task('other-epic', { epic }),
      task('other-member', { createdByTaskId: 'other-epic' }),
    ],
    [],
  );
  const read = () => getEpic('epic', getTasks());
  const change = (action: unknown) => updateEpic('epic', 'epic', action, getTasks());
  assert.deepEqual(
    read().members.map((member) => member.id),
    ['measure'],
  );
  assert.throws(() => change({ kind: 'attach', taskId: 'other-member' }), /another epic/);
  change({ kind: 'attach', taskId: 'existing' });
  assert.deepEqual(
    read().members.map((member) => member.id),
    ['measure', 'existing'],
  );
  assert.equal(getTasks().find(({ id }) => id === 'existing')?.createdByTaskId, 'old-coordinator');
  console.log('ok — direct and attached membership preserve who created each task');

  const item = { kind: 'item', id: 'perf', title: 'Measure search', status: 'open' };
  const added = change({ ...item, taskId: 'measure' });
  assert.throws(() => updateEpic('epic', 'measure', { ...item, status: 'done' }, getTasks()), /coordinator/);
  const report = { itemId: 'perf', reportId: 'run-1', text: 'p95 down 20%', revision: 'candidate-1' };
  assert.throws(() => reportEpicResult('epic', 'existing', report, getTasks()), /assigned/);
  const reported = reportEpicResult('epic', 'measure', report, getTasks());
  assert.equal(read().items[0].status, 'open');
  change({ ...item, status: 'done' });
  assert.deepEqual(reportEpicResult('epic', 'measure', report, getTasks()), reported);
  assert.throws(() => reportEpicResult('epic', 'measure', { ...report, revision: 'different' }, getTasks()), /already/);
  assert.deepEqual(
    read().items.map(({ status, addedSeq, taskId }) => ({ status, addedSeq, taskId })),
    [{ status: 'done', addedSeq: added.seq, taskId: 'measure' }],
  );
  console.log('ok — reports retain author and revision and replay without advancing progress');

  const question = { kind: 'decision', id: 'cache', question: 'Allow cached results?' };
  const scope = { itemId: 'perf', reference: 'design-v2' };
  const pending = change({ ...question, ...scope, status: 'needs-user', recommendation: 'Keep results fresh' });
  const resolved = change({ ...question, status: 'resolved', answer: 'Keep results fresh', decidedBy: 'user' });
  markEpicCheckedIn('epic', pending.seq);
  markEpicCheckedIn('epic', added.seq);
  assert.equal(read().epic.checkedThrough, pending.seq);
  assert.deepEqual(
    read().epic.updates.filter((entry) => entry.seq > pending.seq),
    [resolved],
  );
  assert.deepEqual(read().decisions, [
    { ...question, ...scope, status: 'resolved', answer: 'Keep results fresh', decidedBy: 'user' },
  ]);
  closeDatabase();
  openDatabase();
  assert.deepEqual(loadTasks().find(({ id }) => id === 'epic')?.epic, read().epic);
  console.log('ok — check-in preserves later changes and the journal survives a reopen');

  updateTask('epic', { machine: 'perf' });
  const handed = prepareTaskHandover('perf', ['epic']);
  assert.equal(handed[0].epic?.updates.at(-1)?.seq, resolved.seq);
  assert.equal(handed[0].epic?.handoffPending, undefined);
  assert.equal(loadTasks().find(({ id }) => id === 'epic')?.epic?.handoffPending, true);
  assert.throws(() => change({ kind: 'note', text: 'Written by sender' }), /handover/);
  forgetTasks(['epic']);
  importTasks(handed, []);
  const afterHandover = change({ kind: 'note', text: 'Written by recipient' });
  importTasks(handed, []);
  assert.equal(read().epic.updates.at(-1)?.seq, afterHandover.seq);
  console.log('ok — only the recipient can write after a handoff and import retries preserve its journal');
} finally {
  closeDatabase();
  sourceImports.deregister();
  fs.rmSync(home, { recursive: true, force: true });
}
