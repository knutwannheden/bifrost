import type { TaskPr } from '../../shared/types';

// GitHub's own state colours, so the pill reads without a legend.
const STATE_BG: Record<TaskPr['state'], string> = {
  open: 'bg-success',
  draft: 'bg-muted',
  merged: 'bg-accent-hover',
  closed: 'bg-danger',
};

export default function PrPill({ pr, onOpen }: { pr: TaskPr; onOpen: () => void }) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: can't nest <button> inside the row's <button>
    <span
      role="button"
      tabIndex={-1}
      title={`${pr.state} · ${pr.url}`}
      onClick={(e) => {
        e.stopPropagation();
        onOpen();
      }}
      className={`shrink-0 rounded-sm px-1 text-[10px] leading-tight text-on-status cursor-pointer hover:opacity-80 transition-opacity ${STATE_BG[pr.state]}`}
    >
      #{pr.number}
    </span>
  );
}
