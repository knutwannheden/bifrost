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
    collapsedEpics: new Set(),
    activeTaskId: null,
    matchedIds: null,
    ...overrides,
  });
const rows = (result: ReturnType<typeof sections>) => result.flatMap(({ rows }) => rows.map(({ task }) => task.id));

const recentGroup = sections([companion, worker, root]);
assert.equal(recentGroup[0]?.bucket, 'Last 10 minutes', 'a recent worker moves the entire epic');
assert.deepEqual(rows(recentGroup), ['epic', 'worker', 'companion'], 'the parent is followed by both workers');

const folded = sections([root, worker, companion], {
  collapsedBuckets: ['Last 10 minutes'],
  collapsedEpics: new Set([root.id]),
  activeTaskId: worker.id,
});
assert.deepEqual(rows(folded), ['epic', 'worker'], 'a folded section keeps the selected worker and its parent visible');
const filtered = sections([root, worker, companion], {
  collapsedBuckets: ['Last 10 minutes'],
  collapsedEpics: new Set([root.id]),
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
const pinned = sections([epicWithAttachment, inherited], { pinnedIds: [inherited.id] });
assert.equal(pinned[0]?.bucket, 'Pinned', 'pinning a member pins the group');
assert.deepEqual(rows(pinned), ['epic', 'inherited'], 'an attached worker is grouped by the current epic');

const archived = sections([{ ...root, status: 'archived' }, worker]);
assert.deepEqual(rows(archived), ['worker'], 'the archived parent leaves its live worker available');
assert.equal(archived[0]?.rows[0]?.child, false, 'the worker returns to its own row');

const ordinary = sections([{ ...root, epic: undefined }, worker]);
assert.deepEqual(rows(ordinary), ['worker', 'epic'], 'an ordinary creator and its child remain separate tasks');

console.log('Epic task groups passed');
