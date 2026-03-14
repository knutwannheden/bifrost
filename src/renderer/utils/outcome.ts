import type { Task, TaskOutcome } from '../../shared/types';

export const taskStatusLabel: Record<string, string> = {
  running: 'Running',
  stopped: 'Stopped',
  error: 'Error',
  archived: 'Archived',
};

export const taskStatusColor: Record<string, string> = {
  running: 'text-success',
  stopped: 'text-secondary',
  error: 'text-danger',
  archived: 'text-muted',
};

export const outcomeLabels: Record<TaskOutcome, string> = {
  merged: 'Merged',
  abandoned: 'Abandoned',
  experimental: 'Experimental',
  superseded: 'Superseded',
  pending: 'Pending',
};

export const outcomeBadgeColors: Record<TaskOutcome, string> = {
  merged: 'bg-success/15 text-success',
  abandoned: 'bg-secondary/15 text-secondary',
  experimental: 'bg-accent/15 text-accent',
  superseded: 'bg-warning/15 text-warning',
  pending: 'bg-warning/15 text-warning',
};

export const outcomeTextColors: Record<string, string> = {
  merged: 'text-success',
  abandoned: 'text-secondary',
  experimental: 'text-accent',
  superseded: 'text-warning',
  pending: 'text-warning',
  unclassified: 'text-muted',
};

export const allOutcomes: TaskOutcome[] = ['merged', 'abandoned', 'experimental', 'superseded', 'pending'];

export function getTaskOutcome(task: Task): TaskOutcome | 'unclassified' {
  return task.curation?.userOverride ?? task.curation?.outcome ?? 'unclassified';
}
