/**
 * Word-level highlighting marks what a changed line and its counterpart differ
 * by, and leaves a line plain where there is nothing to compare it to. Its
 * ranges index the hunks flattened, the way a caller pairs them with tokens.
 * Run with `npm run check:inline-diff`.
 */
import { emphasize, wordRanges } from '../src/renderer/utils/inline-diff.ts';
import { highlightLines } from '../src/renderer/utils/syntax-highlight.ts';

let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? 'ok' : 'FAIL'} — ${name}${ok || !detail ? '' : `\n  ${detail}`}`);
}

const remove = (content: string) => ({ type: 'remove' as const, content });
const add = (content: string) => ({ type: 'add' as const, content });
const context = (content: string) => ({ type: 'context' as const, content });
const show = (ranges: unknown) => JSON.stringify(ranges);

{
  const ranges = wordRanges([[remove('const a = foo(1);'), add('const a = foo(2);')]]);
  check(
    'a one-for-one pair marks only the words that differ',
    show(ranges) === '[[[14,15]],[[14,15]]]',
    `got ${show(ranges)}`,
  );
}

{
  const pair = [remove('return foo bar.length;'), add('return hi there.length;')];
  const ranges = wordRanges([pair]);
  const marked = (i: number) => (ranges[i] ?? []).map(([start, end]) => pair[i].content.slice(start, end)).join('|');
  check(
    'a word replaced by two takes the space between them',
    marked(0) === 'foo bar' && marked(1) === 'hi there',
    `got ${show([marked(0), marked(1)])}`,
  );
}

{
  // A line split in two has no one counterpart, and pairing it with the first
  // half would mark the rest of the line as changed.
  const ranges = wordRanges([[remove('foo(a, b);'), add('foo(a,'), add('  b);')]]);
  check('a run whose counts differ is left plain', show(ranges) === '[null,null,null]', `got ${show(ranges)}`);
}

{
  const ranges = wordRanges([[remove('return cache.get(key);'), add('throw new IllegalStateException();')]]);
  check('a pair with little in common is left plain', show(ranges) === '[null,null]', `got ${show(ranges)}`);
}

{
  const ranges = wordRanges([[context('unchanged')], [remove('let x = 1;'), add('let x = 2;')]]);
  check(
    'ranges index the hunks flattened',
    ranges.length === 3 && ranges[0] === null && show(ranges[1]) === '[[8,9]]' && show(ranges[2]) === '[[8,9]]',
    `got ${show(ranges)}`,
  );
}

{
  const long = `${'a '.repeat(300)}end`;
  const ranges = wordRanges([[remove(long), add(`${long}!`)]]);
  check('a line too long to diff by word is left plain', show(ranges) === '[null,null]', `got ${show(ranges)}`);
}

{
  const segments = emphasize([{ content: 'foo(1);', color: '#aaa' }], [[4, 5]]);
  check(
    'a changed range splits the token it falls inside',
    segments.map((s) => `${s.changed ? '*' : ''}${s.content}`).join('|') === 'foo(|*1|);' &&
      segments.every((s) => s.color === '#aaa'),
    `got ${show(segments)}`,
  );
}

{
  const tokens = [
    { content: 'foo(', color: '#aaa' },
    { content: '1);', color: '#bbb' },
  ];
  const segments = emphasize(tokens, null);
  check(
    'a line with no counterpart keeps its tokens whole',
    segments.length === 2 && segments.every((s) => !s.changed),
    `got ${show(segments)}`,
  );
}

{
  // The ranges are offsets into the line and the tokens come from the
  // highlighter, so a mark lands on the wrong text if the two disagree.
  const line = 'const total = widths.length;';
  const [tokens] = await highlightLines([[line]], 'ts');
  const segments = emphasize(tokens, [[14, 20]]);
  check(
    'a range marks the same characters the highlighter tokenized',
    segments
      .filter((s) => s.changed)
      .map((s) => s.content)
      .join('') === 'widths' && segments.map((s) => s.content).join('') === line,
    `got ${show(segments)}`,
  );
}

process.exit(failed === 0 ? 0 : 1);
