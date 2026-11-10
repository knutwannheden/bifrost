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
import { subscribe } from '../src/main/event-sink.ts';
import {
  archiveScript,
  diffScript,
  loginScript,
  parseScriptOutput,
  pasteScript,
  prepareScript,
  RemoteHost,
  remoteClonePath,
  sessionSetupScript,
  worktreeScript,
} from '../src/main/remote-host.ts';
import { parseDiff } from '../src/shared/diff-parser.ts';
import { IPC_STREAM } from '../src/shared/ipc-channels.ts';

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
// tmux runs the session's command as TERM_PROGRAM=tmux with no COLORTERM.
// That is all the attach needs from it.
fs.writeFileSync(
  path.join(stubs, 'tmux'),
  `#!/bin/sh
printf '%s\\0' "$@" > '${record}/tmux-args'
while [ "$1" != new-session ]; do shift; done; shift
while [ $# -gt 0 ]; do
  case "$1" in
    -A) shift ;;
    -s | -x | -y) shift 2 ;;
    *) break ;;
  esac
done
export TERM_PROGRAM=tmux TERM_PROGRAM_VERSION=3.4
unset COLORTERM
exec "$@"
`,
  { mode: 0o755 },
);
fs.writeFileSync(
  path.join(stubs, 'claude'),
  `#!/bin/sh
printf '%s\\0' "$@" > '${record}/args'
cat > '${record}/stdin'
pwd > '${record}/pwd'
printf '%s\\n' "$BIFROST_TASK_ID" "$BIFROST_SESSION_NAME" "$PATH" > '${record}/env'
printf '%s\\n' "$TERM_PROGRAM" "$COLORTERM" > '${record}/term'
printf '%s' "$CLAUDE_CONFIG_DIR" > '${record}/config-dir'
`,
  { mode: 0o755 },
);

const home = path.join(root, 'home');
const mainRepo = path.join(root, "re'po");
const worktree = path.join(root, "work tree's");
fs.mkdirSync(home);
fs.mkdirSync(mainRepo);
execFileSync('sh', ['-c', 'git init -q && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init'], {
  cwd: mainRepo,
});
execFileSync('git', ['-C', mainRepo, 'worktree', 'add', '-q', '-b', 'session', worktree]);
fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ projects: {} }));

const taskId = '6f9c1a52-0000-4000-8000-000000000001';
const sessionId = '0b8e2f34-0000-4000-8000-000000000002';
const awkwardName = `it's "quoted" $HOME \`date\` \\ back`;
// A slip in the quoting runs the substitution, which leaves this marker behind.
const injected = path.join(home, 'injected');
const awkwardPrompt = `Fix the build.\nIt's "broken" since $(touch "$HOME/injected") and \`id\`.\n\\n is not a newline.\nEOF\n  trailing spaces  \nünïcödé`;

/** Sets the first session up, with Bifrost running under configDir, or without one. */
function setUpFirst(configDir: string | undefined, prompt?: string): void {
  if (configDir) process.env.CLAUDE_CONFIG_DIR = configDir;
  else delete process.env.CLAUDE_CONFIG_DIR;
  const script = sessionSetupScript({
    home,
    taskId,
    worktreePath: worktree,
    sessionId,
    args: ['--name', awkwardName, '--no-chrome'],
    env: { BIFROST_TASK_ID: taskId, BIFROST_SESSION_NAME: awkwardName },
    prompt,
  });
  delete process.env.CLAUDE_CONFIG_DIR;
  runRemote(home, script);
}
setUpFirst(undefined, awkwardPrompt);

// ssh hands the command to the login shell, in the home directory.
const attach = (configDir?: string) => {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, PATH: `${stubs}:${process.env.PATH}` };
  if (configDir) env.CLAUDE_CONFIG_DIR = configDir;
  else delete env.CLAUDE_CONFIG_DIR;
  const { args } = new RemoteHost({ name: 'machine', host: 'machine' }).controlCommand(taskId, 80, 24);
  return execFileSync(process.env.SHELL ?? '/bin/sh', ['-c', args[args.length - 1]], {
    cwd: home,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
};
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
      env.startsWith(`${taskId}\n${awkwardName}\n${home}/.local/bin:`),
    show({ args, stdin, env }),
  );
  check(
    "setting a session up trusts its worktree's main repository, so Claude starts without asking",
    JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf-8')).projects[mainRepo]?.hasTrustDialogAccepted ===
      true,
  );
  check(
    'Claude in the tmux pane is told its terminal shows links and 24-bit colour',
    fs.readFileSync(path.join(record, 'term'), 'utf-8') === 'ghostty\ntruecolor\n',
    show(fs.readFileSync(path.join(record, 'term'), 'utf-8')),
  );
  check(
    'the attach asks tmux for the task-named session, creating it only when missing',
    argsOf('tmux-args').includes('-A') && argsOf('tmux-args').includes(taskId),
    show(argsOf('tmux-args')),
  );
  const startedName = path.join(home, '.bifrost', 'sessions', taskId, 'started-name');
  check(
    'run.sh records the name the session started under',
    fs.existsSync(startedName) && fs.readFileSync(startedName, 'utf-8') === `${awkwardName}\n`,
    show(fs.existsSync(startedName) && fs.readFileSync(startedName, 'utf-8')),
  );
}

