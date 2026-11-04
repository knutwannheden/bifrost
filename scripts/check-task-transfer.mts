/**
 * Moving a task packs its branch, its uncommitted changes and its transcript
 * on this machine, and unpacks them on the other one with a shell script. Both
 * halves run here, the unpack against a second home directory with its own
 * clone of the same origin. Run with `npm run check:task-transfer`.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeProjectDir } from '../src/main/claude-paths.ts';
import { parseScriptOutput } from '../src/main/remote-host.ts';
import { packTask, unpackScript } from '../src/main/task-transfer.ts';

// The scripts read the config dir Bifrost runs with, so this run starts from none, wherever it is run.
delete process.env.CLAUDE_CONFIG_DIR;

let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? 'ok' : 'FAIL'} — ${name}${ok || !detail ? '' : `\n  ${detail}`}`);
}
const show = (value: unknown) => JSON.stringify(value);

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bifrost-transfer-')));
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString();

// An origin with one commit on main, and a clone of it here.
const origin = path.join(root, 'origin.git');
const here = path.join(root, 'here', 'git', 'acme', 'widget');
execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
fs.mkdirSync(here, { recursive: true });
git(here, 'init', '-q', '-b', 'main');
git(here, 'config', 'user.email', 'ann@example.com');
git(here, 'config', 'user.name', 'Ann');
fs.writeFileSync(path.join(here, 'a.txt'), 'one\n');
fs.writeFileSync(path.join(here, 'b.txt'), 'bee\n');
git(here, 'add', '-A');
git(here, 'commit', '-qm', 'init');
git(here, 'remote', 'add', 'origin', origin);
git(here, 'push', '-q', 'origin', 'main');
git(here, 'fetch', '-q', 'origin');

const work = path.join(here, '.worktrees', 'fix-it');
git(here, 'worktree', 'add', '-q', '-b', 'fix-it', work, 'origin/main');
for (const n of [1, 2]) {
  fs.writeFileSync(path.join(work, `c${n}.txt`), `commit ${n}\n`);
  git(work, 'add', '-A');
  git(work, 'commit', '-qm', `commit ${n}`);
}
fs.writeFileSync(path.join(work, 'a.txt'), 'one\nstaged\n');
fs.writeFileSync(path.join(work, 'logo.bin'), Buffer.from([0, 255, 1, 254, 0]));
git(work, 'add', 'a.txt', 'logo.bin');
fs.writeFileSync(path.join(work, 'b.txt'), 'bee\nunstaged\n');
fs.writeFileSync(path.join(work, 'notes.txt'), 'untracked\n');

const there = path.join(root, 'there');
fs.mkdirSync(there);
const sessionId = '7d0c5e2a-0000-4000-8000-000000000003';
const theirWork = path.join(there, 'git', 'acme', 'widget', '.worktrees', 'fix-it');
const transcript = path.join(root, 'transcript.jsonl');
fs.writeFileSync(
  transcript,
  `${JSON.stringify({ cwd: work, message: `Read ${work}/a.txt and ${path.join(root, 'here')}/notes` })}\n`,
);

/** Packs here, carries the directory across, and unpacks there the way the remote does. */
function move(worktreePath: string, slug: string, withTranscript: boolean): Record<string, string> {
  const pack = fs.mkdtempSync(path.join(root, 'pack-'));
  packTask(
    {
      worktreePath,
      baseRef: 'origin/main',
      transcript: withTranscript ? transcript : null,
      rewrites: [
        [worktreePath, path.join(there, 'git', 'acme', 'widget', '.worktrees', slug)],
        [path.join(root, 'here'), there],
      ],
    },
    pack,
  );
  const drop = path.join(there, '.bifrost', 'transfer', slug);
  fs.mkdirSync(path.dirname(drop), { recursive: true });
  fs.renameSync(pack, drop);
  const script = unpackScript({
    clonePath: 'git/acme/widget',
    url: origin,
    baseBranch: 'main',
    branchName: slug,
    slug,
    dropDir: `.bifrost/transfer/${slug}`,
    sessionId,
  });
  return parseScriptOutput(
    execFileSync('sh', ['-s'], {
      cwd: there,
      input: script,
      env: { ...process.env, HOME: there, CLAUDE_CONFIG_DIR: undefined },
      stdio: 'pipe',
    }).toString(),
  );
}

const moved = move(work, 'fix-it', true);
check(
  'a moved task arrives with the same commits, the same staged and unstaged changes, and none of the untracked files',
  moved.WORKTREE === theirWork &&
    git(theirWork, 'rev-parse', 'HEAD') === git(work, 'rev-parse', 'HEAD') &&
    git(theirWork, 'diff', '--cached', '--binary') === git(work, 'diff', '--cached', '--binary') &&
    git(theirWork, 'diff', '--binary') === git(work, 'diff', '--binary') &&
    !fs.existsSync(path.join(theirWork, 'notes.txt')),
  show(moved),
);

{
  const placed = path.join(there, '.claude', 'projects', claudeProjectDir(theirWork), `${sessionId}.jsonl`);
  const text = fs.existsSync(placed) ? fs.readFileSync(placed, 'utf-8') : '';
  check(
    "the transcript lands under the new worktree's project directory, with its paths rewritten",
    claudeProjectDir('/home/ann/git/acme/widget/.worktrees/fix_it') === '-home-ann-git-acme-widget--worktrees-fix-it' &&
      text.includes(`"cwd":"${theirWork}"`) &&
      text.includes(`${there}/notes`) &&
      !text.includes(work),
    text,
  );
}

{
  const other = path.join(here, '.worktrees', 'work-account');
  git(here, 'worktree', 'add', '-q', '-b', 'work-account', other, 'origin/main');
  process.env.CLAUDE_CONFIG_DIR = path.join(os.homedir(), '.claude-work');
  const arrived = move(other, 'work-account', true);
  delete process.env.CLAUDE_CONFIG_DIR;
  const placed = path.join(there, '.claude-work', 'projects', claudeProjectDir(arrived.WORKTREE), `${sessionId}.jsonl`);
  check('a moved transcript is filed under the config dir sessions there use', fs.existsSync(placed), placed);
}

const plain = path.join(here, '.worktrees', 'plain');
git(here, 'worktree', 'add', '-q', '-b', 'plain', plain, 'origin/main');
fs.writeFileSync(path.join(plain, 'a.txt'), 'one\nedited\n');
const plainMoved = move(plain, 'plain', false);
check(
  'a branch with no commits of its own moves without a bundle',
  git(plainMoved.WORKTREE, 'rev-parse', 'HEAD') === git(plain, 'rev-parse', 'HEAD') &&
    git(plainMoved.WORKTREE, 'diff') === git(plain, 'diff'),
  show(plainMoved),
);

fs.rmSync(root, { recursive: true, force: true });
if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
