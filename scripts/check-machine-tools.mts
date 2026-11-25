/**
 * The API adds, lists and removes machines for the MCP tools, and tells the
 * window. Runs a headless instance under a temporary home. Run with
 * `npm run check:machine-tools`.
 */
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IPC_STREAM } from '../src/shared/ipc-channels.ts';
import type { Machine, Task } from '../src/shared/types.ts';

let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? 'ok' : 'FAIL'} — ${name}${ok || !detail ? '' : `\n  ${detail}`}`);
}
const show = (value: unknown) => JSON.stringify(value);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(condition: () => boolean, ms: number): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) if (condition()) return true;
  return condition();
}

execFileSync('npm', ['run', '-s', 'build:headless'], { stdio: 'pipe' });

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bifrost-machines-')));
const home = path.join(root, 'home');
const tmp = path.join(root, 'tmp');
for (const dir of [home, tmp]) fs.mkdirSync(dir);
const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, TMPDIR: tmp, TMUX_TMPDIR: root };
delete env.BIFROST_MACHINE;
delete env.CLAUDE_CONFIG_DIR;
delete env.TMUX;

// A stopped task on "busy", which keeps that machine from being removed.
const realHome = process.env.HOME;
process.env.HOME = home;
{
  const db = await import('../src/main/db.ts');
  const store = await import('../src/main/task-store.ts');
  db.openDatabase();
  const busy: Task = {
    id: 'b1',
    name: 'held there',
    repoId: 'r',
    machine: 'busy',
    baseBranch: 'main',
    worktreePath: '/elsewhere',
    status: 'stopped',
    hasUnread: false,
    createdAt: 1,
  };
  const chat: Task = {
    ...busy,
    id: 'c1',
    name: 'chat there',
    status: 'running',
    isExternal: true,
    adopted: { socket: 'devpod', session: 'chat' },
  };
  store.saveTasks([busy, chat]);
  db.closeDatabase();
}
process.env.HOME = realHome;
fs.writeFileSync(
  path.join(home, '.bifrost', 'config.json'),
  JSON.stringify({ repos: [], machines: [{ name: 'busy', host: 'busy.example' }] }),
);

let port = '';
const post = async (route: string, body: unknown) => {
  const res = await fetch(`http://127.0.0.1:${port}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};
const machines = async () => (await post('/machines', {})).body.machines as Machine[];

let child: ChildProcess | undefined;
try {
  child = spawn('node', ['.vite/headless/headless.js'], { env, stdio: 'ignore' });
  const portFile = path.join(home, '.bifrost', 'api-port');
  await until(() => fs.existsSync(portFile), 15_000);
  port = fs.readFileSync(portFile, 'utf8').trim();

  const abort = new AbortController();
  const seen: string[] = [];
  const events = await fetch(`http://127.0.0.1:${port}/events`, { method: 'POST', signal: abort.signal });
  const reading = (async () => {
    const reader = events.body?.getReader();
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

  {
    const added = await post('/add-machine', { host: 'crypto-js.coder' });
    const told = await until(() => seen.includes(IPC_STREAM.CONFIG_CHANGED), 5_000);
    const again = await post('/add-machine', { host: 'crypto-js.coder' });
    const taken = await post('/add-machine', { host: 'other.coder', name: 'crypto-js' });
    const listed = await machines();
    check(
      "a machine is added under its host's first label, once, and the window is told",
      added.status === 200 &&
        told &&
        again.status === 200 &&
        taken.status === 400 &&
        listed.filter((m) => m.host === 'crypto-js.coder').length === 1 &&
        listed.some((m) => m.name === 'crypto-js'),
      show({ added, told, again, taken, listed }),
    );
  }

  {
    const refused = await post('/remove-machine', { name: 'busy' });
    const removed = await post('/remove-machine', { name: 'crypto-js' });
    const listed = (await machines()).map((m) => m.name);
    check(
      'a machine with an open task stays, and one without goes',
      refused.status === 409 &&
        String(refused.body.error).includes('held there') &&
        removed.status === 200 &&
        listed.join() === 'busy',
      show({ refused, removed, listed }),
    );
  }
  {
    const again = await post('/adopt-session', { machine: 'busy', socket: 'devpod', session: 'chat' });
    await sleep(500);
    check(
      'adopting a session a task already shows answers that task, and tells the window of no new one',
      again.body.id === 'c1' && !seen.includes(IPC_STREAM.TASK_CREATED),
      show({ again, seen }),
    );
  }
  abort.abort();
  await reading;
} finally {
  if (child && child.exitCode === null) child.kill('SIGKILL');
  try {
    execFileSync('tmux', ['-S', path.join(root, `tmux-${process.getuid?.()}`, 'bifrost'), 'kill-server'], {
      stdio: 'ignore',
    });
  } catch {
    /* no server was started */
  }
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
