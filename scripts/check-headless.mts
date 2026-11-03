/**
 * A Bifrost instance runs under plain Node, with no window. This builds the
 * headless entry and runs it under a temporary home, tmp and tmux server, with
 * a stub `claude`. Run with `npm run check:headless`.
 */
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IPC, IPC_STREAM } from '../src/shared/ipc-channels.ts';
import type { BifrostConfig, Task } from '../src/shared/types.ts';

let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? 'ok' : 'FAIL'} — ${name}${ok || !detail ? '' : `\n  ${detail}`}`);
}
const show = (value: unknown) => JSON.stringify(value);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(condition: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (condition()) return true;
    await sleep(50);
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

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bifrost-headless-')));
const home = path.join(root, 'home');
const stubs = path.join(root, 'stubs');
const tmp = path.join(root, 'tmp');
for (const dir of [home, stubs, tmp]) fs.mkdirSync(dir);
fs.writeFileSync(path.join(stubs, 'claude'), '#!/bin/sh\nprintf "stub\\n"\nexec cat\n', { mode: 0o755 });
// The instance's tmp is its own, since starting the change feed empties a directory there.
const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, TMPDIR: tmp, TMUX_TMPDIR: root, BIFROST_MACHINE: 'perf' };
env.PATH = `${stubs}:${process.env.PATH}`;
delete env.CLAUDE_CONFIG_DIR;
delete env.TMUX;
const socket = path.join(root, `tmux-${process.getuid?.()}`, 'bifrost');

// One task in the instance's database before it starts. db.ts fixes its path as it loads.
const realHome = process.env.HOME;
process.env.HOME = home;
{
  const db = await import('../src/main/db.ts');
  const store = await import('../src/main/task-store.ts');
  db.openDatabase();
  const t1: Task = {
    id: 't1',
    name: 't1',
    repoId: 'r',
    baseBranch: 'main',
    worktreePath: tmp,
    status: 'stopped',
    hasUnread: false,
    createdAt: 1,
  };
  store.saveTasks([t1]);
  db.closeDatabase();
}
process.env.HOME = realHome;
let apiPort = '';
const post = (route: string, body: unknown, signal?: AbortSignal) =>
  fetch(`http://127.0.0.1:${apiPort}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
