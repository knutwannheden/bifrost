import type { TaskPr } from '../shared/types';

export interface GhCheckFacts {
  status?: string;
  state?: string;
  conclusion?: string;
  detailsUrl?: string;
  targetUrl?: string;
}

export interface GhPrFacts {
  state: string;
  isDraft: boolean;
  mergeStateStatus?: string;
  reviewDecision?: string;
  statusCheckRollup?: GhCheckFacts[];
}

const RUNNING_STATES = new Set(['QUEUED', 'IN_PROGRESS', 'PENDING', 'WAITING']);
const FAILED_STATES = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ERROR']);

/**
 * The two halves of the pill's dot, each answering one question and neither
 * standing in for the other. Null is the absence of an answer rather than a
 * neutral one, so a half with nothing to report can be drawn as empty.
 */
export function verdictsFor(pr: GhPrFacts): { merge: TaskPr['merge']; ci: TaskPr['ci']; checkUrl?: string } {
  return { ...ciVerdict(pr), merge: mergeVerdict(pr) };
}

/** Whether it can land: conflicts, review, and the branch's position. */
function mergeVerdict(pr: GhPrFacts): TaskPr['merge'] {
  // Lifecycle belongs to the pill, and neither a draft nor a finished PR has a
  // mergeability worth colouring.
  if (pr.isDraft || pr.state.toUpperCase() !== 'OPEN') return null;

  const merge = (pr.mergeStateStatus ?? '').toUpperCase();
  if (merge === 'DIRTY') return 'conflicts';
  if (pr.reviewDecision === 'CHANGES_REQUESTED') return 'changes-requested';
  if (merge === 'BEHIND') return 'behind';
  if (pr.reviewDecision === 'REVIEW_REQUIRED') return 'awaiting-review';
  if (merge === 'CLEAN') return 'mergeable';
  // BLOCKED for a reason of the repo's own — a required check, a rule. The CI
  // half names it when checks are the cause.
  return merge === '' ? null : 'blocked';
}

/** Whether it is green, said only by the checks themselves. */
function ciVerdict(pr: GhPrFacts): { ci: TaskPr['ci']; checkUrl?: string } {
  const checks = pr.statusCheckRollup ?? [];
  if (checks.length === 0) return { ci: null };

  const running = checks.find((c) => RUNNING_STATES.has((c.status ?? c.state ?? '').toUpperCase()));
  if (running) return { ci: 'running', checkUrl: running.detailsUrl ?? running.targetUrl };

  const failed = checks.find((c) => FAILED_STATES.has((c.conclusion ?? c.state ?? '').toUpperCase()));
  if (failed) return { ci: 'failing', checkUrl: failed.detailsUrl ?? failed.targetUrl };

  return { ci: 'passing' };
}
