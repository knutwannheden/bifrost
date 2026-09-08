import type { TaskPr } from '../../shared/types';

// GitHub's own state colours, so the pill reads without a legend.
const STATE_BG: Record<TaskPr['state'], string> = {
  open: 'bg-success',
  draft: 'bg-muted',
  merged: 'bg-accent-hover',
  closed: 'bg-danger',
};

// Each half answers its own question, so neither borrows the other's colour.
const MERGE_BG: Record<NonNullable<TaskPr['merge']>, string> = {
  conflicts: 'bg-danger',
  'changes-requested': 'bg-danger',
  behind: 'bg-warning',
  'awaiting-review': 'bg-muted',
  blocked: 'bg-muted',
  mergeable: 'bg-success',
};

const MERGE_LABEL: Record<NonNullable<TaskPr['merge']>, string> = {
  conflicts: 'merge conflicts',
  'changes-requested': 'changes requested',
  behind: 'behind base branch',
  'awaiting-review': 'awaiting review',
  blocked: 'not mergeable',
  mergeable: 'ready to merge',
};

const CI_BG: Record<NonNullable<TaskPr['ci']>, string> = {
  running: 'bg-warning',
  failing: 'bg-danger',
  passing: 'bg-success',
};

const CI_LABEL: Record<NonNullable<TaskPr['ci']>, string> = {
  running: 'checks running',
  failing: 'checks failing',
  passing: 'checks passing',
};

/** An unanswered half reads as empty rather than as a verdict of its own. */
const EMPTY_HALF = 'bg-transparent border border-border-default';

export default function PrPill({ pr, onOpen }: { pr: TaskPr; onOpen: (url: string) => void }) {
  const { merge, ci } = pr;
  // The pill opens the PR and the dot opens what it is reporting on: the run
  // that decided it where GitHub named one, the checks listing otherwise.
  const checksUrl = pr.checkUrl ?? `${pr.url}/checks`;
  const label = [merge && MERGE_LABEL[merge], ci && CI_LABEL[ci]].filter(Boolean).join(' · ') || 'no checks yet';

  return (
    <>
      {/* biome-ignore lint/a11y/useSemanticElements: can't nest <button> inside the row's <button> */}
      <span
        role="button"
        tabIndex={-1}
        title={`${pr.state} · ${pr.url}`}
        onClick={(e) => {
          e.stopPropagation();
          onOpen(pr.url);
        }}
        className={`shrink-0 rounded-sm px-1 text-[10px] leading-tight text-on-status cursor-pointer hover:opacity-80 transition-opacity ${STATE_BG[pr.state]}`}
      >
        #{pr.number}
      </span>
      {/* Kept out of the pill so the PR's lifecycle and how it is faring stay
          two facts rather than one colour doing both. Both halves are always
          drawn, so the dot's shape does not shift as a PR progresses. */}
      {/* biome-ignore lint/a11y/useSemanticElements: can't nest <button> inside the row's <button> */}
      <span
        role="button"
        tabIndex={-1}
        title={`${label} — open checks`}
        onClick={(e) => {
          e.stopPropagation();
          onOpen(checksUrl);
        }}
        // Padding out to a hittable target without moving it or its neighbours.
        className="-m-1 shrink-0 cursor-pointer p-1 hover:opacity-70 transition-opacity"
      >
        <span className="flex h-1.5 overflow-hidden rounded-full">
          <span className={`w-1.5 ${merge ? MERGE_BG[merge] : EMPTY_HALF}`} />
          <span
            className={`w-1.5 border-l border-border-default ${ci ? CI_BG[ci] : EMPTY_HALF} ${
              ci === 'running' ? 'activity-pulse' : ''
            }`}
          />
        </span>
      </span>
    </>
  );
}
