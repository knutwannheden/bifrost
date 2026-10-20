/**
 * A walkthrough's anchors, followed through the commits a branch gains after
 * it was written. Run with `npm run check:walkthrough-anchor`.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { anchorGenerated, assessStaleness, remapAnchor } from '../src/main/walkthrough-anchor.ts';
import type { Anchor, GeneratedStep } from '../src/shared/walkthrough.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bifrost-walkthrough-'));
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf-8' }).trim();
const write = (file: string, lines: string[]) => fs.writeFileSync(path.join(root, file), `${lines.join('\n')}\n`);
function commit(message: string): string {
  git('add', '-A');
  git('commit', '-q', '-m', message);
  return git('rev-parse', 'HEAD');
}

let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? 'ok' : 'FAIL'} — ${name}`);
  if (!ok && detail) console.log(detail);
}
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const lines = Array.from({ length: 20 }, (_, i) => `l${i + 1}`);
const block = ['function f() {', '  return 1;', '}'];

git('init', '-q', '-b', 'main');
git('config', 'user.email', 'check@example.com');
git('config', 'user.name', 'Check');
write('f.ts', lines);
write('gone.ts', ['d1', 'd2', 'd3']);
const A = commit('base');

write('f.ts', [...lines.slice(0, 7), ...block, ...lines.slice(10)]);
fs.rmSync(path.join(root, 'gone.ts'));
const B = commit('head');

const step = (anchor: GeneratedStep['anchor']): GeneratedStep => ({
  kind: 'narration',
  chapter: null,
  title: 't',
  body: 'b',
  anchor,
  comments: [],
});
const w = await anchorGenerated(
  root,
  A,
  B,
  {
    title: 'T',
    summary: 'S',
    steps: [
      step({ path: 'f.ts', side: 'new', lines: [6, 8], quote: 'function f() {' }),
      step({ path: 'f.ts', side: 'new', lines: [1, 1], quote: 'not in the file' }),
      step({ path: 'gone.ts', side: 'old', lines: [2, 3], quote: 'd2' }),
    ],
  },
  { focus: null, model: 'm' },
);
const [fn, absent, removed] = w.steps;
check('a misnumbered anchor is moved to its quoted line', eq(fn.anchor?.lines, [8, 10]), JSON.stringify(fn.anchor));
check('an anchor whose quote is nowhere is left unverified', absent.anchor === null && absent.unverified === true);
check(
  'an anchor indexes the head on the new side and the base on the old, where a deleted file still is',
  fn.anchor?.commit === B && removed.anchor?.commit === A && eq(removed.anchor?.lines, [2, 3]),
);

const anchor = fn.anchor as Anchor;

write('f.ts', [...['n1', 'n2', 'n3', 'n4', 'n5'], ...lines.slice(0, 7), ...block, ...lines.slice(10)]);
const C = commit('insert above');
const shifted = await remapAnchor(root, anchor, C);
check('lines added above an anchor shift it', shifted.status === 'shifted' && eq(shifted.anchor?.lines, [13, 15]));

write('f.ts', [...['n1', 'n2', 'n3', 'n4', 'n5'], ...lines.slice(0, 7), 'function f() {', '  return 2;', '}']);
const D = commit('edit inside');
check('an edit inside an anchor loses it', (await remapAnchor(root, anchor, D)).status === 'lost');

git('checkout', '-q', '-b', 'renamed', C);
git('mv', 'f.ts', 'g.ts');
const E = commit('rename');
const renamed = await remapAnchor(root, anchor, E);
check(
  'a renamed file is followed by its text',
  renamed.status === 'fuzzy' && renamed.anchor?.path === 'g.ts' && eq(renamed.anchor?.lines, [13, 15]),
  JSON.stringify(renamed),
);

const orphan: Anchor = { ...anchor, commit: 'f'.repeat(40) };
check('an anchor whose commit is gone is found by its text', (await remapAnchor(root, orphan, C)).status === 'fuzzy');
write('g.ts', [...block, ...lines, ...block]);
const twice = commit('block twice');
check(
  'text that matches twice is not a match',
  (await remapAnchor(root, { ...orphan, path: 'g.ts' }, twice)).status === 'lost',
);

git('checkout', '-q', D);
const ahead = await assessStaleness(root, w);
check(
  'a branch moved past its walkthrough is ahead by its commits',
  ahead.state === 'ahead' && ahead.commitsAhead === 2,
);
git('checkout', '-q', '-b', 'rewritten', A);
write('other.ts', ['x']);
commit('rewritten history');
check(
  'a branch no longer containing its walkthrough’s head is rebased',
  (await assessStaleness(root, w)).state === 'rebased',
);

fs.rmSync(root, { recursive: true, force: true });
if (failed) {
  console.log(`\n${failed} failed`);
  process.exit(1);
}
