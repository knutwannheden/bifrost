/**
 * The instance on a machine reaches the IDE's: it lists the IDE's tasks while
 * linked, and sends it the tasks to create elsewhere. A plays the IDE and B
 * the machine, each headless under its own home. Run with `npm run check:instance-reach`.
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
async function until(condition: () => Promise<boolean>, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await condition()) return true;
    await sleep(100);
  }
  return condition();
}

try {
  execFileSync('tmux', ['-V'], { stdio: 'ignore' });
} catch {
  console.log('skipped — no tmux');
  process.exit(0);
}

execFileSync('npm', ['run', '-s', 'build:headless'], { stdio: 'pipe' });

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bifrost-reach-')));
const stubs = path.join(root, 'stubs');
fs.mkdirSync(stubs);
fs.writeFileSync(path.join(stubs, 'claude'), '#!/bin/sh\nprintf "stub\\n"\nexec cat\n', { mode: 0o755 });

const side = (name: string) => {
  const dir = path.join(root, name);
  const s = { home: path.join(dir, 'home'), tmp: path.join(dir, 'tmp'), tmux: dir };
  for (const d of [path.join(s.home, '.bifrost'), s.tmp]) fs.mkdirSync(d, { recursive: true });
  return s;
};
const a = side('a');
const b = side('b');

// A, as the IDE, holds a task here and one it runs on another machine.
process.env.HOME = a.home;
{
  const db = await import('../src/main/db.ts');
  const store = await import('../src/main/task-store.ts');
  db.openDatabase();
  const task = (id: string, extra: Partial<Task> = {}): Task => ({
    id,
    name: id,
    repoId: 'r',
    baseBranch: 'main',
    worktreePath: a.tmp,
    status: 'stopped',
    hasUnread: false,
    createdAt: 1,
    ...extra,
  });
  store.saveTasks([task('ta'), task('tr', { machine: 'recipes' })]);
  db.closeDatabase();
}

const processes: ChildProcess[] = [];
async function start(s: ReturnType<typeof side>, machine?: string): Promise<{ port: string; proc: ChildProcess }> {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: s.home, TMPDIR: s.tmp, TMUX_TMPDIR: s.tmux };
  env.PATH = `${stubs}:${process.env.PATH}`;
  for (const key of ['CLAUDE_CONFIG_DIR', 'TMUX', 'BIFROST_MACHINE', 'BIFROST_PLUGIN_DIR']) delete env[key];
  if (machine) env.BIFROST_MACHINE = machine;
  const proc = spawn('node', ['.vite/headless/headless.js'], { env, stdio: 'ignore' });
  processes.push(proc);
  const portFile = path.join(s.home, '.bifrost', 'api-port');
  if (!(await until(async () => fs.existsSync(portFile), 15_000))) throw new Error(`${s.home} did not come up`);
  return { port: fs.readFileSync(portFile, 'utf8').trim(), proc };
}
const post = (port: string, route: string, body: unknown) =>
  fetch(`http://127.0.0.1:${port}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
const listed = async (port: string): Promise<Task[]> =>
  ((await (await post(port, '/list-tasks', { status: 'all' })).json()) as { tasks: Task[] }).tasks;

try {
  const ide = await start(a);
  const perf = await start(b, 'perf');

  {
    // The IDE links to the machine's instance as it always does, and the machine links back.
    await post(ide.port, '/link-back', { name: 'perf', port: Number(perf.port) });
    const linked = await post(perf.port, '/link-back', { name: 'ide', port: Number(ide.port) });
    await until(async () => (await listed(perf.port)).some((t) => t.id === 'ta'), 5_000);
    await post(ide.port, '/call', { channel: IPC.RENAME_TASK, args: ['ta', 'renamed'] });
    await until(async () => (await listed(perf.port)).some((t) => t.name === 'renamed'), 5_000);
    const there = await listed(perf.port);
    const here = await listed(ide.port);
    const machineOf = (id: string) => there.find((t) => t.id === id)?.machine;
    check(
      "an instance linked back to the IDE lists the IDE's tasks with their machine, and none comes back to the IDE",
      linked.ok &&
        machineOf('ta') === 'ide' &&
        machineOf('tr') === 'recipes' &&
        here.filter((t) => t.id === 'ta').length === 1,
      show({ status: linked.status, there: there.map((t) => [t.id, t.machine]), here: here.map((t) => t.id) }),
    );
  }

  {
    ide.proc.kill('SIGTERM');
    const left = await until(async () => !(await listed(perf.port)).some((t) => t.id === 'ta'), 5_000);
    check('with the IDE away, an instance lists its own tasks', left, show(await listed(perf.port)));
  }
} finally {
  for (const proc of processes) if (proc.exitCode === null) proc.kill('SIGKILL');
  for (const s of [a, b]) {
    try {
      execFileSync('tmux', ['-S', path.join(s.tmux, `tmux-${process.getuid?.()}`, 'bifrost'), 'kill-server'], {
        stdio: 'ignore',
      });
    } catch {
      /* a server with no sessions has already exited */
    }
  }
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