fs.rmSync(path.join(record, 'stdin'));
attach();
check(
  'a later start with no transcript yet does not send the prompt again',
  fs.readFileSync(path.join(record, 'stdin'), 'utf-8') === '',
  show(fs.readFileSync(path.join(record, 'stdin'), 'utf-8')),
);

{
  // Set up again while Bifrost runs with a config dir, so run.sh exports its counterpart here.
  const configDir = path.join(home, '.claude-alt');
  fs.mkdirSync(path.join(configDir, 'projects', 'elsewhere'), { recursive: true });
  fs.writeFileSync(path.join(configDir, 'projects', 'elsewhere', `${sessionId}.jsonl`), '{}\n');
  setUpFirst(path.join(os.homedir(), '.claude-alt'));
  attach();
  check(
    'a transcript under the config dir Bifrost runs with is resumed',
    argsOf('args').join(' ').includes(`--resume ${sessionId}`),
    show(argsOf('args')),
  );
  fs.rmSync(configDir, { recursive: true });
  setUpFirst(undefined);
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

/** Runs a session's run.sh the way tmux does, with the stub claude on PATH. */
const runSession = (id: string, env: NodeJS.ProcessEnv) =>
  execFileSync('sh', [path.join(home, '.bifrost', 'sessions', id, 'run.sh')], {
    cwd: home,
    env: { ...process.env, HOME: home, PATH: `${stubs}:${process.env.PATH}`, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
const configDirUsed = () => fs.readFileSync(path.join(record, 'config-dir'), 'utf-8');

{
  const id = '6f9c1a52-0000-4000-8000-0000000000c1';
  const workJson = path.join(home, '.claude-work', '.claude.json');
  fs.mkdirSync(path.dirname(workJson), { recursive: true });
  fs.writeFileSync(workJson, JSON.stringify({ projects: {} }));
  process.env.CLAUDE_CONFIG_DIR = path.join(os.homedir(), '.claude-work');
  const script = sessionSetupScript({ home, taskId: id, worktreePath: worktree, sessionId, args: [], env: {} });
  delete process.env.CLAUDE_CONFIG_DIR;
  runRemote(home, script);
  runSession(id, {});
  const used = configDirUsed();
  const trusted = JSON.parse(fs.readFileSync(workJson, 'utf-8')).projects[fs.realpathSync(mainRepo)]
    ?.hasTrustDialogAccepted;
  check(
    "a session runs with the config dir Bifrost runs with, and is trusted in that dir's config",
    used === path.join(home, '.claude-work') && trusted === true,
    show({ used, trusted }),
  );
}

{
  const id = '6f9c1a52-0000-4000-8000-0000000000c2';
  runRemote(home, sessionSetupScript({ home, taskId: id, worktreePath: worktree, sessionId, args: [], env: {} }));
  runSession(id, { CLAUDE_CONFIG_DIR: '/stale' });
  check(
    'without one, a session runs with it unset, whatever its environment held',
    configDirUsed() === '',
    configDirUsed(),
  );
}

{
  const home5 = path.join(root, 'home5');
  const workJson = path.join(home5, '.claude-work', '.claude.json');
  fs.mkdirSync(path.dirname(workJson), { recursive: true });
  fs.writeFileSync(workJson, JSON.stringify({}));
  process.env.CLAUDE_CONFIG_DIR = path.join(os.homedir(), '.claude-work');
  const script = prepareScript({ apiPort: 43671 });
  delete process.env.CLAUDE_CONFIG_DIR;
  runRemote(home5, script);
  check(
    'connecting marks onboarding done in the config dir Bifrost runs with',
    JSON.parse(fs.readFileSync(workJson, 'utf-8')).hasCompletedOnboarding === true,
    fs.readFileSync(workJson, 'utf-8'),
  );
}

{
  process.env.CLAUDE_CONFIG_DIR = path.join(os.homedir(), '.claude-work');
  const script = loginScript();
  delete process.env.CLAUDE_CONFIG_DIR;
  runRemote(home, script);
  runSession('login', { CLAUDE_CONFIG_DIR: '/stale' });
  check(
    "logging in on a machine runs Claude's login under the config dir sessions there use",
    argsOf('args').join(' ') === 'auth login --claudeai' && configDirUsed() === path.join(home, '.claude-work'),
    show({ args: argsOf('args'), dir: configDirUsed() }),
  );
}

{
  delete process.env.CLAUDE_CONFIG_DIR;
  const heard: unknown[][] = [];
  const stop = subscribe((channel, args) => {
    if (channel === IPC_STREAM.MACHINE_LOGIN_NEEDED) heard.push(args);
  });
  const box = new RemoteHost({ name: 'box', host: 'box' });
  // The connection is made, and Claude there has no login.
  (box as unknown as { info: object }).info = { home, missing: [], loggedIn: false, pluginDir: null, apiPort: 1 };
  const refused = await box.connectReady().then(
    () => '',
    (err: Error) => err.message,
  );
  stop();
  check(
    'a machine whose Claude has no login says so, naming the config dir its sessions use',
    refused.includes('not logged in') && show(heard) === show([['box', '~/.claude']]),
    show({ refused, heard }),
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
    'preparing a machine points its hooks at the forwarded port, completes onboarding keeping what is set, and says it has rsync',
    fs.readFileSync(path.join(home3, '.bifrost', 'api-port'), 'utf-8').trim() === '43669' &&
      config.hasCompletedOnboarding === true &&
      typeof config.lastOnboardingVersion === 'string' &&
      config.theme === 'light' &&
      config.numStartups === 3 &&
      config.projects['/elsewhere'].lastCost === 1 &&
      prepared.HOME === home3 &&
      prepared.RSYNC === 'yes',
    show({ prepared, config }),
  );
}

{
  const home4 = path.join(root, 'home4');
  fs.mkdirSync(home4);
  runRemote(home4, prepareScript({ apiPort: 43670, instance: true }));
  const ide = path.join(home4, '.bifrost', 'ide-port');
  check(
    "preparing a machine that runs its own instance leaves api-port to it, and says where the IDE's API is",
    fs.existsSync(ide) &&
      fs.readFileSync(ide, 'utf-8').trim() === '43670' &&
      !fs.existsSync(path.join(home4, '.bifrost', 'api-port')),
  );
}

let hasTmux = true;
try {
  execFileSync('tmux', ['-V'], { stdio: 'ignore' });
} catch {
  hasTmux = false;
  console.log('skip — no tmux here to load the prepared configuration into');
}
if (hasTmux) {
  const socket = path.join(root, 'tmux.sock');
  const conf = path.join(home3, '.bifrost', 'tmux.conf');
  const load = ['-S', socket, '-f', conf, 'start-server', ';', 'show-options', '-g', 'default-terminal'];
  const listed = execFileSync('tmux', load).toString();
  try {
    execFileSync('tmux', ['-S', socket, 'kill-server'], { stdio: 'ignore' });
  } catch {
    /* a server with no sessions has already exited */
  }
  check(
    'a pane tells its programs they write to an xterm',
    /^default-terminal "?xterm-256color"?$/m.test(listed),
    show(listed),
  );
}

check(
  'a clone sits at the path its repo has here, relative to home, and under ~/git for a repo outside it',
  remoteClonePath({ path: path.join(os.homedir(), 'git', 'acme', 'widget'), name: 'widget' }) === 'git/acme/widget' &&
    remoteClonePath({ path: '/opt/src/widget', githubPath: 'acme/widget', name: 'widget' }) === 'git/acme/widget',
);

{
  const home = path.join(root, 'paste-home');
  const pastes = path.join(home, '.bifrost', 'paste');
  fs.mkdirSync(pastes, { recursive: true });
  fs.writeFileSync(path.join(pastes, 'old.png'), 'old');
  fs.writeFileSync(path.join(pastes, 'recent.png'), 'recent');
  const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000);
  fs.utimesSync(path.join(pastes, 'old.png'), twoDaysAgo, twoDaysAgo);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x0a, 0x0d]);
  const printed = execFileSync('sh', ['-c', pasteScript('new.png')], {
    input: png,
    env: { ...process.env, HOME: home },
  })
    .toString()
    .trim();
  check(
    'a pasted image is stored byte for byte among the pastes, its path printed, and pastes over a day old are removed',
    printed === path.join(pastes, 'new.png') &&
      fs.readFileSync(printed).equals(png) &&
      !fs.existsSync(path.join(pastes, 'old.png')) &&
      fs.existsSync(path.join(pastes, 'recent.png')),
    show({ printed, left: fs.readdirSync(pastes) }),
  );
}

fs.rmSync(root, { recursive: true, force: true });
if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
