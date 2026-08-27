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

export default function PrPill({ pr, onOpen }: { pr: TaskPr; onOpen: (url: string) => void }) {
  const progress = pr.progress;
  // The pill opens the PR and the dot opens what it is reporting on: the run
  // that decided it where GitHub named one, the checks listing otherwise.
  const checksUrl = pr.checkUrl ?? `${pr.url}/checks`;

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
      {/* Kept out of the pill so the PR's state and its progress stay legible
          as two facts rather than one colour doing both. */}
      {progress ? (
        // biome-ignore lint/a11y/useSemanticElements: can't nest <button> inside the row's <button>
        <span
          role="button"
          tabIndex={-1}
          title={`${PROGRESS_LABEL[progress]} — open checks`}
          onClick={(e) => {
            e.stopPropagation();
            onOpen(checksUrl);
          }}
          // Padding the dot out to a hittable target without moving it or its neighbours.
          className="-m-1 shrink-0 cursor-pointer p-1 hover:opacity-70 transition-opacity"
        >
          <span
            className={`block size-1.5 rounded-full ${PROGRESS_BG[progress]} ${
              progress === 'running' ? 'activity-pulse' : ''
            }`}
          />
        </span>
      ) : null}
    </>
  );
}