const consoleRuns = () => {
  try {
    execFileSync('tmux', ['-S', socket, 'has-session', '-t', '=console'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

let child: ChildProcess | undefined;
let output = '';
try {
  child = spawn('node', ['.vite/headless/headless.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout?.on('data', (d) => (output += d));
  child.stderr?.on('data', (d) => (output += d));
  const exited = new Promise<number | null>((resolve) => child?.on('exit', (code) => resolve(code)));

  {
    const portFile = path.join(home, '.bifrost', 'api-port');
    const up = await until(() => fs.existsSync(portFile), 15_000);
    let answer: { status: number; list?: { tasks: unknown[] } } = { status: 0 };
    if (up) {
      apiPort = fs.readFileSync(portFile, 'utf8').trim();
      const res = await post('/list-tasks', { status: 'all' });
      answer = { status: res.status, list: await res.json() };
    }
    check(
      'an instance comes up without Electron and serves its API',
      answer.status === 200 && answer.list?.tasks.length === 1,
      show({ up, answer, output: output.slice(-800) }),
    );
  }

  {
    const renamed = await post('/call', { channel: IPC.RENAME_TASK, args: ['t1', 'renamed'] });
    const result = renamed.status === 200 ? ((await renamed.json()) as { result: Task }).result : undefined;
    const unknown = await post('/call', { channel: 'no-such-channel', args: [] });
    check(
      'an instance answers a call for one of its tasks',
      result?.name === 'renamed' && unknown.status === 404,
      show({ status: renamed.status, result, unknown: unknown.status }),
    );
  }

  {
    const repo = path.join(root, 'repo');
    fs.mkdirSync(repo);
    execFileSync('git', ['init', '-q', repo]);
    const abort = new AbortController();
    const seen: string[] = [];
    const events = await post('/events', {}, AbortSignal.any([abort.signal, AbortSignal.timeout(15_000)])).catch(
      () => undefined,
    );
    const reading = (async () => {
      const reader = events?.body?.getReader();
      const decoder = new TextDecoder();
      let rest = '';
      while (reader) {
        const { done, value } = await reader.read();
        if (done) return;
        rest += decoder.decode(value, { stream: true });
        const lines = rest.split('\n');
        rest = lines.pop() ?? '';
        for (const line of lines) if (line) seen.push((JSON.parse(line) as { channel: string }).channel);
      }
    })().catch(() => {});
    await post('/call', { channel: IPC.ADD_REPO, args: [{ type: 'local', path: repo }] });
    const arrived = await until(() => seen.includes(IPC_STREAM.REPOS_CHANGED), 5_000);
    abort.abort();
    await reading;
    const still = (await post('/list-tasks', {})).status;
    check(
      'an instance streams its events to whoever subscribes',
      arrived && still === 200,
      show({ status: events?.status, seen, still }),
    );
  }

  {
    await post('/preferences', { permissionMode: 'auto-mode', managePermissions: true });
    const loaded = await post('/call', { channel: IPC.LOAD_CONFIG, args: [] });
    const config = loaded.status === 200 ? ((await loaded.json()) as { result: BifrostConfig }).result : undefined;
    check(
      'an instance takes the preferences it is sent',
      config?.permissionMode === 'auto-mode' && config.managePermissions === true,
      show({ status: loaded.status, permissionMode: config?.permissionMode }),
    );
  }

  {
    const asked = await post(
      '/permission',
      { bifrost_task_id: 't1', cwd: tmp, tool_name: 'Bash', tool_input: {} },
      AbortSignal.timeout(3_000),
    ).catch(() => undefined);
    const answer = asked?.status === 200 ? await asked.json() : undefined;
    check(
      'with nobody listening, an approval falls back to Claude at once',
      show(answer) === '{}',
      show({ status: asked?.status, answer }),
    );
  }

  {
    execFileSync('tmux', ['-S', socket, 'new-session', '-d', '-s', 't2', 'sleep 60']);
    const t2: Task = {
      id: 't2',
      name: 't2',
      repoId: 'r',
      baseBranch: 'main',
      worktreePath: tmp,
      status: 'running',
      hasUnread: false,
      createdAt: 2,
      machine: 'perf',
    };
    const handed = { tasks: [t2], repos: [{ id: 'r', name: 'r', path: tmp, defaultBranch: 'main' }] };
    const first = await post('/import-tasks', handed);
    const ids = first.status === 200 ? ((await first.json()) as { ids: string[] }).ids : undefined;
    // A repeated handover, carrying what the IDE held, does not replace what the instance knows by now.
    await post('/import-tasks', { ...handed, tasks: [{ ...t2, name: 'stale' }] });
    const listed = (await (await post('/list-tasks', { status: 'all' })).json()) as {
      tasks: Array<{ id: string; name: string; machine?: string }>;
    };
    const rows = listed.tasks.filter((t) => t.id === 't2');
    const woken = (await (await post('/wake-task', { taskId: 't2' })).json()) as { alreadyAwake?: boolean };
    check(
      'an instance takes over a task, once, keeping what it knows, and joins its running session',
      show(ids) === '["t2"]' &&
        rows.length === 1 &&
        rows[0].name === 't2' &&
        rows[0].machine === 'perf' &&
        woken.alreadyAwake === true,
      show({ status: first.status, ids, rows, woken }),
    );
  }

  {
    const ran = await until(consoleRuns, 10_000);
    // A subscriber still holding its stream must not keep the instance from stopping.
    const subscriber = await post('/events', {}, AbortSignal.timeout(30_000)).catch(() => undefined);
    child.kill('SIGTERM');
    const code = await Promise.race([exited, sleep(10_000).then(() => 'timeout')]);
    check(
      'stopping an instance, even with a subscriber, leaves its sessions running',
      ran && subscriber?.status === 200 && code === 0 && consoleRuns(),
      show({ ran, subscriber: subscriber?.status, code, still: consoleRuns(), output: output.slice(-800) }),
    );
  }
} finally {
  if (child && child.exitCode === null) child.kill('SIGKILL');
  try {
    execFileSync('tmux', ['-S', socket, 'kill-server'], { stdio: 'ignore' });
  } catch {
    /* a server with no sessions has already exited */
  }
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
