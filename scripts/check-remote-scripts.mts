/**
 * A remote task runs on scripts Bifrost hands to `sh` on another machine, with
 * prompts, names and paths quoted into them. They are run here against a local
 * HOME, with stub `tmux` and `claude` that record what reached them, so a
 * quoting slip shows up as a mangled argument. Run with
 * `npm run check:remote-scripts`.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  archiveScript,
  attachCommand,
  diffScript,
  parseScriptOutput,
  prepareScript,
  remoteClonePath,
  sessionSetupScript,
  worktreeScript,
} from '../src/main/remote-host.ts';
import { parseDiff } from '../src/shared/diff-parser.ts';

let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? 'ok' : 'FAIL'} — ${name}${ok || !detail ? '' : `\n  ${detail}`}`);
}
const show = (value: unknown) => JSON.stringify(value);

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bifrost-remote-')));

/** Run a script the way the remote does: `sh -s` in HOME, script on stdin. */
function runRemote(home: string, script: string, extraPath?: string): string {
  return execFileSync('sh', ['-s'], {
    cwd: home,
    input: script,
    env: { ...process.env, HOME: home, PATH: extraPath ? `${extraPath}:${process.env.PATH}` : process.env.PATH },
    stdio: ['pipe', 'pipe', 'pipe'],
  }).toString();
}

const stubs = path.join(root, 'stubs');
const record = path.join(root, 'record');
fs.mkdirSync(stubs);
fs.mkdirSync(record);
// tmux runs the session's command in the -c directory, which is all the attach needs from it.
fs.writeFileSync(
  path.join(stubs, 'tmux'),
  `#!/bin/sh
printf '%s\\0' "$@" > '${record}/tmux-args'
while [ "$1" != new-session ]; do shift; done; shift
while [ $# -gt 0 ]; do
  case "$1" in
    -A) shift ;;
    -s) shift 2 ;;
    -c) dir="$2"; shift 2 ;;
    *) break ;;
  esac
done
cd "$dir" && exec "$@"
`,
  { mode: 0o755 },
);
fs.writeFileSync(
  path.join(stubs, 'claude'),
  `#!/bin/sh
printf '%s\\0' "$@" > '${record}/args'
cat > '${record}/stdin'
pwd > '${record}/pwd'
printf '%s\\n' "$BIFROST_TASK_ID" "$BIFROST_SESSION_NAME" > '${record}/env'
`,
  { mode: 0o755 },
);

const home = path.join(root, 'home');
const worktree = path.join(root, "work tree's");
fs.mkdirSync(home);
fs.mkdirSync(worktree);
fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ projects: {} }));

const taskId = '6f9c1a52-0000-4000-8000-000000000001';
const sessionId = '0b8e2f34-0000-4000-8000-000000000002';
const awkwardName = `it's "quoted" $HOME \`date\` \\ back`;
// A slip in the quoting runs the substitution, which leaves this marker behind.
const injected = path.join(home, 'injected');
const awkwardPrompt = `Fix the build.\nIt's "broken" since $(touch "$HOME/injected") and \`id\`.\n\\n is not a newline.\nEOF\n  trailing spaces  \nünïcödé`;

runRemote(
  home,
  sessionSetupScript({
    home,
    taskId,
    worktreePath: worktree,
    sessionId,
    claudeArgs: ['--name', awkwardName, '--no-chrome'],
    env: { BIFROST_TASK_ID: taskId, BIFROST_SESSION_NAME: awkwardName },
    prompt: awkwardPrompt,
  }),
);

