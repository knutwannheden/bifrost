import type { TaskPr } from '../../shared/types';

// GitHub's own state colours, so the pill reads without a legend.
const STATE_BG: Record<TaskPr['state'], string> = {
  open: 'bg-success',
  draft: 'bg-muted',
  merged: 'bg-accent-hover',
  closed: 'bg-danger',
};

const PROGRESS_BG: Record<NonNullable<TaskPr['progress']>, string> = {
  running: 'bg-warning',
  failing: 'bg-danger',
  ready: 'bg-success',
  blocked: 'bg-muted',
};

const PROGRESS_LABEL: Record<NonNullable<TaskPr['progress']>, string> = {
  running: 'checks running',
  failing: 'checks failing',
  ready: 'ready to merge',
  blocked: 'not ready to merge',
};

const REVIEW_BG: Record<NonNullable<TaskPr['review']>, string> = {
  approved: 'bg-success',
  'changes-requested': 'bg-danger',
  awaiting: 'bg-muted',
};

const REVIEW_LABEL: Record<NonNullable<TaskPr['review']>, string> = {
  approved: 'approved',
  'changes-requested': 'changes requested',
  awaiting: 'awaiting review',
};

export default function PrPill({ pr, onOpen }: { pr: TaskPr; onOpen: (url: string) => void }) {
  const { progress, review } = pr;
  // The pill opens the PR and the dot opens what it is reporting on: the run
  // that decided it where GitHub named one, the checks listing otherwise.
  const checksUrl = pr.checkUrl ?? `${pr.url}/checks`;
  const label = [progress && PROGRESS_LABEL[progress], review && REVIEW_LABEL[review]].filter(Boolean).join(' · ');

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
      {/* Kept out of the pill so the PR's state and how it is faring stay two
          facts rather than one colour doing both. The halves are divided so
          that checks and review still read separately when they agree. */}
      {progress || review ? (
        // biome-ignore lint/a11y/useSemanticElements: can't nest <button> inside the row's <button>
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
            {progress ? (
              <span className={`w-1.5 ${PROGRESS_BG[progress]} ${progress === 'running' ? 'activity-pulse' : ''}`} />
            ) : null}
            {review ? (
              <span className={`w-1.5 ${REVIEW_BG[review]} ${progress ? 'border-l border-border-default' : ''}`} />
            ) : null}
          </span>
        </span>
      ) : null}
    </>
  );
}
