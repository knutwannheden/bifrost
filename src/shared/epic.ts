import type { EpicChange, EpicState, EpicWorkItem } from './types.ts';

export function createEpicState(brief: unknown): EpicState {
  const { goal, template, templateId } = (brief ?? {}) as Record<string, unknown>;
  if (typeof goal !== 'string' || !goal.trim()) throw new Error('An epic needs a goal');
  if (typeof template !== 'string' || !template.trim()) throw new Error('An epic needs a workflow template');
  if (templateId !== undefined && (typeof templateId !== 'string' || !templateId.trim())) {
    throw new Error('The workflow template ID must be a nonempty string');
  }
  return {
    goal: goal.trim(),
    template,
    ...(typeof templateId === 'string' && { templateId }),
    updates: [],
    checkedThrough: 0,
  };
}

export function projectEpic(epic: EpicState) {
  const items = new Map<string, EpicWorkItem>();
  const decisions = new Map<string, Extract<EpicChange, { kind: 'decision' }>>();
  const attachedTaskIds = new Set<string>();
  let outcome: string | undefined;
  for (const { seq, at: _at, authorTaskId: _author, ...change } of epic.updates) {
    switch (change.kind) {
      case 'item':
        items.set(change.id, { ...change, addedSeq: items.get(change.id)?.addedSeq ?? seq });
        break;
      case 'decision':
        decisions.set(change.id, change);
        break;
      case 'attach':
        attachedTaskIds.add(change.taskId);
        break;
      case 'end':
        outcome = change.text;
        break;
    }
  }
  return {
    items: [...items.values()],
    decisions: [...decisions.values()],
    attachedTaskIds: [...attachedTaskIds],
    outcome,
  };
}