const attach = () =>
  execFileSync(process.env.SHELL ?? '/bin/sh', ['-c', attachCommand(taskId)], {
    cwd: home,
    env: { ...process.env, HOME: home, PATH: `${stubs}:${process.env.PATH}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
const argsOf = (file: string) => fs.readFileSync(path.join(record, file), 'utf-8').split('\0').slice(0, -1);

attach();
{
  const args = argsOf('args');
  const stdin = fs.readFileSync(path.join(record, 'stdin'), 'utf-8');
  const env = fs.readFileSync(path.join(record, 'env'), 'utf-8');
  check(
    'a first attach starts Claude in the worktree with every argument and the prompt intact, running none of it',
    !fs.existsSync(injected) &&
      args.includes(awkwardName) &&
      args.join(' ').includes(`--session-id ${sessionId}`) &&
      !args.includes('--resume') &&
      stdin === `${awkwardPrompt}\n` &&
      fs.readFileSync(path.join(record, 'pwd'), 'utf-8').trim() === worktree &&
      env === `${taskId}\n${awkwardName}\n`,
    show({ args, stdin, env }),
  );
  check(
    'setting a session up trusts its worktree, so Claude starts without asking',
    JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf-8')).projects[worktree]?.hasTrustDialogAccepted ===
      true,
  );
  check(
    'the attach asks tmux for the task-named session, creating it only when missing',
    argsOf('tmux-args').includes('-A') && argsOf('tmux-args').includes(taskId),
    show(argsOf('tmux-args')),
  );
}

fs.mkdirSync(path.join(home, '.claude', 'projects', 'some-project'), { recursive: true });
fs.writeFileSync(path.join(home, '.claude', 'projects', 'some-project', `${sessionId}.jsonl`), '{}\n');
fs.rmSync(path.join(record, 'stdin'));
attach();
{
  const args = argsOf('args');
  check(
    'an attach after the session has a transcript resumes it and does not send the prompt again',
    args.join(' ').includes(`--resume ${sessionId}`) &&
      !args.includes('--session-id') &&
      fs.readFileSync(path.join(record, 'stdin'), 'utf-8') === '',
    show(args),
  );
}

const origin = path.join(root, 'origin.git');
const seed = path.join(root, 'seed');
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();
execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
fs.mkdirSync(seed);
git(seed, 'init', '-q', '-b', 'main');
git(seed, 'config', 'user.email', 'seed@example.com');
git(seed, 'config', 'user.name', 'seed');
fs.writeFileSync(path.join(seed, 'a.txt'), 'one\ntwo\n');
git(seed, 'add', '-A');
git(seed, 'commit', '-qm', 'init');
git(seed, 'remote', 'add', 'origin', origin);
git(seed, 'push', '-q', 'origin', 'main');

const home2 = path.join(root, 'home2');
fs.mkdirSync(home2);
const clone = '.bifrost/repos/acme/widget';
const first = parseScriptOutput(
  runRemote(
    home2,
    worktreeScript({
      clonePath: clone,
      url: origin,
      baseBranch: 'main',
      branchName: 'fix-it',
      slug: 'fix-it',
      gitName: "Ann O'Neil",
      gitEmail: 'ann@example.com',
    }),
  ),
);
const wt = first.WORKTREE;
check(
  'a first task clones the repo and forks a tracking branch from the freshly fetched base branch',
  first.BRANCH === 'fix-it' &&
    wt === path.join(home2, clone, '.worktrees', 'fix-it') &&
    git(wt, 'rev-parse', '--abbrev-ref', '@{u}') === 'origin/main' &&
    git(wt, 'config', 'user.name') === "Ann O'Neil",
  show(first),
);

fs.writeFileSync(path.join(home2, clone, '.git', 'marker'), '');
const second = parseScriptOutput(
  runRemote(
    home2,
    worktreeScript({
      clonePath: clone,
      url: origin,
      baseBranch: 'main',
      branchName: 'fix-it',
      slug: 'other',
      gitName: 'Someone Else',
    }),
  ),
);
check(
  'a later task reuses the clone, keeps the identity it has, and picks a branch name nobody holds',
  second.BRANCH === 'fix-it-2' &&
    fs.existsSync(path.join(home2, clone, '.git', 'marker')) &&
    git(path.join(home2, clone), 'config', 'user.name') === "Ann O'Neil",
  show(second),
);

git(wt, 'config', 'user.email', 'ann@example.com');
fs.writeFileSync(path.join(wt, 'committed.txt'), 'landed\n');
git(wt, 'add', 'committed.txt');
git(wt, 'commit', '-qm', 'commit on the branch');
fs.writeFileSync(path.join(wt, 'a.txt'), 'one\nTWO\n');
fs.writeFileSync(path.join(wt, 'fresh.txt'), 'fresh\n');
fs.writeFileSync(path.join(wt, 'blob.bin'), Buffer.from([0, 1, 2, 3]));
fs.writeFileSync(path.join(wt, 'huge.txt'), 'x'.repeat(2 * 1024 * 1024));

const files = (raw: string) => Object.fromEntries(parseDiff(raw).map((f) => [f.newPath, f]));
{
  const working = files(runRemote(home2, diffScript(wt)));
  const added = (f: (typeof working)[string] | undefined) =>
    f?.hunks.flatMap((h) => h.lines.filter((l) => l.type === 'add').map((l) => l.content));
  check(
    'the working diff holds tracked edits and untracked files, marks binaries, and leaves out large files',
    show(added(working['a.txt'])) === show(['TWO']) &&
      show(added(working['fresh.txt'])) === show(['fresh']) &&
      working['blob.bin']?.binary === true &&
      !working['huge.txt'] &&
      !working['committed.txt'],
    show(Object.keys(working)),
  );
  const all = files(runRemote(home2, diffScript(wt, 'origin/main')));
  check('a diff against the base includes what the branch committed', !!all['committed.txt'], show(Object.keys(all)));
}

{
  const other = second.WORKTREE;
  const archived = parseScriptOutput(runRemote(home2, archiveScript(taskId, other)));
  git(wt, 'checkout', '-q', '--detach');
  runRemote(home2, archiveScript(taskId, wt));
  check(
    'archiving deletes the worktree and keeps its branch, but leaves a detached worktree with nothing to rebuild it from',
    fs.existsSync(wt) &&
      archived.BRANCH === 'fix-it-2' &&
      !fs.existsSync(other) &&
      git(path.join(home2, clone), 'rev-parse', '--verify', 'refs/heads/fix-it-2') !== '',
    show(archived),
  );
}

const home3 = path.join(root, 'home3');
fs.mkdirSync(home3);
const claudeJson = path.join(home3, '.claude.json');
fs.writeFileSync(
  claudeJson,
  JSON.stringify({ numStartups: 3, theme: 'light', projects: { '/elsewhere': { lastCost: 1 } } }),
);
const prepared = parseScriptOutput(runRemote(home3, prepareScript({ apiPort: 43669, theme: 'dark-daltonized' })));
{
  const config = JSON.parse(fs.readFileSync(claudeJson, 'utf-8'));
  check(
    'preparing a machine points its hooks at the forwarded port and completes onboarding, keeping what is set',
    fs.readFileSync(path.join(home3, '.bifrost', 'api-port'), 'utf-8').trim() === '43669' &&
      config.hasCompletedOnboarding === true &&
      typeof config.lastOnboardingVersion === 'string' &&
      config.theme === 'light' &&
      config.numStartups === 3 &&
      config.projects['/elsewhere'].lastCost === 1 &&
      prepared.HOME === home3,
    show({ prepared, config }),
  );
}

check(
  'a clone sits at the path its repo has here, relative to home, and under ~/git for a repo outside it',
  remoteClonePath({ path: path.join(os.homedir(), 'git', 'acme', 'widget'), name: 'widget' }) === 'git/acme/widget' &&
    remoteClonePath({ path: '/opt/src/widget', githubPath: 'acme/widget', name: 'widget' }) === 'git/acme/widget',
);

fs.rmSync(root, { recursive: true, force: true });
if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
