/**
 * A walkthrough's anchors must point at the lines its author meant, and keep
 * pointing at them as the branch moves. Run with `npm run check:walkthrough-schema`.
 */
import { layOut } from '../src/renderer/utils/walkthrough-layout.ts';
import { parseDiff } from '../src/shared/diff-parser.ts';
import {
  type Anchor,
  extractSnippet,
  locateQuote,
  matchSnippet,
  numberDiff,
  parseZeroContextHunks,
  type Step,
  shiftRange,
} from '../src/shared/walkthrough.ts';

let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? 'ok' : 'FAIL'} — ${name}`);
  if (!ok && detail) console.log(detail);
}
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const numbered = numberDiff(
  parseDiff(
    ['diff --git a/f.ts b/f.ts', '--- a/f.ts', '+++ b/f.ts', '@@ -1,2 +1,2 @@', ' ctx', '-old', '+new', ''].join('\n'),
  ),
);
check(
  'a numbered diff gives every line both sides, a dash where a side has none',
  numbered.includes('    1|    1| ctx') &&
    numbered.includes('    2|    -|-old') &&
    numbered.includes('    -|    2|+new'),
  numbered,
);

const file = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`);
file[9] = 'const target = 1;';
file[29] = 'const target = 1;';
check('a quote at the claimed line is taken as given', locateQuote(file, 10, '  const target = 1;') === 10);
check('a misnumbered quote resolves to the nearest occurrence', locateQuote(file, 13, 'const target = 1;') === 10);

const short = ['a', 'b', 'c'];
check(
  'a snippet near the start of a file holds only the lines before it',
  eq(extractSnippet(short, [2, 2]).before, ['a']),
);

check(
  'an insertion right after an anchor leaves it',
  eq(shiftRange([10, 12], parseZeroContextHunks('@@ -12,0 +13 @@\n+z\n')), [10, 12]),
);
check(
  'an insertion between an anchor’s lines loses it',
  shiftRange([10, 12], parseZeroContextHunks('@@ -10,0 +11 @@\n+z\n')) === null,
);

const original = Array.from({ length: 20 }, (_, i) => `orig ${i}`);
original.splice(5, 4, 'function f() {', '  const a = 1;', '  return a;', '}');
const snippet = extractSnippet(original, [6, 9]);
const reindented = original.map((l) => `    ${l}`);
check('a snippet matches through a change of indentation', eq(matchSnippet(reindented, snippet, 4), [6, 9]));

const long = Array.from({ length: 8 }, (_, i) => `step ${i}`);
const grown = [...long.slice(0, 5), 'added a', 'added b', ...long.slice(5)];
check(
  'a long anchor that grew in the middle runs to its last lines',
  eq(matchSnippet(grown, extractSnippet(long, [1, 8]), 8), [1, 10]),
);

const placed = parseDiff(
  [
    'diff --git a/p.ts b/p.ts',
    '--- a/p.ts',
    '+++ b/p.ts',
    '@@ -5,3 +5,3 @@',
    ' keep',
    '-was',
    '+now',
    ' tail',
    '',
  ].join('\n'),
);
const at = (side: 'old' | 'new', lines: [number, number]): Anchor => ({
  path: 'p.ts',
  side,
  commit: 'c',
  lines,
  snippet: { before: [], first: [], last: [], after: [] },
});
const stepAt = (id: string, anchor: Anchor, comments: Step['comments'] = []): Step => ({
  id,
  kind: 'narration',
  chapter: null,
  title: id,
  body: '',
  anchor,
  comments,
});
const comment = {
  id: 'c1',
  kind: 'bug' as const,
  body: '',
  author: 'agent' as const,
  anchor: at('new', [5, 7]),
  review: null,
};
const layout = layOut(
  placed,
  [stepAt('old', at('old', [6, 6])), stepAt('far', at('new', [40, 41])), stepAt('new', at('new', [6, 6]), [comment])],
  (_id, anchor) => ({ anchor, status: 'exact' }),
  0,
);
const [keep, was, now, tailLine] = placed[0].hunks[0].lines;
check(
  'a step lands on the line of its own side, not the other side’s line of the same number',
  eq(layout.before.get(was), [0]) && eq(layout.before.get(now), [2]),
);
check('a step whose lines are outside every hunk is not placed in the diff', layout.unplaced.has(1));
check(
  'a comment sits after the last of its lines',
  layout.after.get(tailLine)?.[0] === comment && !layout.after.has(keep),
);

if (failed) {
  console.log(`\n${failed} failed`);
  process.exit(1);
}
