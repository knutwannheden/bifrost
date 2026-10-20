import type { DiffFile, DiffLine } from '../../shared/diff-parser.ts';
import type { Anchor, AnchorStatus, Comment, Side, Step } from '../../shared/walkthrough.ts';

function sideNumber(line: DiffLine, side: Side): number | null {
  return side === 'new' ? line.newLineNo : line.oldLineNo;
}

function fileFor(files: DiffFile[], anchor: Anchor): number {
  return files.findIndex((f) =>
    anchor.side === 'new'
      ? f.newPath === anchor.path && f.status !== 'deleted'
      : f.oldPath === anchor.path && f.status !== 'added',
  );
}

function linesIn(file: DiffFile, anchor: Anchor): DiffLine[] {
  const [start, end] = anchor.lines;
  return file.hunks.flatMap((h) =>
    h.lines.filter((l) => {
      const n = sideNumber(l, anchor.side);
      return n !== null && n >= start && n <= end;
    }),
  );
}

export interface Shown {
  anchor: Anchor | null;
  status: AnchorStatus | null;
}

export interface Layout {
  /** Steps whose card or marker sits above a line. */
  before: Map<DiffLine, number[]>;
  /** Comments drawn below their last line. */
  after: Map<DiffLine, Comment[]>;
  /** The current step's lines. */
  highlighted: Set<DiffLine>;
  /** Files holding anything, which mount at once so the scroll target exists. */
  annotatedFiles: Set<number>;
  /** Steps whose lines are not in this diff, by index. */
  unplaced: Set<number>;
  /** Comments whose lines are not in the diff, shown in their step's card. */
  orphanComments: Map<string, Comment[]>;
}

export function layOut(
  files: DiffFile[],
  steps: Step[],
  shown: (id: string, a: Anchor | null) => Shown,
  current: number,
): Layout {
  const layout: Layout = {
    before: new Map(),
    after: new Map(),
    highlighted: new Set(),
    annotatedFiles: new Set(),
    unplaced: new Set(),
    orphanComments: new Map(),
  };
  steps.forEach((step, i) => {
    const { anchor } = shown(step.id, step.anchor);
    const fi = anchor ? fileFor(files, anchor) : -1;
    const lines = anchor && fi >= 0 ? linesIn(files[fi], anchor) : [];
    if (lines.length === 0) {
      layout.unplaced.add(i);
    } else {
      layout.annotatedFiles.add(fi);
      layout.before.set(lines[0], [...(layout.before.get(lines[0]) ?? []), i]);
      if (i === current) for (const l of lines) layout.highlighted.add(l);
    }
    for (const c of step.comments) {
      const ca = shown(c.id, c.anchor).anchor;
      const cfi = ca ? fileFor(files, ca) : -1;
      const clines = ca && cfi >= 0 ? linesIn(files[cfi], ca) : [];
      const last = clines.at(-1);
      if (last) {
        layout.annotatedFiles.add(cfi);
        layout.after.set(last, [...(layout.after.get(last) ?? []), c]);
      } else {
        layout.orphanComments.set(step.id, [...(layout.orphanComments.get(step.id) ?? []), c]);
      }
    }
  });
  return layout;
}
