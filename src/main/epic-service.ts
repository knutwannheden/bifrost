import { projectEpic } from '../shared/epic.ts';
import type { EpicChange, EpicState, EpicUpdate, Task } from '../shared/types.ts';
import { getTask, updateEpicState } from './task-service.ts';

function epicTask(taskId: string): Task & { epic: EpicState } {
  const task = getTask(taskId);
  if (!task.epic) throw new Error(`Task ${taskId} is not an epic`);
  return { ...task, epic: task.epic };
}

function writableEpic(taskId: string): EpicState {
  const { epic } = epicTask(taskId);
  if (epic.handoffPending) throw new Error('Epic handover is pending. Retry once the destination instance takes over.');
  return epic;
}

function epicMembers(taskId: string, attachedTaskIds: string[], visibleTasks: readonly Task[]): Task[] {
  const attached = new Set(attachedTaskIds);
  return visibleTasks.filter((task) => !task.epic && (task.createdByTaskId === taskId || attached.has(task.id)));
}

export function getEpic(taskId: string, visibleTasks: readonly Task[]) {
  const { epic } = epicTask(taskId);
  const progress = projectEpic(epic);
  const members = epicMembers(taskId, progress.attachedTaskIds, visibleTasks).map(
    ({ id, name, status, machine, branch, agent, launch, unreachable, createdByTaskId }) => ({
      id,
      name,
      status,
      machine: machine ?? process.env.BIFROST_MACHINE,
      branch,
      agent: agent ?? 'claude',
      launch,
      unreachable,
      createdByTaskId,
    }),
  );
  return { epic, ...progress, members };
}

function object(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Expected an object');
  return input as Record<string, unknown>;
}

