import type { DiffFile } from './diff-parser.ts';

export type StepKind = 'narration' | 'finding' | 'bug' | 'concern';

/** `old` lines index the base commit's tree, `new` lines the head commit's. */
export type Side = 'old' | 'new';

/** The text around an anchor, for finding it again once its commit is gone. */
export interface Snippet {
  before: string[];
  first: string[];
  last: string[];
  after: string[];
}

export interface Anchor {
  path: string;
  side: Side;
  commit: string;
  /** Inclusive, 1-based, on `side`. */
  lines: [number, number];
  snippet: Snippet;
}

export interface Comment {
  id: string;
  kind: StepKind;
  body: string;
  author: 'agent' | 'user';
  anchor: Anchor;
  /** Set when the comment belongs to a GitHub pending review. */
  review: { state: 'draft' | 'submitted'; githubId?: number } | null;
}

export interface Step {
  id: string;
  kind: StepKind;
  /** Consecutive steps sharing a chapter are drawn under one heading. */
  chapter: string | null;
  title: string;
  /** Markdown. */
  body: string;
  anchor: Anchor | null;
  /** The generator named lines its quote could not be found at. */
  unverified?: true;
  comments: Comment[];
}

export interface Walkthrough {
  version: 1;
  title: string;
  summary: string;
  change: {
    base: string;
    head: string;
    headRef: string | null;
    pr: { owner: string; repo: string; number: number } | null;
  };
  focus: string | null;
  generatedAt: string;
  generator: { kind: 'cold'; model: string } | { kind: 'task'; taskId: string };
  steps: Step[];
}

export type AnchorStatus = 'exact' | 'shifted' | 'fuzzy' | 'lost';

export interface Remapped {
  anchor: Anchor | null;
  status: AnchorStatus;
}

export interface Staleness {
  state: 'current' | 'ahead' | 'rebased';
  currentHead: string;
  commitsAhead?: number;
  /** Uncommitted changes are not part of any walkthrough. */
  dirty: boolean;
}

/** An anchor as a model writes it: the quote is what makes its line numbers checkable. */
export interface GeneratedAnchor {
  path: string;
  side: Side;
  lines: [number, number];
  quote: string;
}

export interface GeneratedStep {
  kind: StepKind;
  chapter: string | null;
  title: string;
  body: string;
  anchor: GeneratedAnchor | null;
  comments: { kind: StepKind; body: string; anchor: GeneratedAnchor }[];
}

export interface GeneratedWalkthrough {
  title: string;
  summary: string;
  steps: GeneratedStep[];
}

const KIND_SCHEMA = { type: 'string', enum: ['narration', 'finding', 'bug', 'concern'] } as const;

const ANCHOR_SCHEMA = {
  type: 'object',
  properties: {
    path: { type: 'string', description: 'Path in the diff, on the side named.' },
    side: { type: 'string', enum: ['old', 'new'], description: 'new for added or context lines, old for removed.' },
    lines: {
      type: 'array',
      items: { type: 'integer' },
      minItems: 2,
      maxItems: 2,
      description: 'First and last line, inclusive, copied from that side’s column of the numbered diff.',
    },
    quote: { type: 'string', description: 'The first anchored line’s text, verbatim, without the diff sign.' },
  },
  required: ['path', 'side', 'lines', 'quote'],
  additionalProperties: false,
} as const;

export const GENERATED_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    summary: { type: 'string', description: 'One paragraph: what the change is for and the shape of the tour.' },
    steps: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          kind: KIND_SCHEMA,
          chapter: { type: ['string', 'null'] },
          title: { type: 'string' },
          body: { type: 'string', description: 'Markdown.' },
          anchor: { anyOf: [ANCHOR_SCHEMA, { type: 'null' }] },
          comments: {
            type: 'array',
            items: {
              type: 'object',
              properties: { kind: KIND_SCHEMA, body: { type: 'string' }, anchor: ANCHOR_SCHEMA },
              required: ['kind', 'body', 'anchor'],
              additionalProperties: false,
            },
          },
        },
        required: ['kind', 'chapter', 'title', 'body', 'anchor', 'comments'],
        additionalProperties: false,
      },
    },
  },
  required: ['title', 'summary', 'steps'],
  additionalProperties: false,
} as const;

const SIGN = { add: '+', remove: '-', context: ' ' } as const;

