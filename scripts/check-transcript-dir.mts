/**
 * Bifrost finds a session's transcript in the directory Claude files it under,
 * whatever the worktree path holds. Run with `npm run check:transcript-dir`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isSessionStale } from '../src/main/claude-paths.ts';

let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? 'ok' : 'FAIL'} — ${name}${ok || !detail ? '' : `\n  ${detail}`}`);
}

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bifrost-transcript-dir-')));
process.env.HOME = path.join(root, 'home');
process.env.CLAUDE_CONFIG_DIR = path.join(root, 'config');

{
  const sessionId = '5d0c3a2e-8f1b-4c6d-9e7a-1b2c3d4e5f60';
  const worktree = '/home/ann/git/bazel-contrib/rules_kotlin/.worktrees/fix_it';
  // The name Claude gives it, with every character but a letter or digit made a dash.
  const dir = path.join(root, 'config', 'projects', '-home-ann-git-bazel-contrib-rules-kotlin--worktrees-fix-it');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), '{}\n'.repeat(4096));
  check(
    'a transcript under CLAUDE_CONFIG_DIR, of a worktree whose path holds _, is found to resume',
    !isSessionStale(worktree, sessionId),
    `looked for ${dir}`,
  );
}

fs.rmSync(root, { recursive: true, force: true });
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
