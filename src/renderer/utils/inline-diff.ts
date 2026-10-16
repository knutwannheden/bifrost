import type { HighlightedToken } from './syntax-highlight';

/** A half-open character range within a diff line's content. */
export type WordRange = [start: number, end: number];

/** The part of a diff line the word differ reads. */
interface Line {
  type: 'add' | 'remove' | 'context';
  content: string;
}

/** A syntax token, split where the words that differ begin and end. */
export interface DiffSegment extends HighlightedToken {
  changed: boolean;
}

/** A line with more tokens than this keeps the row background alone, bounding the match below. */
const MAX_TOKENS = 400;

/**
 * How much of a line has to survive an edit for marking the rest to be worth it.
 * Below this nearly every word differs, and marking them all says no more than
 * the row background already does.
 */
const MIN_SIMILARITY = 0.3;

const WHITESPACE = /^\s+$/;

/** Words, whitespace runs and single other characters, which is the granularity marked. */
function tokenize(content: string): string[] {
  return content.match(/[A-Za-z0-9_$]+|\s+|./gs) ?? [];
}

function nonSpaceLength(content: string): number {
  return content.replace(/\s/g, '').length;
}

/** Which tokens of each side belong to a longest common subsequence, with the characters they carry. */
function common(a: string[], b: string[]): { keptA: boolean[]; keptB: boolean[]; shared: number } {
  const w = b.length + 1;
  const dp = new Uint16Array((a.length + 1) * w);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i * w + j] = a[i] === b[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }

  const keptA = new Array<boolean>(a.length).fill(false);
  const keptB = new Array<boolean>(b.length).fill(false);
  let shared = 0;
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      keptA[i] = true;
      keptB[j] = true;
      shared += nonSpaceLength(a[i]);
      i++;
      j++;
    } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return { keptA, keptB, shared };
}

function changedRanges(tokens: string[], kept: boolean[]): WordRange[] {
  const marked = kept.map((keep) => !keep);
  // A whitespace run between two changed words belongs with them, since the
  // match pairs it against the run on the other side and leaving it out reads
  // as two marks with a hole between them. The tokenizer keeps a run whole, so
  // one index covers the gap.
  for (let i = 1; i < marked.length - 1; i++) {
    if (!marked[i] && marked[i - 1] && marked[i + 1] && WHITESPACE.test(tokens[i])) marked[i] = true;
  }

  const ranges: WordRange[] = [];
  let at = 0;
  for (let i = 0; i < tokens.length; i++) {
    if (marked[i]) {
      const last = ranges[ranges.length - 1];
      if (last && last[1] === at) last[1] = at + tokens[i].length;
      else ranges.push([at, at + tokens[i].length]);
    }
    at += tokens[i].length;
  }
  return ranges;
}

function pairRanges(before: string, after: string): [WordRange[], WordRange[]] | null {
  const a = tokenize(before);
  const b = tokenize(after);
  if (a.length > MAX_TOKENS || b.length > MAX_TOKENS) return null;

  const { keptA, keptB, shared } = common(a, b);
  const bulk = Math.max(nonSpaceLength(before), nonSpaceLength(after));
  if (bulk === 0 || shared / bulk < MIN_SIMILARITY) return null;

  return [changedRanges(a, keptA), changedRanges(b, keptB)];
}

/**
 * What each line differs from its counterpart by, one entry per line with the
 * hunks flattened, which is how callers index the result. A removed line has a
 * counterpart when its run is as long as the added run that follows it, so a
 * line split in two, or a hunk of pure additions, comes back null.
 */
export function wordRanges(hunks: readonly Line[][]): (WordRange[] | null)[] {
  const out: (WordRange[] | null)[] = [];

  for (const lines of hunks) {
    const ranges: (WordRange[] | null)[] = lines.map(() => null);
    let i = 0;
    while (i < lines.length) {
      if (lines[i].type !== 'remove') {
        i++;
        continue;
      }
      let removeEnd = i;
      while (removeEnd < lines.length && lines[removeEnd].type === 'remove') removeEnd++;
      let addEnd = removeEnd;
      while (addEnd < lines.length && lines[addEnd].type === 'add') addEnd++;

      if (addEnd - removeEnd === removeEnd - i) {
        for (let k = 0; k < removeEnd - i; k++) {
          const pair = pairRanges(lines[i + k].content, lines[removeEnd + k].content);
          ranges[i + k] = pair?.[0] ?? null;
          ranges[removeEnd + k] = pair?.[1] ?? null;
        }
      }
      i = addEnd;
    }
    out.push(...ranges);
  }

  return out;
}

/** A line's syntax tokens, cut at the boundaries of the ranges that differ. */
export function emphasize(tokens: readonly HighlightedToken[], ranges: WordRange[] | null): DiffSegment[] {
  if (!ranges?.length) return tokens.map((token) => ({ ...token, changed: false }));

  const total = tokens.reduce((n, token) => n + token.content.length, 0);
  const changed = new Uint8Array(total);
  for (const [start, end] of ranges) changed.fill(1, Math.min(start, total), Math.min(end, total));

  const segments: DiffSegment[] = [];
  let at = 0;
  for (const token of tokens) {
    let cut = 0;
    while (cut < token.content.length) {
      const flag = changed[at + cut];
      let to = cut + 1;
      while (to < token.content.length && changed[at + to] === flag) to++;
      segments.push({ content: token.content.slice(cut, to), color: token.color, changed: flag === 1 });
      cut = to;
    }
    at += token.content.length;
  }
  return segments;
}
