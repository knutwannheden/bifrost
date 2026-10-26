/**
 * Opening the IDE on a task lands on the file most recently changed in its
 * worktree. Run with `npm run check:last-changed-file`.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { lastChangedFile } from '../src/main/last-changed-file.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bifrost-lastfile-'));
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf-8' }).trim();

let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? 'ok' : 'FAIL'} — ${name}${ok || !detail ? '' : `\n  ${detail}`}`);
}

const touch = (file: string, secondsAgo: number) => {
  const full = path.join(root, file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, `${file} ${secondsAgo}\n`);
  const t = new Date(Date.now() - secondsAgo * 1000);
  fs.utimesSync(full, t, t);
};

try {
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'check@example.com');
  git('config', 'user.name', 'Check');
  touch('a.txt', 100);
  touch('b.txt', 100);
  git('add', '.');
  git('commit', '-q', '-m', 'base');

  check('a clean worktree has no last changed file', (await lastChangedFile(root)) === null);

  touch('b.txt', 30);
  touch('new/dir/c.txt', 60);
  touch('a.txt', 90);
  const got = await lastChangedFile(root);
  check('the newest of the modified and untracked files wins', got === 'b.txt', `got ${got}`);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

process.exit(failed === 0 ? 0 : 1);