function requiredText(input: Record<string, unknown>, field: string): string {
  const value = input[field];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} must be a nonempty string`);
  return value.trim();
}

function optionalTextFields<Key extends string>(input: Record<string, unknown>, fields: Key[]) {
  const values: Partial<Record<Key, string>> = {};
  for (const field of fields) {
    if (input[field] !== undefined) values[field] = requiredText(input, field);
  }
  return values;
}

function parseCoordinatorChange(input: unknown): Exclude<EpicChange, { kind: 'report' }> {
  const data = object(input);
  const { kind, status } = data;
  switch (kind) {
    case 'item': {
      if (status !== 'open' && status !== 'done' && status !== 'dropped') {
        throw new Error('Item status must be open, done, or dropped');
      }
      return {
        kind,
        id: requiredText(data, 'id'),
        title: requiredText(data, 'title'),
        status,
        ...optionalTextFields(data, ['taskId', 'detail']),
      };
    }
    case 'decision': {
      if (status !== 'open' && status !== 'awaiting-advice' && status !== 'needs-user' && status !== 'resolved') {
        throw new Error('Decision status must be open, awaiting-advice, needs-user, or resolved');
      }
      const { options, decidedBy } = data;
      if (
        options !== undefined &&
        (!Array.isArray(options) || options.some((v) => typeof v !== 'string' || !v.trim()))
      ) {
        throw new Error('Decision options must be a list of nonempty strings');
      }
      if (decidedBy !== undefined && decidedBy !== 'user' && decidedBy !== 'coordinator') {
        throw new Error('Decisions are made by the user or coordinator');
      }
      const fields = optionalTextFields(data, [
        'itemId',
        'recommendation',
        'advisorTaskId',
        'answer',
        'reference',
        'rationale',
      ]);
      if (status === 'resolved' && (!fields.answer || !decidedBy)) {
        throw new Error('A resolved decision requires an answer and who decided');
      }
      if (status === 'awaiting-advice' && !fields.advisorTaskId) {
        throw new Error('An advisor task is required when awaiting advice');
      }
      return {
        kind,
        id: requiredText(data, 'id'),
        question: requiredText(data, 'question'),
        status,
        ...fields,
        ...(Array.isArray(options) && { options }),
        ...(decidedBy !== undefined && { decidedBy }),
      };
    }
    case 'note':
    case 'end':
      return { kind, text: requiredText(data, 'text') };
    case 'attach':
      return { kind, taskId: requiredText(data, 'taskId') };
    default:
      throw new Error('Expected an epic item, decision, note, outcome, or attachment');
  }
}

function appendUpdate(taskId: string, epic: EpicState, authorTaskId: string, change: EpicChange): EpicUpdate {
  const entry = { ...change, seq: (epic.updates.at(-1)?.seq ?? 0) + 1, at: Date.now(), authorTaskId };
  updateEpicState(taskId, { ...epic, updates: [...epic.updates, entry] });
  return entry;
}

export function updateEpic(
  taskId: string,
  callerTaskId: string | undefined,
  input: unknown,
  visibleTasks: readonly Task[],
): EpicUpdate {
  if (callerTaskId !== taskId) throw new Error('Only the epic coordinator can update its plan');
  const epic = writableEpic(taskId);
  const change = parseCoordinatorChange(input);
  const { items, decisions, attachedTaskIds } = projectEpic(epic);
  const members = epicMembers(taskId, attachedTaskIds, visibleTasks);
  if (change.kind === 'attach') {
    const existing = epic.updates.find((update) => update.kind === 'attach' && update.taskId === change.taskId);
    if (existing) return existing;
    const candidate = visibleTasks.find((task) => task.id === change.taskId);
    if (!candidate) throw new Error(`Task ${change.taskId} is unavailable`);
    if (candidate.epic) throw new Error('An epic coordinates ordinary tasks');
    const claimed = visibleTasks.some(
      (task) =>
        task.id !== taskId &&
        task.epic &&
        (candidate.createdByTaskId === task.id ||
          task.epic.updates.some((update) => update.kind === 'attach' && update.taskId === candidate.id)),
    );
    if (claimed) throw new Error('That task already belongs to another epic');
  }
  if (change.kind === 'item') {
    const assignedTaskId = items.find((item) => item.id === change.id)?.taskId;
    if (change.taskId && change.taskId !== assignedTaskId && !members.some((task) => task.id === change.taskId)) {
      throw new Error('Assign the work item to a member of this epic');
    }
    if (!change.taskId && assignedTaskId) change.taskId = assignedTaskId;
  }
  if (change.kind === 'decision') {
    const previous = decisions.find((decision) => decision.id === change.id);
    if (!change.itemId && previous?.itemId) change.itemId = previous.itemId;
    if (!change.reference && previous?.reference) change.reference = previous.reference;
    if (change.itemId && !items.some((item) => item.id === change.itemId)) throw new Error('Work item not found');
    if (
      change.advisorTaskId &&
      previous?.advisorTaskId !== change.advisorTaskId &&
      !members.some((task) => task.id === change.advisorTaskId)
    ) {
      throw new Error('Ask a member of this epic for advice');
    }
  }
  return appendUpdate(taskId, epic, callerTaskId, change);
}

export function reportEpicResult(
  taskId: string,
  callerTaskId: string | undefined,
  input: unknown,
  visibleTasks: readonly Task[],
): EpicUpdate {
  if (!callerTaskId) throw new Error('Report from a task that belongs to this epic');
  const epic = writableEpic(taskId);
  const data = object(input);
  const report = {
    kind: 'report' as const,
    itemId: requiredText(data, 'itemId'),
    reportId: requiredText(data, 'reportId'),
    text: requiredText(data, 'text'),
    ...optionalTextFields(data, ['revision']),
  };
  const replay = epic.updates.find(
    (update) =>
      update.kind === 'report' &&
      update.authorTaskId === callerTaskId &&
      update.itemId === report.itemId &&
      update.reportId === report.reportId,
  );
  if (replay?.kind === 'report') {
    if (replay.text !== report.text || replay.revision !== report.revision) {
      throw new Error('That report ID already names different evidence for this item');
    }
    return replay;
  }
  const { items, attachedTaskIds } = projectEpic(epic);
  const item = items.find(({ id }) => id === report.itemId);
  if (!item) throw new Error('Work item not found');
  if (
    item.taskId !== callerTaskId &&
    !epicMembers(taskId, attachedTaskIds, visibleTasks).some(({ id }) => id === callerTaskId)
  ) {
    throw new Error('Report from a task that belongs to this epic');
  }
  if (item.taskId && item.taskId !== callerTaskId) throw new Error('Report from the task assigned to this item');
  return appendUpdate(taskId, epic, callerTaskId, report);
}

export function markEpicCheckedIn(taskId: string, through: number): Task {
  if (!Number.isSafeInteger(through) || through < 0) throw new Error('Check-in sequence must be a nonnegative integer');
  const epic = writableEpic(taskId);
  const checkedThrough = Math.min(through, epic.updates.at(-1)?.seq ?? 0);
  if (checkedThrough <= epic.checkedThrough) return getTask(taskId);
  return updateEpicState(taskId, { ...epic, checkedThrough });
}
