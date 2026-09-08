/**
 * What the diff is measured against decides whether a branch's view shows its
 * own work or everyone's. Run with `npm run check:diff-base`.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveBaseRef, resolveDiffBase } from '../src/main/diff-service.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bifrost-diffbase-'));
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();

function commit(cwd: string, file: string, body: string) {
  fs.writeFileSync(path.join(cwd, file), `${body}\n`);
  git(cwd, 'add', file);
  git(cwd, 'commit', '-q', '-m', `add ${file}`);
}

git(root, 'init', '-q', '-b', 'main');
git(root, 'config', 'user.email', 'check@example.com');
git(root, 'config', 'user.name', 'Check');
commit(root, 'shared.txt', 'base');
const forkPoint = git(root, 'rev-parse', 'HEAD');

git(root, 'checkout', '-q', '-b', 'feature');
commit(root, 'mine.txt', 'my work');

git(root, 'checkout', '-q', 'main');
for (const n of [1, 2, 3]) commit(root, `upstream${n}.txt`, `upstream ${n}`);
const mainTip = git(root, 'rev-parse', 'HEAD');

git(root, 'checkout', '-q', 'feature');

let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? 'ok' : 'FAIL'} — ${name}`);
  if (!ok && detail) console.log(detail);
}

check('with no merge in flight the base is the fork point', (await resolveDiffBase(root, 'main')) === forkPoint);

// Leaves MERGE_HEAD set, with the tree holding upstream and HEAD not.
git(root, 'merge', '--no-commit', '--no-ff', 'main');

const base = await resolveDiffBase(root, 'main');
const changed = git(root, 'diff', '--name-only', base ?? '')
  .split('\n')
  .filter(Boolean);

check(
  "an in-flight merge keeps upstream out of the branch's diff",
  base === mainTip && changed.length === 1 && changed[0] === 'mine.txt',
  `  base ${base} (want ${mainTip}), changed ${JSON.stringify(changed)}`,
);

git(root, 'update-ref', 'refs/remotes/origin/main', mainTip);
git(root, 'branch', '-f', 'main', forkPoint);

check('a base branch is taken from its remote-tracking ref', (await resolveBaseRef(root, 'main')) === 'origin/main');
check(
  'a base branch already remote-tracking is left alone',
  (await resolveBaseRef(root, 'origin/main')) === 'origin/main',
);
check(
  'a base branch with no remote-tracking ref falls back to the local one',
  (await resolveBaseRef(root, 'feature')) === 'feature',
);

fs.rmSync(root, { recursive: true, force: true });
process.exit(failed === 0 ? 0 : 1);
