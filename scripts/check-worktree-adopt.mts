/**
 * A task can run in a worktree that already exists, which means resolving the
 * repo it belongs to, its root and the branch it has checked out from any path
 * inside it. Run with `npm run check:worktree-adopt`.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspectWorktree } from '../src/main/worktree-manager.ts';

let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? 'ok' : 'FAIL'} — ${name}${ok || !detail ? '' : `\n  ${detail}`}`);
}

// git reports the resolved path, which on macOS differs from the temp dir handed out.
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bifrost-adopt-')));
const repo = path.join(root, 'repo');
fs.mkdirSync(repo);
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
git('init', '-q', '-b', 'main', '.');
git('config', 'user.email', 'check@example.com');
git('config', 'user.name', 'check');
fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
git('add', '-A');
git('commit', '-qm', 'init');

const feature = path.join(root, 'feature');
git('worktree', 'add', '-q', '-b', 'feature', feature);
fs.mkdirSync(path.join(feature, 'sub'));

const detached = path.join(root, 'detached');
git('worktree', 'add', '-q', '--detach', detached);

const plain = path.join(root, 'plain');
fs.mkdirSync(plain);

const show = (value: unknown) => JSON.stringify(value);

{
  const adopted = await inspectWorktree(feature);
  check(
    'a worktree resolves to the repo it belongs to',
    adopted.repoPath === repo && adopted.worktreePath === feature && adopted.branch === 'feature',
    `got ${show(adopted)}`,
  );
}

{
  const adopted = await inspectWorktree(path.join(feature, 'sub'));
  check(
    'a directory inside a worktree resolves to its root',
    adopted.repoPath === repo && adopted.worktreePath === feature,
    `got ${show(adopted)}`,
  );
}

{
  const adopted = await inspectWorktree(repo);
  check(
    'the main checkout resolves to itself',
    adopted.repoPath === repo && adopted.worktreePath === repo,
    `got ${show(adopted)}`,
  );
}

{
  const adopted = await inspectWorktree(detached);
  check(
    'a detached worktree reports no branch',
    adopted.worktreePath === detached && adopted.branch === null,
    `got ${show(adopted)}`,
  );
}

{
  let message = '';
  await inspectWorktree(plain).catch((err: Error) => {
    message = err.message;
  });
  check('a path outside a repo is rejected', message.includes(plain), `got ${show(message)}`);
}

fs.rmSync(root, { recursive: true, force: true });
process.exit(failed === 0 ? 0 : 1);