/** A diff with both line numbers spelled out, so a model copies a number rather than counting to it. */
export function numberDiff(files: DiffFile[]): string {
  const out: string[] = [];
  for (const file of files) {
    const header = file.status === 'renamed' ? `${file.oldPath} → ${file.newPath}` : file.newPath || file.oldPath;
    out.push(`=== ${file.status} ${header}`);
    if (file.binary) {
      out.push('(binary)');
      continue;
    }
    for (const hunk of file.hunks) {
      out.push(hunk.header);
      for (const l of hunk.lines) {
        const o = String(l.oldLineNo ?? '-').padStart(5);
        const n = String(l.newLineNo ?? '-').padStart(5);
        out.push(`${o}|${n}|${SIGN[l.type]}${l.content}`);
      }
    }
  }
  return out.join('\n');
}

/** How far from its claimed line a quote is looked for. */
const REPAIR_WINDOW = 20;

/**
 * The 1-based line holding `quote`: the claimed one if it does, else the only
 * one within REPAIR_WINDOW lines that does. A quote recurring near the claim,
 * like a closing brace, cannot say which line was meant.
 */
export function locateQuote(lines: string[], claimed: number, quote: string): number | null {
  const want = quote.trim();
  const at = (n: number) => lines[n - 1]?.trim() === want;
  if (at(claimed)) return claimed;
  // A blank quote would match every blank line, which is no evidence at all.
  if (!want) return null;
  const near: number[] = [];
  for (let n = Math.max(1, claimed - REPAIR_WINDOW); n <= Math.min(lines.length, claimed + REPAIR_WINDOW); n++) {
    if (at(n)) near.push(n);
  }
  return near.length === 1 ? near[0] : null;
}

const CONTEXT = 3;
const FIRST = 4;
const LAST = 2;

export function extractSnippet(fileLines: string[], [start, end]: [number, number]): Snippet {
  const s = start - 1;
  return {
    before: fileLines.slice(Math.max(0, s - CONTEXT), s),
    first: fileLines.slice(s, Math.min(end, s + FIRST)),
    last: end - start + 1 > FIRST ? fileLines.slice(Math.max(s + FIRST, end - LAST), end) : [],
    after: fileLines.slice(end, end + CONTEXT),
  };
}

export interface ZeroContextHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
}

export function parseZeroContextHunks(diff: string): ZeroContextHunk[] {
  const hunks: ZeroContextHunk[] = [];
  for (const m of diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
    hunks.push({
      oldStart: Number(m[1]),
      oldLines: m[2] === undefined ? 1 : Number(m[2]),
      newStart: Number(m[3]),
      newLines: m[4] === undefined ? 1 : Number(m[4]),
    });
  }
  return hunks;
}

/**
 * Where an unchanged range sits after `hunks`, or null when one of them touches
 * it. A hunk with no old lines inserts after `oldStart`.
 */
export function shiftRange([start, end]: [number, number], hunks: ZeroContextHunk[]): [number, number] | null {
  let offset = 0;
  for (const h of hunks) {
    if (h.oldLines === 0) {
      if (h.oldStart >= start && h.oldStart < end) return null;
      if (h.oldStart < start) offset += h.newLines;
      continue;
    }
    const last = h.oldStart + h.oldLines - 1;
    if (h.oldStart <= end && last >= start) return null;
    if (last < start) offset += h.newLines - h.oldLines;
  }
  return [start + offset, end + offset];
}

type Compare = (a: string, b: string) => boolean;
const exactly: Compare = (a, b) => a === b;
const trimmed: Compare = (a, b) => a.trim() === b.trim();

function startsOf(fileLines: string[], seq: string[], same: Compare, from = 0, to = fileLines.length): number[] {
  const hits: number[] = [];
  for (let i = from; i + seq.length <= Math.min(to, fileLines.length); i++) {
    if (seq.every((s, k) => same(fileLines[i + k], s))) hits.push(i);
  }
  return hits;
}

/**
 * Find an anchor's lines by their text alone. Only a unique match of the
 * opening lines counts: a plausible place is not the place.
 */
export function matchSnippet(fileLines: string[], snippet: Snippet, originalLength: number): [number, number] | null {
  if (snippet.first.length === 0) return null;
  let same = exactly;
  let starts = startsOf(fileLines, snippet.first, same);
  if (starts.length === 0) {
    same = trimmed;
    starts = startsOf(fileLines, snippet.first, same);
  }
  if (starts.length !== 1) return null;
  const start = starts[0];
  if (snippet.last.length === 0) return [start + 1, start + snippet.first.length];

  const expectedEnd = start + originalLength;
  const lastFrom = expectedEnd - snippet.last.length;
  if (startsOf(fileLines, snippet.last, same, lastFrom, expectedEnd).length > 0) return [start + 1, expectedEnd];
  const [found] = startsOf(fileLines, snippet.last, same, start + snippet.first.length, start + 2 * originalLength);
  return found === undefined ? null : [start + 1, found + snippet.last.length];
}
