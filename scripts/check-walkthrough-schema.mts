/**
 * A walkthrough's anchors must point at the lines its author meant, and keep
 * pointing at them as the branch moves. Run with `npm run check:walkthrough-schema`.
 */
import { parseDiff } from '../src/shared/diff-parser.ts';
import {
  extractSnippet,
  locateQuote,
  matchSnippet,
  numberDiff,
  parseZeroContextHunks,
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
check('a quote found nowhere locates nothing', locateQuote(file, 10, 'const absent = 2;') === null);

const short = ['a', 'b', 'c'];
check('a snippet at the first line has nothing before it', eq(extractSnippet(short, [1, 1]).before, []));
check('a snippet at the last line has nothing after it', eq(extractSnippet(short, [3, 3]).after, []));

const insertAt3 = parseZeroContextHunks('@@ -3,0 +4,2 @@\n+x\n+y\n');
check('lines inserted above an anchor move it down', eq(shiftRange([10, 12], insertAt3), [12, 14]));
check(
  'an edit inside an anchor loses it',
  shiftRange([10, 12], parseZeroContextHunks('@@ -11 +11 @@\n-a\n+b\n')) === null,
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
const moved = [...Array.from({ length: 30 }, (_, i) => `pad ${i}`), ...original];
check('a snippet finds its block after it moved', eq(matchSnippet(moved, snippet, 4), [36, 39]));
check('a snippet matching twice matches nothing', matchSnippet([...original, ...original], snippet, 4) === null);
const reindented = original.map((l) => `    ${l}`);
check('a snippet matches through a change of indentation', eq(matchSnippet(reindented, snippet, 4), [6, 9]));

if (failed) {
  console.log(`\n${failed} failed`);
  process.exit(1);
}
