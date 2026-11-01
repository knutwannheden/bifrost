/**
 * The diff view names each file from the paths git writes into a diff's
 * headers, which git escapes in two ways of its own. The diff here comes from
 * git itself, so the check tracks what git actually writes. Run with
 * `npm run check:diff-paths`.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseDiff } from '../src/shared/diff-parser.ts';

let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? 'ok' : 'FAIL'} — ${name}${ok || !detail ? '' : `\n  ${detail}`}`);
}

const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'bifrost-diff-paths-'));
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' }).toString();
git('init', '-q');
git('config', 'user.email', 'check@example.com');
git('config', 'user.name', 'check');
for (const name of ['two words.txt', 'gone too.txt']) fs.writeFileSync(path.join(repo, name), 'one\n');
fs.writeFileSync(path.join(repo, 'plain.txt'), 'kept whole\n');
git('add', '-A');
git('commit', '-qm', 'init');

fs.writeFileSync(path.join(repo, 'two words.txt'), 'two\n');
fs.rmSync(path.join(repo, 'gone too.txt'));
fs.writeFileSync(path.join(repo, 'über.txt'), 'new\n');
fs.writeFileSync(path.join(repo, 'say "hi".txt'), 'new\n');
fs.renameSync(path.join(repo, 'plain.txt'), path.join(repo, 'ünplain.txt'));
git('add', '-A');
const files = parseDiff(git('diff', '--cached', '-M'));
const paths = files.map((f) => `${f.status}: ${f.oldPath} -> ${f.newPath}`).sort();

check(
  'a name with a space keeps no trailing TAB',
  paths.includes('modified: two words.txt -> two words.txt') && paths.includes('deleted: gone too.txt -> gone too.txt'),
  JSON.stringify(paths),
);

check(
  'a name git quotes comes out as the name itself',
  paths.includes('added: über.txt -> über.txt') &&
    paths.includes('added: say "hi".txt -> say "hi".txt') &&
    paths.includes('renamed: plain.txt -> ünplain.txt'),
  JSON.stringify(paths),
);

fs.rmSync(repo, { recursive: true, force: true });
if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
