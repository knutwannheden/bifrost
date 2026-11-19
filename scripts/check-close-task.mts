/**
 * A task that closes or archives itself hears the answer, though its own
 * session is what the call stops. Runs a headless instance under a temporary
 * home with a stub Claude that makes the call for its task, as the plugin's
 * tool does. Run with `npm run check:close-task`.
 */
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IPC } from '../src/shared/ipc-channels.ts';
import type { Task } from '../src/shared/types.ts';

let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? 'ok' : 'FAIL'} — ${name}${ok || !detail ? '' : `\n  ${detail}`}`);
}
const show = (value: unknown) => JSON.stringify(value);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

try {
  execFileSync('tmux', ['-V'], { stdio: 'ignore' });
} catch {
  console.log('skipped — no tmux');
  process.exit(0);
}

execFileSync('npm', ['run', '-s', 'build:headless'], { stdio: 'pipe' });

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bifrost-close-')));
const home = path.join(root, 'home');
const stubs = path.join(root, 'stubs');
const asks = path.join(root, 'asks');
const tmp = path.join(root, 'tmp');
const repo = path.join(root, 'repo');
for (const dir of [path.join(home, '.bifrost'), stubs, asks, tmp, repo]) fs.mkdirSync(dir, { recursive: true });
// Waits for the check to hand it a request, posts that for its own task, keeps the answer, and stays until stopped.
fs.writeFileSync(
  path.join(stubs, 'claude'),
  `#!/bin/sh
ask='${asks}'/"$BIFROST_TASK_ID"
until [ -n "$BIFROST_TASK_ID" ] && [ -f "$ask" ]; do sleep 0.1; done
curl -s -X POST -H 'content-type: application/json' --data @"$ask" \\
  "http://127.0.0.1:$(cat '${asks}/port')/close-task" > "$ask.reply"
exec sleep 3600
`,
  { mode: 0o755 },
);
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' }).toString().trim();
git('init', '-q', '-b', 'main');
git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'init');

const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, TMPDIR: tmp, TMUX_TMPDIR: root };
env.PATH = `${stubs}:${process.env.PATH}`;
delete env.CLAUDE_CONFIG_DIR;
delete env.TMUX;
const socket = path.join(root, `tmux-${process.getuid?.()}`, 'bifrost');
const portFile = path.join(home, '.bifrost', 'api-port');

let instance: ChildProcess | undefined;
let port = '';
const post = async (route: string, body: unknown) =>
  (await fetch(`http://127.0.0.1:${port}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => r.json())) as Record<string, unknown>;
const call = async (channel: string, ...args: unknown[]) => (await post('/call', { channel, args })).result;
const statusOf = async (id: string) => ((await call(IPC.LIST_TASKS)) as Task[]).find((t) => t.id === id)?.status;
const sessionRuns = (id: string) => {
  try {
    execFileSync('tmux', ['-S', socket, 'has-session', '-t', `=${id}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

async function newTask(name: string): Promise<Task> {
  const task = (await post('/create-task', { repoPath: repo, name, prompt: 'go' })) as Task;
  for (const end = Date.now() + 10_000; !sessionRuns(task.id) && Date.now() < end; ) await sleep(50);
  return task;
}

/** What the task's session hears when it makes this call for itself, or null when it hears nothing. */
async function askedBySession(task: Task, body: object): Promise<Record<string, unknown> | null> {
  const ask = path.join(asks, task.id);
  fs.writeFileSync(`${ask}.tmp`, JSON.stringify({ taskId: task.id, ...body }));
  fs.renameSync(`${ask}.tmp`, ask);
  const reply = () => (fs.existsSync(`${ask}.reply`) ? fs.readFileSync(`${ask}.reply`, 'utf8') : '');
  for (const end = Date.now() + 10_000; !reply() && sessionRuns(task.id) && Date.now() < end; ) await sleep(50);
  return reply() ? JSON.parse(reply()) : null;
}

try {
  instance = spawn('node', ['.vite/headless/headless.js'], { env, stdio: 'ignore' });
  for (const end = Date.now() + 15_000; !fs.existsSync(portFile) && Date.now() < end; ) await sleep(50);
  port = fs.readFileSync(portFile, 'utf8').trim();
  fs.writeFileSync(path.join(asks, 'port'), port);

  {
    const task = await newTask('archives itself');
    const heard = await askedBySession(task, { archive: true });
    await sleep(3000);
    const after = { session: sessionRuns(task.id), status: await statusOf(task.id) };
    check(
      'a task that archives itself hears that it was archived, and then its session ends',
      heard?.name === 'archives itself' && heard.status === 'archived' && !after.session && after.status === 'archived',
      show({ heard, after }),
    );
  }

  {
    const task = await newTask('archives itself with changes');
    fs.writeFileSync(path.join(task.worktreePath, 'unsaved.txt'), 'not committed\n');
    const heard = await askedBySession(task, { archive: true });
    await sleep(3000);
    const after = { session: sessionRuns(task.id), status: await statusOf(task.id) };
    check(
      'a task that archives itself with uncommitted changes hears the refusal, and its session runs on',
      String(heard?.error).includes('uncommitted changes') && after.session && after.status === 'running',
      show({ heard, after }),
    );
  }
} finally {
  if (instance && instance.exitCode === null) instance.kill('SIGKILL');
  try {
    execFileSync('tmux', ['-S', socket, 'kill-server'], { stdio: 'ignore' });
  } catch {
    /* a server with no sessions has already exited */
  }
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
