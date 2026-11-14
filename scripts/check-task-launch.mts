/**
 * A task created with an agent, model and effort starts that agent with them,
 * whatever agent its machine runs, and keeps the choice. Runs a headless
 * instance under a temporary home with stub agents that record how they were
 * started. Run with `npm run check:task-launch`.
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

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bifrost-launch-')));
const home = path.join(root, 'home');
const stubs = path.join(root, 'stubs');
const record = path.join(root, 'record');
const tmp = path.join(root, 'tmp');
const repo = path.join(root, 'repo');
for (const dir of [path.join(home, '.bifrost'), stubs, record, tmp, repo]) fs.mkdirSync(dir, { recursive: true });
for (const agent of ['claude', 'codex']) {
  // Each start is a line of NUL-separated arguments, since the instance's console starts Claude too.
  fs.writeFileSync(
    path.join(stubs, agent),
    `#!/bin/sh\nprintf '%s\\0' "$@" >> '${record}/${agent}'\necho >> '${record}/${agent}'\nexec cat\n`,
    { mode: 0o755 },
  );
}
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
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
async function start(): Promise<void> {
  fs.rmSync(portFile, { force: true });
  instance = spawn('node', ['.vite/headless/headless.js'], { env, stdio: 'ignore' });
  for (const end = Date.now() + 15_000; !fs.existsSync(portFile) && Date.now() < end; ) await sleep(50);
  port = fs.readFileSync(portFile, 'utf8').trim();
}
async function stop(): Promise<void> {
  const exited = new Promise((resolve) => instance?.on('exit', resolve));
  instance?.kill('SIGTERM');
  await exited;
}
const post = async (route: string, body: unknown) =>
  (await fetch(`http://127.0.0.1:${port}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => r.json())) as Record<string, unknown>;
const starts = (agent: string): string[][] =>
  fs.existsSync(path.join(record, agent))
    ? fs
        .readFileSync(path.join(record, agent), 'utf-8')
        .split('\n')
        .filter(Boolean)
        .map((line) => line.split('\0').slice(0, -1))
    : [];

try {
  await start();
  const launch = { agent: 'codex', model: 'm1', effort: 'high' };
  const created = (await post('/create-task', { repoPath: repo, name: 'chosen', prompt: 'go', launch })) as Task;

  {
    for (const end = Date.now() + 10_000; starts('codex').length === 0 && Date.now() < end; ) await sleep(50);
    const codex = starts('codex')[0] ?? [];
    const claude = starts('claude').filter((args) => args.includes('chosen'));
    const flags = ['-m', 'm1', '-c', 'model_reasoning_effort="high"'];
    check(
      "a task created with an agent, model and effort starts that agent with them, not the machine's",
      flags.every((f) => codex.includes(f)) && codex.indexOf('m1') === codex.indexOf('-m') + 1 && claude.length === 0,
      show({ codex, claude }),
    );
  }

  {
    await stop();
    await start();
    const tasks = (await post('/call', { channel: IPC.LIST_TASKS, args: [] })).result as Task[];
    const kept = tasks.find((t) => t.id === created.id)?.launch;
    check('the task keeps what it was created to run with across a restart', show(kept) === show(launch), show(kept));
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
