/**
 * Which branch a worktree has checked out, read from its HEAD rather than from
 * what a task recorded when it was created. A session that moves to a second
 * branch opens its next PR there, and the task list follows only if HEAD does.
 * Run with `npm run check:branch-drift`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { headBranch } from '../src/main/worktree-manager.ts';

let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failed++;
  console.log(`${ok ? 'ok' : 'FAIL'} — ${name}${ok || !detail ? '' : `\n  ${detail}`}`);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'branch-drift-'));

function linkedWorktree(name: string, head: string): string {
  const worktree = path.join(root, name);
  const gitDir = path.join(root, 'gitdirs', name);
  fs.mkdirSync(worktree, { recursive: true });
  fs.mkdirSync(gitDir, { recursive: true });
  fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${gitDir}\n`);
  fs.writeFileSync(path.join(gitDir, 'HEAD'), head);
  return worktree;
}

try {
  const linked = linkedWorktree('linked', 'ref: refs/heads/sync-rpc/receiver\n');
  check(
    'a linked worktree reads HEAD from the gitdir its .git file names',
    headBranch(linked) === 'sync-rpc/receiver',
    `got ${JSON.stringify(headBranch(linked))}`,
  );

  const primary = path.join(root, 'primary');
  fs.mkdirSync(path.join(primary, '.git'), { recursive: true });
  fs.writeFileSync(path.join(primary, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  check(
    'a primary checkout reads HEAD from its own .git directory',
    headBranch(primary) === 'main',
    `got ${JSON.stringify(headBranch(primary))}`,
  );

  const detached = linkedWorktree('detached', '9f1c0b4e2a7d8c3f5b6a1e0d4c7b2a9f8e3d1c0b\n');
  check(
    'a detached HEAD names no branch, so nothing replaces the recorded one',
    headBranch(detached) === null,
    `got ${JSON.stringify(headBranch(detached))}`,
  );

  check('a worktree that is gone names no branch', headBranch(path.join(root, 'absent')) === null);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

process.exit(failed === 0 ? 0 : 1);
