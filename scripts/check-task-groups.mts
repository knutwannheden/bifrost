import assert from 'node:assert/strict';
import { taskSections } from '../src/renderer/utils/task-groups.ts';
import type { EpicState, Task } from '../src/shared/types.ts';

const now = Date.now();
const old = now - 14 * 24 * 60 * 60 * 1000;
const epic: EpicState = { goal: 'Ship the feature', template: 'Review each change', updates: [], checkedThrough: 0 };
const task = (id: string, fields: Partial<Task> = {}): Task => ({
  id,
  name: id,
  repoId: 'repo',
  baseBranch: 'main',
  branch: id,
  worktreePath: `/worktrees/${id}`,
  status: 'running',
  hasUnread: false,
  createdAt: old,
  ...fields,
});
const root = task('epic', { epic });
const worker = task('worker', { createdByTaskId: root.id, lastTurnBoundaryAt: now });
const companion = task('companion', { createdByTaskId: root.id });

const sections = (tasks: Task[], overrides: Partial<Parameters<typeof taskSections>[1]> = {}) =>
  taskSections(tasks, {
    pinnedIds: [],
    collapsedBuckets: [],
    expandedEpicIds: new Set(),
    activeTaskId: null,
    matchedIds: null,
    ...overrides,
  });
const rows = (result: ReturnType<typeof sections>) => result.flatMap(({ rows }) => rows.map(({ task }) => task.id));

const recentGroup = sections([companion, worker, root]);
assert.equal(recentGroup[0]?.bucket, 'Last 10 minutes', 'a recent worker moves the entire epic');
assert.deepEqual(rows(recentGroup), ['epic'], 'an epic starts collapsed');
assert.deepEqual(
  rows(sections([companion, worker, root], { expandedEpicIds: new Set([root.id]) })),
  ['epic', 'worker', 'companion'],
  'expanding an epic reveals its workers',
);

const folded = sections([root, worker, companion], {
  collapsedBuckets: ['Last 10 minutes'],
  activeTaskId: worker.id,
});
assert.deepEqual(rows(folded), ['epic', 'worker'], 'a folded section keeps the selected worker and its parent visible');
const filtered = sections([root, worker, companion], {
  collapsedBuckets: ['Last 10 minutes'],
  matchedIds: new Set([companion.id]),
});
assert.deepEqual(rows(filtered), ['epic', 'companion'], 'a matching worker overrides both folds and gives it context');

const inherited = task('inherited', { createdByTaskId: 'old-coordinator', lastTurnBoundaryAt: now });
const epicWithAttachment = task('epic', {
  epic: {
    ...epic,
    updates: [{ kind: 'attach', taskId: inherited.id, seq: 1, at: now, authorTaskId: root.id }],
  },
});
const pinned = sections([epicWithAttachment, inherited], {
  pinnedIds: [inherited.id],
  expandedEpicIds: new Set([root.id]),
});
assert.equal(pinned[0]?.bucket, 'Pinned', 'pinning a member pins the group');
assert.deepEqual(rows(pinned), ['epic', 'inherited'], 'an attached worker is grouped by the current epic');

const archived = sections([{ ...root, status: 'archived' }, worker]);
assert.deepEqual(rows(archived), ['worker'], 'the archived parent leaves its live worker available');
assert.equal(archived[0]?.rows[0]?.child, false, 'the worker returns to its own row');

const ordinary = sections([{ ...root, epic: undefined }, worker]);
assert.deepEqual(rows(ordinary), ['worker', 'epic'], 'an ordinary creator and its child remain separate tasks');

console.log('Epic task groups passed');
